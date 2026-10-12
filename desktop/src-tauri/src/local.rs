//! Оболочка на этой же машине — как обычная сессия.
//!
//! ⛔ Зачем. Однострочники копились в блокноте и в истории терминала:
//! в такой куче не разобраться, а через день уже не вспомнить, что для
//! чего. В клиенте для этого всё есть — подсказки, история, вкладки, —
//! но только для машин по сети. Локальная сессия встаёт в тот же список
//! сессий, и всё перечисленное начинает работать с ней даром.
//!
//! ⛔ Почему не «ssh к самому себе». Это означало бы поднять на рабочей
//! машине службу входа по сети, открыть порт и завести ключи — ради
//! разговора с оболочкой, запущенной в метре. Лишняя служба, лишний
//! порт и лишние вопросы там, где прав у человека и так нет.
//!
//! ⛔ Почему псевдотерминал, а не просто «запустить и читать вывод».
//! Без него оболочка видит, что терминала нет, и ведёт себя иначе: ни
//! приглашения, ни цветов, ни дополнения по Tab, ни переноса строк по
//! ширине окна. Для человека это выглядит как сломанный терминал.

use std::io::{Read, Write};
use std::sync::Arc;

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};

use crate::ssh::{OutputGate, SessionCommand, SessionManager};

/// Кадр в канале между обычным и повышенным процессом.
///
/// ⛔ Повысить права у работающего процесса нельзя — Windows умеет
/// только запустить НОВЫЙ с запросом прав. А псевдотерминал принадлежит
/// тому, кто его создал. Поэтому оболочку под администратором поднимает
/// отдельный, повышенный экземпляр нас самих, а окно разговаривает с
/// ним через именованный канал: сюда — нажатия, обратно — вывод.
#[cfg(windows)]
pub(crate) mod frame {
    pub const DATA: u8 = 0;
    pub const RESIZE: u8 = 1;

    pub fn pack(kind: u8, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(5 + body.len());
        out.push(kind);
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
        out
    }
}

/// Что запускать, если человек не выбрал.
///
/// ⛔ Порядок важен: сперва PowerShell 7, он ставится отдельно и его
/// выбирают осознанно; затем встроенный, который есть везде.
#[cfg(windows)]
const SHELLS: &[&str] = &["pwsh.exe", "powershell.exe", "cmd.exe"];
#[cfg(not(windows))]
const SHELLS: &[&str] = &["/bin/zsh", "/bin/bash", "/bin/sh"];

fn pick_shell(asked: Option<&str>) -> Result<String, String> {
    if let Some(s) = asked.filter(|s| !s.trim().is_empty()) {
        return Ok(s.to_string());
    }
    for candidate in SHELLS {
        // На Windows ищем по PATH, на остальных — по полному пути.
        #[cfg(windows)]
        let found = which(candidate);
        #[cfg(not(windows))]
        let found = std::path::Path::new(candidate).exists();
        if found {
            return Ok((*candidate).to_string());
        }
    }
    Err("не найдено ни одной оболочки".into())
}

#[cfg(windows)]
fn which(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|dir| dir.join(name).is_file())
        })
        .unwrap_or(false)
}

/// Какие оболочки есть на этой машине — чтобы окно показало выбор.
#[tauri::command]
pub fn local_shells() -> Vec<String> {
    SHELLS
        .iter()
        .filter(|c| {
            #[cfg(windows)]
            { which(c) }
            #[cfg(not(windows))]
            { std::path::Path::new(c).exists() }
        })
        .map(|s| s.to_string())
        .collect()
}

#[tauri::command]
pub async fn local_connect(
    app: AppHandle,
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    elevated: Option<bool>,
) -> Result<String, String> {
    let shell = pick_shell(shell.as_deref())?;

    #[cfg(windows)]
    if elevated.unwrap_or(false) {
        return elevated_connect(app, state, session_id, shell, cols, rows).await;
    }
    #[cfg(not(windows))]
    if elevated.unwrap_or(false) {
        return Err("запуск с правами администратора есть только в Windows".into());
    }

    let pty = NativePtySystem::default()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("не открыть терминал: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    if let Some(home) = dirs_home() {
        cmd.cwd(home);
    }
    // ⛔ Говорим оболочке, какой это терминал: иначе цвета и перемещение
    // курсора приходят не теми последовательностями, и вывод рассыпается.
    cmd.env("TERM", "xterm-256color");

    let mut child = pty
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("не запустить {shell}: {e}"))?;
    // Сторона оболочки нам больше не нужна: держа её открытой, мы не
    // заметили бы её завершения — чтение никогда не вернуло бы ноль.
    drop(pty.slave);

    let mut reader = pty
        .master
        .try_clone_reader()
        .map_err(|e| format!("не читать вывод: {e}"))?;
    let mut writer = pty
        .master
        .take_writer()
        .map_err(|e| format!("не писать в оболочку: {e}"))?;

    let gate = Arc::new(Mutex::new(OutputGate::Buffering(Vec::new())));
    let (tx, mut rx) = mpsc::unbounded_channel::<SessionCommand>();
    state.register(session_id.clone(), tx, gate.clone()).await;

    // ── вывод оболочки → в окно ──
    {
        let app = app.clone();
        let sid = session_id.clone();
        let gate = gate.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let bytes = buf[..n].to_vec();
                        let app = app.clone();
                        let sid = sid.clone();
                        let gate = gate.clone();
                        // ⛔ Через ту же задвижку, что и у сетевых сессий:
                        // пока окно не сказало «готово», вывод копится, а
                        // не теряется. Первые строки приглашения приходят
                        // раньше, чем окно успевает подписаться.
                        tauri::async_runtime::spawn(async move {
                            let mut g = gate.lock().await;
                            match &mut *g {
                                OutputGate::Buffering(v) => v.push(bytes),
                                OutputGate::Ready => {
                                    drop(g);
                                    let _ = app.emit(
                                        "ssh-data",
                                        serde_json::json!({
                                            "sessionId": sid,
                                            "data": bytes,
                                        }),
                                    );
                                }
                            }
                        });
                    }
                }
            }
            let _ = app.emit(
                "ssh-closed",
                serde_json::json!({ "sessionId": sid, "reason": "оболочка завершилась" }),
            );
        });
    }

    // ── команды из окна → оболочке ──
    {
        let master = pty.master;
        let sid = session_id.clone();
        let manager = state.inner().clone();
        tauri::async_runtime::spawn(async move {
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    SessionCommand::Data(bytes) => {
                        if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                            break;
                        }
                    }
                    SessionCommand::Resize { cols, rows } => {
                        let _ = master.resize(PtySize {
                            rows,
                            cols,
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                    SessionCommand::Disconnect => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            manager.forget(&sid).await;
        });
    }

    Ok(shell)
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

// ──────────────── оболочка с правами администратора ────────────────

/// Поднять оболочку в повышенном экземпляре и связать его с окном.
///
/// ⛔ Запрос прав будет КАЖДЫЙ раз: Windows спрашивает при запуске
/// нового процесса, и обойти это нельзя — иначе любое приложение
/// получало бы администратора молча. Поэтому обычная оболочка и
/// оболочка под администратором — разные пункты, а не переключатель
/// внутри одной сессии.
#[cfg(windows)]
async fn elevated_connect(
    app: AppHandle,
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    shell: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_name = format!(r"\\.\pipe\nexussh-pty-{}", uuid_like());
    let server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)
        .map_err(|e| format!("не создать канал связи: {e}"))?;

    let me = std::env::current_exe().map_err(|e| format!("не найти себя: {e}"))?;
    // ⛔ Повышенный экземпляр запускаем БЕЗ окна консоли: иначе рядом с
    // нашей вкладкой мигает чёрное окно, и человек не понимает, какое
    // из двух настоящее.
    let launch = format!(
        "try {{ Start-Process -FilePath '{exe}' -Verb RunAs -WindowStyle Hidden \
           -ArgumentList '--pty-bridge','{pipe}','{shell}','{cols}','{rows}'; exit 0 }} \
         catch {{ exit 1223 }}",
        exe = me.display().to_string().replace('\'', "''"),
        pipe = pipe_name.replace('\'', "''"),
        shell = shell.replace('\'', "''"),
    );
    let out = tokio::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &launch])
        .creation_flags(0x0800_0000) // без мелькающего окна
        .output()
        .await
        .map_err(|e| format!("не запустить с правами администратора: {e}"))?;
    if !out.status.success() {
        return Err("права администратора не выданы".into());
    }

    // ⛔ Со сроком: если человек закрыл запрос прав, подключения не
    // будет никогда, и вкладка висела бы «подключается» до перезапуска.
    let server = tokio::time::timeout(std::time::Duration::from_secs(60), async move {
        server.connect().await.map(|_| server)
    })
    .await
    .map_err(|_| "повышенная оболочка не отозвалась — похоже, права не выданы".to_string())?
    .map_err(|e| format!("повышенная оболочка не подключилась: {e}"))?;

    let (mut reader, mut writer) = tokio::io::split(server);
    let gate = Arc::new(Mutex::new(OutputGate::Buffering(Vec::new())));
    let (tx, mut rx) = mpsc::unbounded_channel::<SessionCommand>();
    state.register(session_id.clone(), tx, gate.clone()).await;

    // вывод повышенной оболочки → в окно
    {
        let app = app.clone();
        let sid = session_id.clone();
        let gate = gate.clone();
        tauri::async_runtime::spawn(async move {
            let mut buf = vec![0u8; 8192];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let bytes = buf[..n].to_vec();
                        let mut g = gate.lock().await;
                        match &mut *g {
                            OutputGate::Buffering(v) => v.push(bytes),
                            OutputGate::Ready => {
                                drop(g);
                                let _ = app.emit(
                                    "ssh-data",
                                    serde_json::json!({ "sessionId": sid, "data": bytes }),
                                );
                            }
                        }
                    }
                }
            }
            let _ = app.emit(
                "ssh-closed",
                serde_json::json!({ "sessionId": sid, "reason": "оболочка завершилась" }),
            );
        });
    }

    // нажатия из окна → повышенной оболочке
    {
        let sid = session_id.clone();
        let manager = state.inner().clone();
        tauri::async_runtime::spawn(async move {
            while let Some(cmd) = rx.recv().await {
                let frame = match cmd {
                    SessionCommand::Data(bytes) => frame::pack(frame::DATA, &bytes),
                    SessionCommand::Resize { cols, rows } => {
                        let mut body = cols.to_le_bytes().to_vec();
                        body.extend_from_slice(&rows.to_le_bytes());
                        frame::pack(frame::RESIZE, &body)
                    }
                    SessionCommand::Disconnect => break,
                };
                if writer.write_all(&frame).await.is_err() {
                    break;
                }
            }
            manager.forget(&sid).await;
        });
    }

    Ok(format!("{shell} (администратор)"))
}

#[cfg(windows)]
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    format!("{}-{}", std::process::id(), t.subsec_nanos())
}

/// Повышенная половина: поднять оболочку и проксировать её в канал.
///
/// ⛔ Вызывается из `main` ДО запуска окна: этот экземпляр — не
/// приложение, а переходник. Поднимать здесь окно значило бы показать
/// человеку второе пустое окно программы с правами администратора.
#[cfg(windows)]
pub fn run_pty_bridge(args: &[String]) -> Result<(), String> {
    use std::io::{Read, Write};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::windows::named_pipe::ClientOptions;

    let pipe = args.first().ok_or("не задан канал связи")?;
    let shell = args.get(1).cloned().unwrap_or_else(|| "powershell.exe".into());
    let cols: u16 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(80);
    let rows: u16 = args.get(3).and_then(|v| v.parse().ok()).unwrap_or(24);

    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(async move {
        let client = ClientOptions::new()
            .open(pipe)
            .map_err(|e| format!("не подключиться к каналу: {e}"))?;

        let pty = NativePtySystem::default()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("не открыть терминал: {e}"))?;
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        if let Some(home) = dirs_home() {
            cmd.cwd(home);
        }
        let mut child = pty
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("не запустить {shell}: {e}"))?;
        drop(pty.slave);

        let mut pty_reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut pty_writer = pty.master.take_writer().map_err(|e| e.to_string())?;
        let (mut pipe_reader, mut pipe_writer) = tokio::io::split(client);

        // вывод оболочки → в канал
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = pty_reader.read(&mut buf) {
                if n == 0 || out_tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            while let Some(chunk) = out_rx.recv().await {
                if pipe_writer.write_all(&chunk).await.is_err() {
                    break;
                }
            }
        });

        // кадры из канала → оболочке
        let mut head = [0u8; 5];
        loop {
            if pipe_reader.read_exact(&mut head).await.is_err() {
                break;
            }
            let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]) as usize;
            let mut body = vec![0u8; len];
            if len > 0 && pipe_reader.read_exact(&mut body).await.is_err() {
                break;
            }
            match head[0] {
                frame::DATA => {
                    if pty_writer.write_all(&body).is_err() || pty_writer.flush().is_err() {
                        break;
                    }
                }
                frame::RESIZE if body.len() == 4 => {
                    let c = u16::from_le_bytes([body[0], body[1]]);
                    let r = u16::from_le_bytes([body[2], body[3]]);
                    let _ = pty.master.resize(PtySize {
                        rows: r,
                        cols: c,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                _ => {}
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        Ok::<(), String>(())
    })
}
