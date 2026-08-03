use std::{
    fs,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child as SystemChild, Command as SystemCommand, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};

use tauri::{
    AppHandle, Manager, RunEvent, Runtime,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_shell::{
    ShellExt,
    process::{CommandChild, CommandEvent},
};

const SERVER_PORT: u16 = 4317;
const GLOBAL_SHORTCUT: &str = "CommandOrControl+Shift+J";

#[derive(Default)]
struct RuntimeProcesses {
    server: Mutex<Option<CommandChild>>,
    speech: Mutex<Option<SystemChild>>,
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

fn configure_tray(app: &tauri::App) -> tauri::Result<()> {
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
    let open = MenuItem::with_id(app, "open", "JARVIS öffnen", true, None::<&str>)?;
    let enabled = !cfg!(debug_assertions) && app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Beim Anmelden öffnen",
        true,
        enabled,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "JARVIS beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &autostart, &separator, &quit])?;
    let autostart_item = autostart.clone();

    TrayIconBuilder::with_id("jarvis-tray")
        .icon(tray_icon)
        .icon_as_template(true)
        .tooltip("JARVIS")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "autostart" => {
                let currently_enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let result = if currently_enabled {
                    app.autolaunch().disable()
                } else {
                    app.autolaunch().enable()
                };
                if result.is_ok() {
                    let _ = autostart_item.set_checked(!currently_enabled);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn application_data_directory(app: &tauri::App) -> tauri::Result<PathBuf> {
    let directory = app.path().app_data_dir()?;
    fs::create_dir_all(&directory)?;
    Ok(directory)
}

fn spawn_speech_service(app_data: &PathBuf) -> Option<SystemChild> {
    if TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], 8178)),
        Duration::from_millis(150),
    )
    .is_ok()
    {
        log::info!("Using the existing local Whisper service on port 8178");
        return None;
    }

    let model = app_data.join("models/whisper/ggml-large-v3-turbo-q5_0.bin");
    if !model.is_file() {
        log::warn!("Desktop Whisper model is missing at {}", model.display());
        return None;
    }

    let executable = PathBuf::from("/opt/homebrew/bin/whisper-server");
    if !executable.is_file() {
        log::warn!(
            "whisper-server is not installed at {}",
            executable.display()
        );
        return None;
    }

    match SystemCommand::new(executable)
    .args([
      "--model",
      model.to_string_lossy().as_ref(),
      "--host",
      "127.0.0.1",
      "--port",
      "8178",
      "--language",
      "de",
      "--threads",
      "6",
      "--convert",
      "--prompt",
      "JARVIS, Codex, ChatGPT, Notion, Ollama, Qwen, GitHub, TypeScript, Machine Learning, Reinforcement Learning",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
  {
    Ok(child) => Some(child),
    Err(error) => {
      log::warn!("Could not start local Whisper service: {error}");
      None
    }
  }
}

fn spawn_desktop_server(
    app: &tauri::App,
    app_data: &PathBuf,
) -> Result<CommandChild, tauri_plugin_shell::Error> {
    let (mut events, child) = app
        .shell()
        .sidecar("jarvis-server")?
        .env("JARVIS_SERVER_PORT", SERVER_PORT.to_string())
        .env("JARVIS_CONFIG_DIR", app_data)
        .spawn()?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => log::info!("{}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Stderr(bytes) => log::warn!("{}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Error(error) => log::error!("Desktop server error: {error}"),
                CommandEvent::Terminated(payload) => {
                    log::warn!("Desktop server stopped: {:?}", payload.code)
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

fn reveal_when_server_is_ready(app: AppHandle) {
    thread::spawn(move || {
        let address = SocketAddr::from(([127, 0, 0, 1], SERVER_PORT));
        let ready = (0..120).any(|_| {
            if TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok() {
                true
            } else {
                thread::sleep(Duration::from_millis(250));
                false
            }
        });

        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = handle.get_webview_window("main") {
                if ready {
                    if let Ok(url) = format!("http://127.0.0.1:{SERVER_PORT}").parse() {
                        let _ = window.navigate(url);
                    }
                }
                show_main_window(&handle);
            }
        });
    });
}

fn stop_runtime_processes(app: &AppHandle) {
    if let Some(processes) = app.try_state::<RuntimeProcesses>() {
        if let Ok(mut server) = processes.server.lock() {
            if let Some(child) = server.take() {
                let _ = child.kill();
            }
        }
        if let Ok(mut speech) = processes.speech.lock() {
            if let Some(mut child) = speech.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcut(GLOBAL_SHORTCUT)
        .expect("invalid global shortcut")
        .with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_main_window(app);
            }
        })
        .build();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _working_directory| {
                show_main_window(app);
            },
        ))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(shortcut_plugin)
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            configure_tray(app)?;

            let processes = RuntimeProcesses::default();
            if cfg!(debug_assertions) {
                show_main_window(app.handle());
            } else {
                let app_data = application_data_directory(app)?;
                if !app.autolaunch().is_enabled().unwrap_or(false) {
                    if let Err(error) = app.autolaunch().enable() {
                        log::warn!("Could not enable launch at login: {error}");
                    }
                }
                *processes
                    .server
                    .lock()
                    .expect("server process lock poisoned") =
                    Some(spawn_desktop_server(app, &app_data)?);
                *processes
                    .speech
                    .lock()
                    .expect("speech process lock poisoned") = spawn_speech_service(&app_data);
                reveal_when_server_is_ready(app.handle().clone());
            }
            app.manage(processes);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building JARVIS");

    app.run(|app, event| match event {
        RunEvent::Exit => stop_runtime_processes(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main_window(app),
        _ => {}
    });
}
