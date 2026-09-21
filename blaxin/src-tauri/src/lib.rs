use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
mod lock;
mod update;

use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

struct ServerState {
    child: Mutex<Option<Child>>,
}

struct AppState {
    server_state: ServerState,
    lock_file: Mutex<Option<std::fs::File>>,
}

/// Find the bundled Node.js binary from Tauri resources.
/// In production, this is at <resource_dir>/node/bin/node.
/// In dev mode, fall back to system node.
fn find_bundled_node(resource_dir: &Path) -> Option<String> {
    // Try bundled node first (production build). The bundle layout differs
    // per OS and both spellings are probed so one source tree serves all
    // platforms (Linux/macOS keep the exact same path as before):
    //   Linux/macOS: <resources>/node/bin/node
    //   Windows:     <resources>/node/bin/node.exe
    let bin_dir = resource_dir.join("node").join("bin");
    let candidates: [&str; 2] = if cfg!(windows) {
        ["node.exe", "node"]
    } else {
        ["node", "node.exe"]
    };
    for name in candidates {
        let bundled = bin_dir.join(name);
        if bundled.exists() {
            eprintln!("[BLAXIN] Using bundled node: {:?}", bundled);
            return Some(bundled.to_string_lossy().to_string());
        }
    }
    None
}

fn find_system_node() -> Option<String> {
    let paths = [
        "/usr/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/snap/bin/node",
    ];

    for path in &paths {
        if Path::new(path).exists() {
            return Some(path.to_string());
        }
    }

    Command::new("which")
        .arg("node")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()
        .and_then(|child| {
            child.wait_with_output().ok().and_then(|output| {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() && Path::new(&path).exists() {
                    Some(path)
                } else {
                    None
                }
            })
        })
}

fn find_node_binary(resource_dir: &Path) -> Option<String> {
    // In production: use bundled node. In dev: use system node.
    find_bundled_node(resource_dir).or_else(find_system_node)
}

/// Find the server directory - either bundled resource or development source
fn find_server_dir(resource_dir: &Path) -> Option<PathBuf> {
    // Production: bundled server in resources
    let bundled_server = resource_dir.join("blaxin-server");
    if bundled_server.join("dist").join("index.js").exists() {
        eprintln!("[BLAXIN] Using bundled server at {:?}", bundled_server);
        return Some(bundled_server);
    }

    // Development: server in project tree
    let exe_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let exe_dir = exe_path.parent().unwrap_or(Path::new("."));

    let mut candidate = exe_dir.to_path_buf();
    for _ in 0..8 {
        if candidate.join("server").join("dist").join("index.js").exists() {
            return Some(candidate.join("server"));
        }
        if candidate.join("server").join("package.json").exists() {
            return Some(candidate.join("server"));
        }
        if !candidate.pop() {
            break;
        }
    }

    // Last resort: current directory
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let server = cwd.join("server");
    if server.exists() {
        return Some(server);
    }

    None
}

fn start_server(resource_dir: &Path) -> Result<Child, String> {
    let node_bin = find_node_binary(resource_dir).ok_or_else(|| {
        "Node.js runtime not found. The application may be misconfigured.".to_string()
    })?;

    let server_dir = find_server_dir(resource_dir).ok_or_else(|| {
        "Server directory not found. The application may be misconfigured.".to_string()
    })?;

    // Determine entry point: compiled dist/index.js or TypeScript src/index.ts
    let (entry_args, entry_dir): (Vec<String>, PathBuf) = if server_dir.join("dist").join("index.js").exists() {
        eprintln!("[BLAXIN] Starting compiled server from dist/index.js");
        (vec![
            server_dir.join("dist").join("index.js").to_string_lossy().to_string(),
        ], server_dir.clone())
    } else if server_dir.join("src").join("index.ts").exists() {
        eprintln!("[BLAXIN] Starting TypeScript server with tsx");
        (vec![
            "--import".to_string(),
            "tsx".to_string(),
            server_dir.join("src").join("index.ts").to_string_lossy().to_string(),
        ], server_dir.clone())
    } else {
        return Err(format!(
            "No server entry point found in {:?}", server_dir
        ));
    };

    eprintln!("[BLAXIN] Node binary: {}", node_bin);
    eprintln!("[BLAXIN] Server dir: {:?}", entry_dir);
    eprintln!("[BLAXIN] Entry args: {:?}", entry_args);

    let mut cmd = Command::new(&node_bin);
    cmd.args(&entry_args)
        .current_dir(&entry_dir)
        .env("PORT", "3001")
        // Desktop builds must bind loopback only: the backend can run
        // shells and drive the desktop, so it must not be reachable from
        // the network.
        .env("BLAXIN_HOST", "127.0.0.1")
        .env("BLAXIN_DESKTOP", "1")
        .env("NODE_ENV", "production")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Put the server in its own process group so shutdown can signal the
    // whole tree (node + any shells/children it spawned) instead of only
    // the node process — otherwise terminal sessions and launched apps
    // survive as orphans after BLAXIN exits.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setpgid(0, 0);
                Ok(())
            });
        }
    }

    let child = cmd.spawn().map_err(|e| format!("Failed to start server: {e}"))?;

    Ok(child)
}

/// SIGTERM the server process group, wait up to `grace`, then SIGKILL.
/// Killing the group (negative PID) terminates node AND any shells the
/// terminal tool spawned, so no orphans survive a BLAXIN exit.
fn terminate_server(child: &mut Child) {
    #[cfg(unix)]
    {
        // Reap exit status of the child first if already done; then signal.
        let pid = child.id() as i32;
        let _ = child.try_wait();
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => {
                    eprintln!("[BLAXIN] Server exited gracefully.");
                    return;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }
        eprintln!("[BLAXIN] Server did not exit in time — sending SIGKILL.");
        let _ = child.kill();
        let _ = child.wait();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Minimal HTTP GET used for the readiness probe. Returns the body when the
/// server answers 200. Avoids depending on the full reqwest stack at
/// startup just for one health check.
fn http_get_health() -> Option<String> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect_timeout(
        &"127.0.0.1:3001".parse().ok()?,
        Duration::from_secs(2),
    )
    .ok()?;
    let request = "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:3001\r\nConnection: close\r\n\r\n";
    stream.write_all(request.as_bytes()).ok()?;
    stream.flush().ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    String::from_utf8_lossy(&buf).into_owned().into()
}

/// Wait until the BLAXIN backend answers /api/health with a 200 and the
/// BLAXIN health payload. This is stricter than a bare TCP connect: a
/// foreign process squatting on port 3001 must not be mistaken for BLAXIN
/// (which previously caused a blank window — the UI connected to a server
/// that was not BLAXIN's).
fn wait_for_server(timeout: Duration) -> bool {
    let start = Instant::now();
    eprintln!("[BLAXIN] Waiting for server to be ready...");

    loop {
        if start.elapsed() > timeout {
            eprintln!(
                "[BLAXIN] Server startup timed out after {:?}",
                timeout
            );
            return false;
        }

        if let Some(body) = http_get_health() {
            if body.contains("\"status\":\"ok\"") && body.contains("version") {
                eprintln!("[BLAXIN] Server is ready!");
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn setup_tray(app: &AppHandle) {
    let show_item = MenuItem::with_id(app, "show", "Open BLAXIN", true, None::<&str>)
        .expect("failed to create tray menu item");
    let quit_item = MenuItem::with_id(app, "quit", "Quit BLAXIN", true, None::<&str>)
        .expect("failed to create tray menu item");
    let menu = Menu::with_items(app, &[&show_item, &quit_item])
        .expect("failed to create tray menu");

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("BLAXIN — AI Desktop Agent")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                eprintln!("[BLAXIN] Quit requested from tray menu.");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)
        .expect("Failed to create tray icon");
}

// ── Deb-aware update check (works for both .deb and AppImage installs) ─
#[tauri::command]
fn check_for_update_full() -> update::UpdateInfo {
    let info = update::full_check();
    eprintln!(
        "[BLAXIN-UPD] check_for_update_full → available={} latest={} err={:?} deb={} mode={}",
        info.update_available,
        info.latest_version,
        info.error,
        info.deb.is_some(),
        std::env::var("BLAXIN_INSTALL_MODE").unwrap_or_default()
    );
    info
}

/// Restart the app detached (used after an AppImage update finishes — the
/// .deb path restarts itself inside `install_update_full`).
#[tauri::command]
async fn relaunch_app(app: AppHandle) -> Result<serde_json::Value, String> {
    update::relaunch()?;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        app.exit(0);
    });
    Ok(serde_json::json!({"success": true}))
}

/// Install a fully verified update. `kind` is "deb" or "appimage".
/// Progress is streamed to the UI via `blaxin-update-progress` events.
#[tauri::command]
async fn install_update_full(
    app: AppHandle,
    kind: String,
) -> Result<serde_json::Value, String> {
    let info = update::full_check();
    eprintln!(
        "[BLAXIN-UPD] install_update_full(kind={kind}) → available={} latest={} err={:?} deb={}",
        info.update_available,
        info.latest_version,
        info.error,
        info.deb.is_some()
    );
    if !info.update_available {
        return Err("no update available".to_string());
    }

    let app_for_blocking = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let progress = |stage: &str, percent: u64, message: String| {
            let _ = app_for_blocking.emit(
                "blaxin-update-progress",
                update::UpdateProgress {
                    stage: stage.to_string(),
                    percent,
                    message,
                },
            );
        };

        if kind == "deb" {
            let deb = info
                .deb
                .clone()
                .ok_or_else(|| "no signed .deb artifact in the update manifest".to_string())?;
            let pubkey = update::public_key_b64();
            if pubkey.trim().is_empty() {
                return Err(
                    "BLAXIN is not configured with an update public key — refusing to install".to_string(),
                );
            }

            progress("downloading", 0, "Downloading update…".to_string());
            let path = update::download_and_verify_deb(&deb, &pubkey, &mut |p| {
                progress("downloading", p, format!("Downloading update… {p}%"));
            })?;

            progress(
                "verifying",
                100,
                "Signature and checksum verified ✓".to_string(),
            );
            progress(
                "installing",
                100,
                "Installing update (system authentication may be required)…".to_string(),
            );
            // Record the install in the update journal BEFORE touching the
            // package: if the new version never starts, the UI can offer
            // "Restore previous version" (rollback) from this record.
            update::mark_pending_install(&info.latest_version, &info.current_version);
            update::install_deb(&path)?;
            let _ = std::fs::remove_file(&path);

            progress("restarting", 100, "Restarting BLAXIN…".to_string());
            // Spawn the freshly installed binary (it waits for this
            // instance to release the single-instance lock and exit, then
            // starts its own backend — no port race, no blank window).
            update::relaunch()?;

            // Hand over to the freshly installed binary.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(600));
                app_for_blocking.exit(0);
            });
            return Ok(serde_json::json!({
                "success": true,
                "message": "Update installed. BLAXIN is restarting.",
            }));
        }

        Err(format!("install kind not supported here: {kind}"))
    })
    .await
    .map_err(|e| format!("update task failed: {e}"))?
}

/// Rollback status shown to the UI when a fresh install never confirmed a
/// successful startup.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RollbackStatus {
    pub can_rollback: bool,
    pub pending_version: Option<String>,
    pub previous_version: Option<String>,
}

#[tauri::command]
fn rollback_status() -> RollbackStatus {
    let journal = update::read_journal();
    RollbackStatus {
        can_rollback: update::is_rollback_available(),
        pending_version: journal.pending_version,
        previous_version: journal.previous_version,
    }
}

/// Restore the previously running release (same verified pipeline as a
/// normal update, pointed at the previous version).
#[tauri::command]
async fn rollback_update(app: AppHandle) -> Result<serde_json::Value, String> {
    let app_for_blocking = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let progress = |stage: &str, percent: u64, message: String| {
            let _ = app_for_blocking.emit(
                "blaxin-update-progress",
                update::UpdateProgress {
                    stage: stage.to_string(),
                    percent,
                    message,
                },
            );
        };

        update::perform_rollback(&mut |stage, percent, message| {
            progress(stage, percent, message);
        })?;

        // Hand over to the restored binary.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(600));
            app_for_blocking.exit(0);
        });
        Ok(serde_json::json!({
            "success": true,
            "message": "Previous version restored. BLAXIN is restarting.",
        }))
    })
    .await
    .map_err(|e| format!("rollback task failed: {e}"))?
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<serde_json::Value, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    match update {
        Some(update) => Ok(serde_json::json!({
            "updateAvailable": true,
            "currentVersion": update.current_version,
            "latestVersion": update.version,
            "downloadUrl": update.download_url,
            "releaseNotes": update.body.unwrap_or_default(),
        })),
        None => Ok(serde_json::json!({
            "updateAvailable": false,
        })),
    }
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<serde_json::Value, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    match update {
        Some(update) => {
            update
                .download_and_install(
                    |_chunk_length, _total_content_length| {
                        // Progress callback - could emit events to frontend
                    },
                    || {
                        eprintln!("[BLAXIN] Download complete, installing update...");
                    },
                )
                .await
                .map_err(|e| format!("Update installation failed: {}", e))?;

            Ok(serde_json::json!({
                "success": true,
                "message": "Update installed. BLAXIN will restart.",
            }))
        }
        None => Ok(serde_json::json!({
            "success": false,
            "message": "No update available",
        })),
    }
}

/// Ignore SIGHUP: BLAXIN is a GUI app and must keep running when the
/// terminal that launched it closes (otherwise `blaxin` started from a
/// shell dies the moment the shell exits, which looked like the app
/// "vanishing" while its backend kept running). The backend is still
/// shut down cleanly through the normal exit path (window close / tray
/// Quit).
#[cfg(unix)]
fn ignore_sighup() {
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ignore_sighup();

    // ── Single-instance guard ───────────────────────────────────────
    // Acquired BEFORE the app is built. The updater relaunch passes
    // BLAXIN_RELAUNCHED=1 so the fresh process waits for the old one to
    // hand over the lock (update → restart once); a plain duplicate
    // launch fails fast instead of producing a port conflict and a
    // blank window.
    let handover = std::env::var("BLAXIN_RELAUNCHED").map(|v| v == "1").unwrap_or(false);
    let lock_file = match lock::acquire(handover) {
        lock::LockOutcome::Acquired(file) => {
            eprintln!("[BLAXIN] Single-instance lock acquired (handover={handover})");
            Some(file)
        }
        lock::LockOutcome::AlreadyRunning => {
            eprintln!(
                "[BLAXIN] Another BLAXIN instance is already running. Refusing to start a duplicate."
            );
            std::process::exit(1);
        }
    };

    let server_state = ServerState {
        child: Mutex::new(None),
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState { server_state, lock_file: Mutex::new(lock_file) })
        .invoke_handler(tauri::generate_handler![
            check_for_updates,
            install_update,
            check_for_update_full,
            install_update_full,
            relaunch_app,
            rollback_status,
            rollback_update,
        ])
        .setup(|app| {
            // Set up system tray (with Open/Quit menu)
            setup_tray(app.handle());

            // Resolve resource directory for bundled node + server
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
            eprintln!("[BLAXIN] Resource dir: {:?}", resource_dir);

            // Start the Node.js server
            match start_server(&resource_dir) {
                Ok(child) => {
                    let state = app.state::<AppState>();
                    *state.server_state.child.lock().unwrap() = Some(child);

                    // Wait for the server to be ready in a background thread
                    let app_handle = app.handle().clone();
                    std::thread::spawn(move || {
                        if wait_for_server(Duration::from_secs(30)) {
                            // The backend is healthy: if this process is the
                            // freshly installed version of a pending update,
                            // mark the update successful (disables rollback).
                            update::confirm_successful_startup();
                            if let Some(window) =
                                app_handle.get_webview_window("main")
                            {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        } else {
                            eprintln!(
                                "[BLAXIN] Server failed to start within timeout"
                            );
                            // Show the window anyway so user can see diagnostics
                            if let Some(window) =
                                app_handle.get_webview_window("main")
                            {
                                let _ = window.show();
                            }
                        }
                    });
                }
                Err(e) => {
                    eprintln!("[BLAXIN] Failed to start server: {}", e);
                    // Show the window anyway so user can see diagnostics
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window quits BLAXIN for real (window X
            // button, Alt+F4, wmctrl close). The Exit handler then shuts
            // down the backend and releases the single-instance lock.
            if let tauri::WindowEvent::Destroyed = event {
                // A hard X11 destroy (e.g. `xdotool windowclose`, WM
                // kill) bypasses CloseRequested; quit explicitly so the
                // app never lingers as an invisible process with a dead
                // window.
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    app.exit(0);
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running BLAXIN");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Terminate the backend process tree (SIGTERM, then SIGKILL)
            // and release the single-instance lock so the next launch —
            // including the post-update relaunch — starts clean.
            if let Some(state) = app_handle.try_state::<AppState>() {
                if let Some(mut child) =
                    state.server_state.child.lock().unwrap().take()
                {
                    eprintln!("[BLAXIN] Shutting down server...");
                    terminate_server(&mut child);
                }
                if let Some(file) = state.lock_file.lock().unwrap().take() {
                    lock::release(Some(file));
                }
            }
        }
    });
}