// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ⛔ Повышенный экземпляр — переходник, а не приложение: он поднимает
    // оболочку с правами администратора и связывает её с окном обычного
    // экземпляра. Окна у него быть не должно, иначе человек увидит
    // второе пустое окно программы.
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).map(|a| a == "--pty-bridge").unwrap_or(false) {
            if let Err(e) = desktop_lib::run_pty_bridge(&args[2..]) {
                eprintln!("{e}");
                std::process::exit(1);
            }
            return;
        }
    }
    desktop_lib::run()
}
