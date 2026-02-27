use std::process::{Child, Command};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::net::TcpStream;
use std::sync::Mutex;
use tauri::Manager;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder};
use tauri::menu::{Menu, MenuItem};

struct ServerProcess(Mutex<Option<Child>>);

fn start_server(server_dir: &std::path::Path) -> Result<Child, String> {
    for attempt in 1..=3 {
        let result = {
            #[cfg(windows)]
            {
                Command::new("node")
                    .args(["server.js", "--no-open"])
                    .current_dir(server_dir)
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .spawn()
            }
            #[cfg(not(windows))]
            {
                Command::new("node")
                    .args(["server.js", "--no-open"])
                    .current_dir(server_dir)
                    .spawn()
            }
        };
        match result {
            Ok(child) => return Ok(child),
            Err(e) if attempt < 3 => {
                eprintln!("Server start attempt {}/3 failed: {}", attempt, e);
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            Err(e) => return Err(format!("Failed to start server after 3 attempts: {}", e)),
        }
    }
    unreachable!()
}

fn wait_for_server(port: u16, timeout_ms: u64) -> bool {
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);
    while start.elapsed() < timeout {
        if TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    false
}

fn kill_server(child: Child) {
    #[cfg(windows)]
    {
        let pid = child.id();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(not(windows))]
    {
        let mut child = child;
        let _ = child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let server_dir = if cfg!(debug_assertions) {
        std::env::current_dir().unwrap().parent().unwrap().to_path_buf()
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| std::env::current_dir().unwrap())
    };

    let child = start_server(&server_dir)
        .expect("Failed to start node server. Is Node.js installed?");

    if !wait_for_server(3847, 8000) {
        eprintln!("Warning: Server did not respond within 8 seconds");
    }

    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(Some(child))))
        .setup(|app| {
            // System tray
            let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Cockpit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let mut builder = TrayIconBuilder::new()
                .tooltip("Cockpit")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            let state = app.state::<ServerProcess>();
                            if let Some(child) = state.0.lock().unwrap().take() {
                                kill_server(child);
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                builder = builder.icon(icon);
            }

            builder.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Minimize to tray instead of closing
                    api.prevent_close();
                    let _ = window.hide();
                }
                tauri::WindowEvent::Destroyed => {
                    let state = window.state::<ServerProcess>();
                    let mut guard = state.0.lock().unwrap();
                    if let Some(child) = guard.take() {
                        kill_server(child);
                    }
                    drop(guard);
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
