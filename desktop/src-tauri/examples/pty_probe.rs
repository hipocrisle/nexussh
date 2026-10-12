//! Проверка псевдотерминала: поднять оболочку, дать команду, прочитать ответ.
use std::io::{Read, Write};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};

fn main() {
    let pty = NativePtySystem::default()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .expect("не открыть терминал");

    let shell = if cfg!(windows) { "powershell.exe" } else { "/bin/sh" };
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    let mut child = pty.slave.spawn_command(cmd).expect("не запустить оболочку");
    drop(pty.slave);

    let mut reader = pty.master.try_clone_reader().unwrap();
    let mut writer = pty.master.take_writer().unwrap();

    let got = std::thread::spawn(move || {
        let mut all = Vec::new();
        let mut buf = [0u8; 4096];
        let start = std::time::Instant::now();
        while start.elapsed().as_secs() < 5 {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    all.extend_from_slice(&buf[..n]);
                    // ⛔ Ищем именно ВЫЧИСЛЕННОЕ значение: само слово есть и в
                    // эхе команды, и проба прекращала чтение, не дождавшись
                    // ответа, — врала она, а не терминал.
                    if String::from_utf8_lossy(&all).contains("ОТВЕТ-ПОЛУЧЕН-42") {
                        break;
                    }
                }
            }
        }
        String::from_utf8_lossy(&all).to_string()
    });

    std::thread::sleep(std::time::Duration::from_millis(800));
    // ⛔ В терминале «Enter» — это возврат каретки (\r), а не перевод
    // строки: с \n оболочка не считает строку введённой и просто молчит.
    // Окно шлёт именно \r, так что это особенность пробы, не кода.
    write!(writer, "echo ОТВЕТ-ПОЛУЧЕН-$((40+2)); exit\r").unwrap();
    writer.flush().unwrap();

    let out = got.join().unwrap();
    let _ = child.kill();

    println!("  оболочка ответила: {}", if out.contains("ОТВЕТ-ПОЛУЧЕН-42") { "да" } else { "НЕТ" });
    println!("  размер вывода: {} байт", out.len());
    // проверяем, что это именно терминал: оболочка эхом возвращает введённое
    println!("  эхо ввода (признак настоящего терминала): {}",
             if out.contains("echo ОТВЕТ") { "есть" } else { "нет" });
    println!("  сырой вывод: {:?}", out);
    let _ = child.wait();
}
