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
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::{mpsc, Mutex};

// ⛔ Событие собираем ТЕМ ЖЕ типом, что и сетевая часть, а не вручную.
// Собранное вручную разошлось с окном в имени поля — движок слал
// «sessionId», окно слушало «session_id», и вкладка молча оставалась
// пустой. Ни компилятор, ни проверка типов такого не видят: с одной
// стороны Rust, с другой TypeScript, между ними строка.
use crate::ssh::{ClosedEvent, DataEvent, OutputGate, SessionCommand, SessionManager};

/// Короткий журнал запуска местной вкладки.
///
/// ⛔ Нужен ровно для одной развилки, которую иначе не разобрать на
/// чужой машине: не запустилась оболочка, не читается её вывод, или
/// вывод читается, но не доходит до окна. По виду пустой вкладки эти
/// три случая неотличимы, и каждый круг «посмотрите ещё раз» стоит
/// человеку дня. Пишем скупо — несколько строк на сессию, рядом с
/// настройками, кодировка UTF-8.
fn записать<R: Runtime>(app: &AppHandle<R>, строка: &str) {
    use std::io::Write as _;
    use tauri::Manager;
    let Ok(каталог) = app.path().app_config_dir() else { return };
    let _ = std::fs::create_dir_all(&каталог);
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(каталог.join("local-terminal.log"))
    else {
        return;
    };
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(f, "{t} {строка}");
}

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
pub async fn local_connect<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<SessionManager>>,
    session_id: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
    elevated: Option<bool>,
) -> Result<String, String> {
    let выбор = pick_shell(shell.as_deref());
    записать(
        &app,
        &format!(
            "запуск сессии {session_id}: оболочка={:?} админ={:?}",
            выбор, elevated
        ),
    );
    let shell = выбор?;

    #[cfg(windows)]
    if elevated.unwrap_or(false) {
        return elevated_connect(app, state, session_id, shell, cols, rows).await;
    }
    #[cfg(not(windows))]
    if elevated.unwrap_or(false) {
        return Err("запуск с правами администратора есть только в Windows".into());
    }

    let pty = match NativePtySystem::default()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
    {
        Ok(p) => p,
        Err(e) => {
            записать(&app, &format!("терминал не открылся: {e}"));
            return Err(format!("не открыть терминал: {e}"));
        }
    };

    let mut cmd = CommandBuilder::new(&shell);
    if let Some(home) = dirs_home() {
        cmd.cwd(home);
    }
    // ⛔ Говорим оболочке, какой это терминал: иначе цвета и перемещение
    // курсора приходят не теми последовательностями, и вывод рассыпается.
    cmd.env("TERM", "xterm-256color");

    let mut child = match pty.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            записать(&app, &format!("оболочка не запустилась: {e}"));
            return Err(format!("не запустить {shell}: {e}"));
        }
    };
    записать(&app, "оболочка запущена, читаю вывод");
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

    // ⛔ Первой строкой кладём в задвижку отметку о запуске. Без неё
    // вкладка, в которую ничего не пришло, выглядит одинаково и когда
    // молчит оболочка, и когда событие не доходит до окна, — различить
    // это по виду нельзя, а человек видит просто пустоту. С отметкой
    // пустой вкладки не бывает: либо она есть и молчит оболочка, либо
    // нет и дело в доставке до окна.
    let запуск = format!("\u{1b}[2m[{shell}]\u{1b}[0m\r\n").into_bytes();
    let gate = Arc::new(Mutex::new(OutputGate::Buffering(vec![запуск])));
    let (tx, mut rx) = mpsc::unbounded_channel::<SessionCommand>();
    state.register(session_id.clone(), tx, gate.clone()).await;

    // ── вывод оболочки → в окно ──
    //
    // ⛔ Порядок порций СВЯЩЕНЕН. Читаем в отдельном потоке (чтение из
    // псевдотерминала блокирующее), но в окно отправляет РОВНО ОДНА
    // задача, которая забирает порции из очереди по одной. Раньше на
    // каждую порцию заводилась своя задача — и выполнялись они в каком
    // угодно порядке: на длинном выводе строки приходили во вкладку
    // перемешанными, а многострочный сниппет уезжал в оболочку задом
    // наперёд и ломался. У сетевых сессий этого нет: там всё идёт одной
    // задачей, потому и не всплывало.
    {
        let (поток, mut очередь) = mpsc::unbounded_channel::<Vec<u8>>();
        let app_чтения = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            // Пишем в журнал только о первых порциях: дальше это был бы
            // поток в сотни строк, а развилку видно по самому началу.
            let mut порций = 0usize;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        записать(&app_чтения, &format!("вывод кончился, порций было {порций}"));
                        break;
                    }
                    Err(e) => {
                        записать(&app_чтения, &format!("чтение оборвалось: {e}"));
                        break;
                    }
                    Ok(n) => {
                        порций += 1;
                        if порций <= 3 {
                            записать(&app_чтения, &format!("прочитано {n} байт (порция {порций})"));
                        }
                        if поток.send(buf[..n].to_vec()).is_err() {
                            break;              // окно закрылось
                        }
                    }
                }
            }
        });

        let app = app.clone();
        let sid = session_id.clone();
        let gate = gate.clone();
        tauri::async_runtime::spawn(async move {
            let mut отправлено = 0usize;
            while let Some(bytes) = очередь.recv().await {
                отправлено += 1;
                let mut g = gate.lock().await;
                match &mut *g {
                    // Пока окно не сказало «слушаю», вывод копится, а не
                    // теряется: первые строки приглашения приходят раньше,
                    // чем окно успевает подписаться.
                    OutputGate::Buffering(v) => {
                        if отправлено <= 3 {
                            записать(&app, "вкладка ещё не слушает — коплю");
                        }
                        v.push(bytes);
                    }
                    OutputGate::Ready => {
                        drop(g);
                        if отправлено <= 3 {
                            записать(&app, "шлю во вкладку");
                        }
                        let _ = app.emit(
                            "ssh-data",
                            DataEvent { session_id: sid.clone(), data: bytes },
                        );
                    }
                }
            }
            let _ = app.emit(
                "ssh-closed",
                ClosedEvent { session_id: sid, reason: "оболочка завершилась".into() },
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
async fn elevated_connect<R: Runtime>(
    app: AppHandle<R>,
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
    // ⛔ Первой строкой кладём в задвижку отметку о запуске. Без неё
    // вкладка, в которую ничего не пришло, выглядит одинаково и когда
    // молчит оболочка, и когда событие не доходит до окна, — различить
    // это по виду нельзя, а человек видит просто пустоту. С отметкой
    // пустой вкладки не бывает: либо она есть и молчит оболочка, либо
    // нет и дело в доставке до окна.
    let запуск = format!("\u{1b}[2m[{shell}]\u{1b}[0m\r\n").into_bytes();
    let gate = Arc::new(Mutex::new(OutputGate::Buffering(vec![запуск])));
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
                                    DataEvent { session_id: sid.clone(), data: bytes },
                                );
                            }
                        }
                    }
                }
            }
            let _ = app.emit(
                "ssh-closed",
                ClosedEvent { session_id: sid, reason: "оболочка завершилась".into() },
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

#[cfg(test)]
mod tests {
    /// ⛔ Имя поля в событии должно совпадать с тем, что слушает окно
    /// (`session_id`). Расхождение не ловится ни компилятором, ни
    /// проверкой типов — между движком и окном просто строка, — и
    /// кончается молча пустой вкладкой.
    #[test]
    fn событие_называет_поля_так_же_как_окно() {
        let ev = crate::ssh::DataEvent {
            session_id: "s1".into(),
            data: vec![65, 66],
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"session_id\""), "окно не узнает это событие: {json}");
        assert!(!json.contains("\"sessionId\""), "{json}");

        let closed = crate::ssh::ClosedEvent {
            session_id: "s1".into(),
            reason: "всё".into(),
        };
        let json = serde_json::to_string(&closed).unwrap();
        assert!(json.contains("\"session_id\""), "{json}");
        assert!(json.contains("\"reason\""), "{json}");
    }

    /// Оболочка по умолчанию должна находиться хоть одна: иначе вкладка
    /// откроется с отказом «не найдено ни одной оболочки».
    #[test]
    fn оболочка_по_умолчанию_находится() {
        assert!(!super::local_shells().is_empty(), "на этой системе не нашлось оболочки");
        assert!(super::pick_shell(None).is_ok());
        assert_eq!(super::pick_shell(Some("/bin/sh")).unwrap(), "/bin/sh");
    }
}

/// ⛔ Полный прогон локальной вкладки без экрана: мок-приложение Tauri,
/// настоящая оболочка в псевдотерминале, настоящий слушатель события.
/// Ровно этот путь дважды выходил пустой вкладкой у человека, а сборка
/// и проверка типов молчали: между движком и окном — строка с именем
/// события и имена полей, их не сверяет никто, кроме такого прогона.
#[cfg(all(test, not(windows)))]
mod живой_прогон {
    use crate::ssh::{ssh_ready, ssh_send, SessionManager};
    use std::sync::{Arc, Mutex};
    use tauri::{Listener, Manager};

    fn накопитель(app: &tauri::App<tauri::test::MockRuntime>) -> Arc<Mutex<Vec<u8>>> {
        накопитель_для(app, "T1")
    }

    fn накопитель_для(
        app: &tauri::App<tauri::test::MockRuntime>,
        ждём: &'static str,
    ) -> Arc<Mutex<Vec<u8>>> {
        let собрано = Arc::new(Mutex::new(Vec::<u8>::new()));
        let c = собрано.clone();
        // Слушаем так же, как окно: по имени события и по имени поля.
        app.listen("ssh-data", move |e| {
            let v: serde_json::Value = serde_json::from_str(e.payload()).unwrap();
            let sid = v["session_id"].as_str().unwrap_or("");
            assert_eq!(sid, ждём, "вкладка не узнает это событие");
            let байты: Vec<u8> = v["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_u64().unwrap() as u8)
                .collect();
            c.lock().unwrap().extend(байты);
        });
        собрано
    }

    fn текст(собрано: &Arc<Mutex<Vec<u8>>>) -> String {
        String::from_utf8_lossy(&собрано.lock().unwrap()).to_string()
    }

    fn ждать(собрано: &Arc<Mutex<Vec<u8>>>, чего: &str, сек: u64) -> bool {
        for _ in 0..(сек * 20) {
            if текст(собрано).contains(чего) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn вкладка_печатает_вывод_оболочки() {
        let app = tauri::test::mock_app();
        app.manage(Arc::new(SessionManager::default()));
        let собрано = накопитель(&app);
        let h = app.handle().clone();

        tauri::async_runtime::block_on(async {
            let оболочка = super::local_connect(
                h.clone(),
                h.state::<Arc<SessionManager>>(),
                "T1".into(),
                Some("/bin/sh".into()),
                80,
                24,
                Some(false),
            )
            .await
            .expect("оболочка не запустилась");
            assert_eq!(оболочка, "/bin/sh");

            // Окно говорит «слушаю» — задвижка открывается и копившееся уходит.
            ssh_ready(h.clone(), h.state::<Arc<SessionManager>>(), "T1".into())
                .await
                .expect("готовность не принята");

            // Enter — это \r, как с клавиатуры в терминале, а не \n.
            ssh_send(
                h.state::<Arc<SessionManager>>(),
                "T1".into(),
                b"echo PRIVET-123\r".to_vec(),
            )
            .await
            .expect("команда не ушла в оболочку");
        });

        assert!(
            ждать(&собрано, "PRIVET-123", 10),
            "вкладка осталась пустой, пришло: {:?}",
            текст(&собрано)
        );
        // Отметка о запуске должна дойти до вкладки раньше всего прочего:
        // именно она отличает «оболочка молчит» от «событие не доходит».
        assert!(
            текст(&собрано).contains("/bin/sh"),
            "во вкладке нет отметки о запуске: {:?}",
            текст(&собрано)
        );

        // ⛔ И журнал должен существовать: он и нужен затем, чтобы на
        // чужой машине отличить «не запустилось» от «не доходит».
        use tauri::Manager;
        let файл = h.path().app_config_dir().unwrap().join("local-terminal.log");
        let записи = std::fs::read_to_string(&файл).unwrap_or_default();
        assert!(
            записи.contains("оболочка запущена") && записи.contains("прочитано"),
            "журнал пуст или неполон ({файл:?}): {записи:?}"
        );
    }

    /// ⛔ Порядок порций вывода. Многострочный сниппет уходит в оболочку
    /// целиком, и оболочка отзывается длинной чередой порций. Если
    /// отправлять каждую своей задачей, они приходят во вкладку как
    /// придётся: у человека строки сниппета встали задом наперёд, и
    /// команда сломалась. Проверяем сотней пронумерованных строк —
    /// перестановку видно сразу, а на коротком выводе её не поймать.
    #[test]
    fn порядок_строк_не_рассыпается() {
        let app = tauri::test::mock_app();
        app.manage(Arc::new(SessionManager::default()));
        let собрано = накопитель_для(&app, "T3");
        let h = app.handle().clone();

        tauri::async_runtime::block_on(async {
            super::local_connect(
                h.clone(),
                h.state::<Arc<SessionManager>>(),
                "T3".into(),
                Some("/bin/sh".into()),
                200,
                50,
                None,
            )
            .await
            .unwrap();
            ssh_ready(h.clone(), h.state::<Arc<SessionManager>>(), "T3".into())
                .await
                .unwrap();
            ssh_send(
                h.state::<Arc<SessionManager>>(),
                "T3".into(),
                "i=1; while [ $i -le 100 ]; do echo СТРОКА-$i; i=$((i+1)); done\r"
                    .as_bytes()
                    .to_vec(),
            )
            .await
            .unwrap();
        });

        assert!(ждать(&собрано, "СТРОКА-100", 15), "вывод не доехал: {}", текст(&собрано));
        // Хвост последней порции мог ещё не дойти — даём ему долететь,
        // иначе проверка полноты сорвётся на ровном месте.
        std::thread::sleep(std::time::Duration::from_millis(500));
        let вывод = текст(&собрано);
        let номера: Vec<usize> = вывод
            .lines()
            .filter_map(|l| l.trim().strip_prefix("СТРОКА-"))
            .filter_map(|n| n.parse().ok())
            .collect();
        // ⛔ Не придираемся к точному числу: самая первая строка вывода
        // иногда слипается с эхом команды, и тогда счёт на единицу
        // меньше — это не поломка, а свойство псевдотерминала. Ловим то,
        // что действительно сломалось: номера обязаны ИДТИ ПО ВОЗРАСТАНИЮ
        // без единой перестановки.
        assert!(номера.len() >= 90, "вывод пришёл не весь: {} строк", номера.len());
        assert_eq!(*номера.last().unwrap(), 100, "хвост вывода потерялся");
        let мимо: Vec<_> = номера
            .windows(2)
            .filter(|п| п[1] != п[0] + 1)
            .map(|п| format!("{} → {}", п[0], п[1]))
            .collect();
        assert!(мимо.is_empty(), "строки пришли вперемешку: {мимо:?}");
    }

    #[test]
    fn вкладка_сообщает_о_закрытии_оболочки() {
        let app = tauri::test::mock_app();
        app.manage(Arc::new(SessionManager::default()));
        let закрылась = Arc::new(Mutex::new(String::new()));
        let c = закрылась.clone();
        app.listen("ssh-closed", move |e| {
            let v: serde_json::Value = serde_json::from_str(e.payload()).unwrap();
            if v["session_id"] == "T2" {
                *c.lock().unwrap() = v["reason"].as_str().unwrap_or("").to_string();
            }
        });
        let h = app.handle().clone();

        tauri::async_runtime::block_on(async {
            super::local_connect(
                h.clone(),
                h.state::<Arc<SessionManager>>(),
                "T2".into(),
                Some("/bin/sh".into()),
                80,
                24,
                None,
            )
            .await
            .unwrap();
            ssh_ready(h.clone(), h.state::<Arc<SessionManager>>(), "T2".into())
                .await
                .unwrap();
            ssh_send(
                h.state::<Arc<SessionManager>>(),
                "T2".into(),
                b"exit\r".to_vec(),
            )
            .await
            .unwrap();
        });

        for _ in 0..200 {
            if !закрылась.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            !закрылась.lock().unwrap().is_empty(),
            "вкладка не узнает, что оболочка закрылась"
        );
    }
}
