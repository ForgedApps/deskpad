mod appbar;
mod calendar;
mod google;
mod store;

use chrono::{DateTime, Utc};
use google::Google;
use serde::Serialize;
use std::sync::Mutex;
use store::{ArchivedItem, Item, Schedule, Settings, Store};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const CAPTURE_SHORTCUT: &str = "ctrl+space";

/// Cached ICS text so the UI can refresh often without hammering the feed.
/// Whether the sidebar is currently hidden via the tray.
#[derive(Default)]
struct SidebarHidden(Mutex<bool>);

// ---------- Items (notes & tasks) ----------

#[tauri::command]
fn list_items(store: State<Store>) -> Vec<Item> {
    store.items.lock().unwrap().clone()
}

/// Replace the whole outline. The frontend owns ordering and nesting, so it
/// sends the full list after every edit.
#[tauri::command]
fn set_items(store: State<Store>, items: Vec<Item>) {
    *store.items.lock().unwrap() = items;
    store.save_items();
}

#[tauri::command]
fn list_archive(store: State<Store>) -> Vec<ArchivedItem> {
    store.archive.lock().unwrap().clone()
}

/// Everything the journal needs in one call: live rows, archived rows and the
/// recorded calendar events per day. Small enough to send whole.
#[derive(Serialize)]
struct JournalData {
    items: Vec<Item>,
    archive: Vec<ArchivedItem>,
    day_events: std::collections::BTreeMap<String, Vec<calendar::Meeting>>,
}

#[tauri::command]
fn list_journal(store: State<Store>) -> JournalData {
    JournalData {
        items: store.items.lock().unwrap().clone(),
        archive: store.archive.lock().unwrap().clone(),
        day_events: store.day_events.lock().unwrap().clone(),
    }
}

/// The sidebar reports the events it fetched for a day (`YYYY-MM-DD`, local)
/// so the journal can show them later without Google.
#[tauri::command]
fn record_day_events(app: AppHandle, store: State<Store>, day: String, meetings: Vec<calendar::Meeting>) {
    if store.record_day_events(&day, meetings) {
        app.emit_to("journal", "day-events-changed", day).ok();
    }
}

/// Open (or raise) the journal window.
#[tauri::command]
fn open_journal(app: AppHandle) {
    let Some(win) = app.get_webview_window("journal") else { return };
    if win.is_minimized().unwrap_or(false) {
        win.unminimize().ok();
    }
    win.show().ok();
    win.set_focus().ok();
    app.emit_to("journal", "journal-shown", ()).ok();
}

/// Bring the sidebar back and ask it to focus one row (from the journal).
#[tauri::command]
fn show_item(app: AppHandle, id: u64) {
    set_sidebar_visible(&app, true);
    app.emit_to("main", "focus-item", id).ok();
}

/// Move items (and their children) to the archive.
#[tauri::command]
fn archive_items(app: AppHandle, store: State<Store>, ids: Vec<u64>) {
    store.archive_items(&ids);
    store.save_items();
    store.save_archive();
    app.emit("items-changed", ()).ok();
}

#[tauri::command]
fn restore_items(app: AppHandle, store: State<Store>, ids: Vec<u64>) {
    store.restore_items(&ids);
    store.save_items();
    store.save_archive();
    app.emit("items-changed", ()).ok();
}

/// Permanently delete archived rows; an empty list clears the whole archive.
#[tauri::command]
fn delete_archived(store: State<Store>, ids: Vec<u64>) {
    store.archive.lock().unwrap().retain(|a| !ids.is_empty() && !ids.contains(&a.item.id));
    store.save_archive();
}

/// Add a top-level item from raw text (used by the capture popup). Task markers
/// in the text are honoured; `kind` overrides them (the popup passes "task"
/// when it found a date in the text). Inserted at the top so a capture is
/// visible at once.
#[tauri::command]
fn add_item(app: AppHandle, store: State<Store>, text: String, kind: Option<String>) -> Option<Item> {
    let mut item = Item::from_text(&text, None)?;
    if let Some(k) = kind.filter(|k| k == "task" || k == "note") {
        item.kind = k;
    }
    store.items.lock().unwrap().insert(0, item.clone());
    store.save_items();
    app.emit("items-changed", ()).ok();
    Some(item)
}

/// Put a row on the calendar: create (or move) its Google event and record
/// the schedule on the item, which becomes a task. The frontend has already
/// parsed the date out of the text, so `start`/`end` are unix seconds.
#[tauri::command]
async fn schedule_item(
    app: AppHandle,
    store: State<'_, Store>,
    google: State<'_, Google>,
    id: u64,
    start: i64,
    end: i64,
    all_day: bool,
) -> Result<Item, String> {
    if !google.connected() {
        return Err("Connect Google Calendar in Settings to put tasks on your calendar.".into());
    }
    if end <= start {
        return Err("The event must end after it starts.".into());
    }
    let (title, existing) = {
        let items = store.items.lock().unwrap();
        let it = items.iter().find(|i| i.id == id).ok_or("That row no longer exists.")?;
        (store::strip_inline(&it.text), it.schedule.as_ref().and_then(|s| s.event_id.clone()))
    };
    let (cid, secret) = {
        let s = store.settings.lock().unwrap();
        (s.google_client_id.clone(), s.google_client_secret.clone())
    };
    let created = google
        .upsert_event(&cid, &secret, existing.as_deref(), &title, start, end, all_day)
        .await?;
    let event_id = created.id.strip_prefix("g:").unwrap_or(&created.id).to_string();
    let item = {
        let mut items = store.items.lock().unwrap();
        let it = items.iter_mut().find(|i| i.id == id).ok_or("That row no longer exists.")?;
        it.kind = "task".into();
        it.schedule = Some(Schedule { start, end, all_day, event_id: Some(event_id) });
        it.clone()
    };
    store.save_items();
    app.emit("items-changed", ()).ok();
    app.emit("calendar-changed", ()).ok();
    Ok(item)
}

/// Take a row off the calendar: delete its Google event (if it has one) and
/// clear the schedule. The row stays in the outline.
#[tauri::command]
async fn unschedule_item(
    app: AppHandle,
    store: State<'_, Store>,
    google: State<'_, Google>,
    id: u64,
) -> Result<Item, String> {
    let existing = {
        let items = store.items.lock().unwrap();
        let it = items.iter().find(|i| i.id == id).ok_or("That row no longer exists.")?;
        it.schedule.as_ref().and_then(|s| s.event_id.clone())
    };
    if let Some(ev) = existing.filter(|e| !e.is_empty()) {
        if google.connected() {
            let (cid, secret) = {
                let s = store.settings.lock().unwrap();
                (s.google_client_id.clone(), s.google_client_secret.clone())
            };
            google.delete_event(&cid, &secret, &ev).await?;
        }
    }
    let item = {
        let mut items = store.items.lock().unwrap();
        let it = items.iter_mut().find(|i| i.id == id).ok_or("That row no longer exists.")?;
        it.schedule = None;
        it.clone()
    };
    store.save_items();
    app.emit("items-changed", ()).ok();
    app.emit("calendar-changed", ()).ok();
    Ok(item)
}

// ---------- Settings ----------

#[tauri::command]
fn get_settings(store: State<Store>) -> Settings {
    store.settings.lock().unwrap().clone()
}

fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    // A dev build must never register itself: the Run entry would point at
    // target\debug\deskpad.exe, which needs the Vite server and shows a console.
    // The installed release build re-applies the entry on every launch
    // (`sync_autostart_on_launch`).
    if cfg!(debug_assertions) {
        eprintln!("[autostart] skipped in debug build (would be {enabled})");
        return Ok(());
    }
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())
}

/// Runs once at startup. Release: re-assert the Run entry so it always points
/// at the exe that is actually installed, even if an installer, an old dev
/// build or a manual edit changed or removed it. Debug: if the Run entry points
/// at a `target\debug` build (left by a build older than the guard above),
/// delete it so a stale dev exe can't be launched at sign-in again.
fn sync_autostart_on_launch(app: &AppHandle, wanted: bool) {
    if cfg!(debug_assertions) {
        #[cfg(windows)]
        match remove_debug_run_entry() {
            Ok(true) => eprintln!("[autostart] removed a Run entry that pointed at a debug build"),
            Ok(false) => {}
            Err(e) => eprintln!("[autostart] could not inspect the Run entry: {e}"),
        }
        return;
    }
    if let Err(e) = apply_autostart(app, wanted) {
        eprintln!("[autostart] could not apply (wanted {wanted}): {e}");
    }
}

/// Delete HKCU\...\Run\Deskpad if its command mentions `target\debug`.
/// Returns whether an entry was removed.
#[cfg(windows)]
fn remove_debug_run_entry() -> Result<bool, String> {
    use windows::core::w;
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ,
    };
    let sub = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let name = w!("Deskpad");
    let mut buf = [0u16; 2048];
    let mut size = (buf.len() * 2) as u32;
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            sub,
            name,
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
    };
    if rc.is_err() {
        return Ok(false); // no entry (or not a string): nothing to do
    }
    let len = (size as usize / 2).saturating_sub(1).min(buf.len());
    let cmd = String::from_utf16_lossy(&buf[..len]).to_ascii_lowercase();
    if !cmd.contains("target\\debug") {
        return Ok(false);
    }
    unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, sub, name) }
        .ok()
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn set_settings(app: AppHandle, store: State<Store>, settings: Settings) -> Result<(), String> {
    let layout_changed;
    let autostart_changed;
    {
        let mut s = store.settings.lock().unwrap();
        layout_changed = s.width != settings.width || s.reserve_space != settings.reserve_space;
        autostart_changed = s.autostart != settings.autostart;
        *s = settings.clone();
    }
    store.save_settings();
    if let Some(win) = app.get_webview_window("main") {
        win.set_always_on_top(settings.always_on_top).ok();
        if layout_changed && !*app.state::<SidebarHidden>().0.lock().unwrap() {
            dock(&win, &settings);
        }
    }
    if autostart_changed {
        apply_autostart(&app, settings.autostart)?;
    }
    app.emit("settings-changed", ()).ok();
    Ok(())
}

// ---------- Calendar ----------

#[derive(Serialize)]
struct MeetingsResult {
    source: &'static str,
    meetings: Vec<calendar::Meeting>,
}

/// Events between two unix timestamps. The frontend picks the window (it knows
/// the local day boundaries); the backend just fetches it.
#[tauri::command]
async fn get_meetings(
    store: State<'_, Store>,
    google: State<'_, Google>,
    from: i64,
    to: i64,
) -> Result<MeetingsResult, String> {
    if !google.connected() {
        return Ok(MeetingsResult { source: "none", meetings: vec![] });
    }
    if to <= from {
        return Err("invalid time range".into());
    }
    let settings = store.settings.lock().unwrap().clone();
    let from = DateTime::<Utc>::from_timestamp(from, 0).ok_or("invalid start time")?;
    let to = DateTime::<Utc>::from_timestamp(to, 0).ok_or("invalid end time")?;
    let meetings = google
        .meetings(&settings.google_client_id, &settings.google_client_secret, from, to)
        .await?;
    Ok(MeetingsResult { source: "google", meetings })
}

#[tauri::command]
fn google_status(google: State<Google>) -> bool {
    google.connected()
}

/// Whether events can be created (Google connected with the write scope).
#[tauri::command]
fn google_can_write(google: State<Google>) -> bool {
    google.connected() && google.can_write()
}

/// Create an event on the primary Google calendar. `start` is unix seconds.
#[tauri::command]
async fn create_event(
    store: State<'_, Store>,
    google: State<'_, Google>,
    title: String,
    start: i64,
    duration_min: i64,
) -> Result<calendar::Meeting, String> {
    if !google.connected() {
        return Err("Connect Google Calendar in Settings to add events.".into());
    }
    let (id, secret) = {
        let s = store.settings.lock().unwrap();
        (s.google_client_id.clone(), s.google_client_secret.clone())
    };
    google
        .create_event(&id, &secret, &title, start, start + duration_min.max(5) * 60)
        .await
}

// ---------- Meeting alert (full-screen overlay) ----------

#[derive(Clone, Serialize, serde::Deserialize)]
struct AlertAction {
    id: String,
    action: String,
    #[serde(default)]
    minutes: u32,
}

/// Cover the monitor the sidebar is on with the alert window and hand it the
/// meeting to display.
#[tauri::command]
fn show_alert(app: AppHandle, meeting: calendar::Meeting) {
    let Some(alert) = app.get_webview_window("alert") else { return };
    let monitor = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| alert.primary_monitor().ok().flatten());
    if let Some(mon) = monitor {
        alert.set_position(*mon.position()).ok();
        alert.set_size(*mon.size()).ok();
    }
    alert.show().ok();
    alert.set_always_on_top(true).ok();
    alert.set_focus().ok();
    app.emit_to("alert", "alert-show", meeting).ok();
}

#[tauri::command]
fn hide_alert(app: AppHandle) {
    if let Some(alert) = app.get_webview_window("alert") {
        alert.hide().ok();
    }
}

/// Called by the alert window; hides it and tells the sidebar what happened.
#[tauri::command]
fn alert_action(app: AppHandle, action: AlertAction) {
    hide_alert(app.clone());
    app.emit_to("main", "alert-action", action).ok();
}

#[tauri::command]
async fn google_connect(
    app: AppHandle,
    store: State<'_, Store>,
    google: State<'_, Google>,
) -> Result<(), String> {
    let (id, secret) = {
        let s = store.settings.lock().unwrap();
        (s.google_client_id.clone(), s.google_client_secret.clone())
    };
    let opener = app.opener();
    google
        .connect(&id, &secret, |url| {
            opener.open_url(url, None::<&str>).ok();
        })
        .await?;
    app.emit("settings-changed", ()).ok();
    Ok(())
}

#[tauri::command]
fn google_disconnect(app: AppHandle, google: State<Google>) {
    google.disconnect();
    app.emit("settings-changed", ()).ok();
}

// ---------- Windows ----------

fn dock(win: &WebviewWindow, settings: &Settings) {
    #[cfg(windows)]
    {
        if let Ok(hwnd) = win.hwnd() {
            let scale = win.scale_factor().unwrap_or(1.0);
            let width_px = (settings.width as f64 * scale).round() as i32;
            let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
            unsafe {
                appbar::imp::dock_right(hwnd, width_px, settings.reserve_space);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (win, settings);
    }
}

/// After launch, check a few times whether the shell moved us off the right edge
/// (a stale AppBar strip from a process the installer just killed) and re-dock.
/// `appbar::imp::subclass_proc` handles later notifications; this covers the case
/// where the shell silently drops the stale strip without notifying anyone.
fn schedule_redock_checks(app: AppHandle) {
    #[cfg(windows)]
    {
        std::thread::spawn(move || {
            for delay_ms in [1000u64, 2500, 5000, 10000] {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                let app2 = app.clone();
                app.run_on_main_thread(move || {
                    if *app2.state::<SidebarHidden>().0.lock().unwrap() {
                        return;
                    }
                    if let Some(win) = app2.get_webview_window("main") {
                        if let Ok(hwnd) = win.hwnd() {
                            let hwnd = windows::Win32::Foundation::HWND(hwnd.0);
                            if unsafe { appbar::imp::redock_if_displaced(hwnd) } {
                                eprintln!("[dock] re-docked after displacement");
                                place_tab(&app2);
                            }
                        }
                    }
                })
                .ok();
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

fn undock(win: &WebviewWindow) {
    #[cfg(windows)]
    {
        if let Ok(hwnd) = win.hwnd() {
            unsafe { appbar::imp::undock(windows::Win32::Foundation::HWND(hwnd.0)) }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = win;
    }
}

/// Hide the docked sidebar without going through tao (see `appbar::imp::hide`).
fn hide_native(win: &WebviewWindow) {
    #[cfg(windows)]
    {
        if let Ok(hwnd) = win.hwnd() {
            unsafe { appbar::imp::hide(windows::Win32::Foundation::HWND(hwnd.0)) }
            return;
        }
    }
    win.hide().ok();
}

/// Logical size of the edge tab shown while the sidebar is collapsed.
const TAB_W: f64 = 18.0;
const TAB_H: f64 = 72.0;

/// Pin the collapse tab to the right edge of the sidebar's monitor, vertically centered.
fn place_tab(app: &AppHandle) {
    let (Some(tab), Some(main)) = (app.get_webview_window("tab"), app.get_webview_window("main"))
    else {
        return;
    };
    #[cfg(windows)]
    {
        if let Ok(hwnd) = main.hwnd() {
            let (full, _) = unsafe { appbar::imp::monitor_rects(windows::Win32::Foundation::HWND(hwnd.0)) };
            let scale = tab.scale_factor().unwrap_or(1.0);
            let w = (TAB_W * scale).round() as i32;
            let h = (TAB_H * scale).round() as i32;
            tab.set_size(tauri::PhysicalSize::new(w as u32, h as u32)).ok();
            tab.set_position(tauri::PhysicalPosition::new(
                full.right - w,
                full.top + (full.bottom - full.top - h) / 2,
            ))
            .ok();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = main;
    }
}

fn set_sidebar_visible(app: &AppHandle, visible: bool) {
    let Some(win) = app.get_webview_window("main") else { return };
    *app.state::<SidebarHidden>().0.lock().unwrap() = !visible;
    let tab = app.get_webview_window("tab");
    if visible {
        if let Some(t) = &tab {
            t.hide().ok();
        }
        let s = app.state::<Store>().settings.lock().unwrap().clone();
        // dock() shows the window itself (SWP_SHOWWINDOW); do not call win.show() here.
        dock(&win, &s);
    } else {
        undock(&win);
        hide_native(&win);
        place_tab(app);
        if let Some(t) = &tab {
            t.show().ok();
            t.set_always_on_top(true).ok();
        }
    }
}

#[tauri::command]
fn show_sidebar(app: AppHandle) {
    set_sidebar_visible(&app, true);
}

fn toggle_sidebar(app: &AppHandle) {
    let hidden = *app.state::<SidebarHidden>().0.lock().unwrap();
    set_sidebar_visible(app, hidden);
}

fn toggle_capture(app: &AppHandle) {
    let Some(win) = app.get_webview_window("capture") else { return };
    if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
        win.hide().ok();
        return;
    }
    win.center().ok();
    win.show().ok();
    win.set_focus().ok();
    app.emit_to("capture", "capture-shown", ()).ok();
}

#[tauri::command]
fn hide_capture(app: AppHandle) {
    if let Some(win) = app.get_webview_window("capture") {
        win.hide().ok();
    }
}

#[tauri::command]
fn show_capture(app: AppHandle) {
    toggle_capture(&app);
}

#[tauri::command]
fn hide_sidebar(app: AppHandle) {
    set_sidebar_visible(&app, false);
}

#[tauri::command]
fn redock(app: AppHandle, store: State<Store>) {
    if *app.state::<SidebarHidden>().0.lock().unwrap() {
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        let s = store.settings.lock().unwrap().clone();
        dock(&win, &s);
    }
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    set_sidebar_visible(&app, true);
    app.emit_to("main", "open-settings", ()).ok();
}

/// Store a pasted image under `<data dir>\images\<sha256 prefix>.<ext>` and
/// return its file name, which the row text references as `![](img:<name>)`.
/// The bytes arrive as the raw IPC body (no JSON round trip); the extension
/// comes in the `x-ext` header. Pasting the same image twice reuses one file.
#[tauri::command]
fn save_image(store: State<Store>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    use sha2::Digest;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        _ => return Err("save_image expects raw bytes".into()),
    };
    if bytes.is_empty() {
        return Err("The clipboard image was empty".into());
    }
    let ext = request
        .headers()
        .get("x-ext")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_start_matches('.').to_ascii_lowercase())
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or_else(|| "png".into());
    let hash = sha2::Sha256::digest(bytes);
    let name = format!("{}.{ext}", hash.iter().take(10).map(|b| format!("{b:02x}")).collect::<String>());
    let dir = store.dir.join("images");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create the images folder: {e}"))?;
    let path = dir.join(&name);
    if !path.exists() {
        let tmp = dir.join(format!("{name}.tmp"));
        std::fs::write(&tmp, bytes).map_err(|e| format!("Could not save the image: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("Could not save the image: {e}"))?;
    }
    Ok(name)
}

/// Absolute folder that holds pasted images, for the frontend to turn names
/// into asset-protocol URLs.
#[tauri::command]
fn image_dir(store: State<Store>) -> String {
    store.dir.join("images").to_string_lossy().into_owned()
}

/// Relay webview errors to stderr so they show up in `tauri dev` output.
#[tauri::command]
fn log_js(window: tauri::Window, msg: String) {
    eprintln!("[js:{}] {msg}", window.label());
}

#[tauri::command]
fn quit(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        undock(&win);
    }
    app.exit(0);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Show / hide sidebar", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "Capture task\tCtrl+Space", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Deskpad", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&toggle, &capture, &settings, &PredefinedMenuItem::separator(app)?, &quit_item],
    )?;
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Deskpad")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => toggle_sidebar(app),
            "capture" => toggle_capture(app),
            "settings" => open_settings(app.clone()),
            "quit" => quit(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_sidebar(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Same location Tauri's `app_data_dir()` resolves to on Windows
/// (`%APPDATA%\<identifier>`), computed without an AppHandle so the store can
/// be managed before any window exists.
fn app_data_dir(identifier: &str) -> std::path::PathBuf {
    std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(identifier)
}

/// Deskpad is not a packaged (MSIX) app, but when it is started from inside a
/// packaged app's process tree (a terminal embedded in such an app, or an
/// installer run from one) Windows applies that package's file-system
/// redirection to it: writes under `%APPDATA%` and `%LOCALAPPDATA%` land in
/// `%LOCALAPPDATA%\Packages\<pkg>\LocalCache\{Roaming,Local}` and reads prefer
/// that copy. Deskpad then works on a private fork of `tasks.json` that the
/// normally launched app never sees; one such run made the outline appear to
/// revert. The redirection is applied even when the process reports no
/// package identity, so this detects it behaviourally: write a probe file
/// into the data dir and look for it under every package's `LocalCache`.
/// Returns the package folder name when redirected.
#[cfg(windows)]
fn hosting_package(dir: &std::path::Path) -> Option<String> {
    use std::fs;
    let local = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)?;
    let ident = dir.file_name()?.to_owned();
    fs::create_dir_all(dir).ok()?;
    let name = format!(".sandbox-probe-{}", std::process::id());
    let probe = dir.join(&name);
    fs::write(&probe, b"probe").ok()?;
    let found = fs::read_dir(local.join("Packages"))
        .ok()
        .and_then(|rd| {
            rd.flatten()
                .find(|e| e.path().join("LocalCache").join("Roaming").join(&ident).join(&name).exists())
                .map(|e| e.file_name().to_string_lossy().into_owned())
        });
    fs::remove_file(&probe).ok();
    found
}

#[cfg(not(windows))]
fn hosting_package(_dir: &std::path::Path) -> Option<String> {
    None
}

/// Refuse to run with redirected app data (see `hosting_package`). Shows a
/// native message box because no webview exists yet.
fn refuse_if_sandboxed(dir: &std::path::Path) {
    let Some(pkg) = hosting_package(dir) else { return };
    let msg = format!(
        "Deskpad was started from inside another app's sandbox:\n\n{pkg}\n\nWindows would redirect its data folder to that app's private cache, so your notes and settings would not be the ones the normally launched Deskpad uses.\n\nStart Deskpad from the Start menu or Explorer instead."
    );
    eprintln!("[startup] refusing to run under package {pkg}");
    #[cfg(windows)]
    unsafe {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        MessageBoxW(None, &HSTRING::from(msg.as_str()), &HSTRING::from("Deskpad"), MB_OK | MB_ICONERROR);
    }
    std::process::exit(2);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load persistent state *before* the Builder runs: windows declared in
    // tauri.conf.json are created before the setup hook, and the webview can
    // invoke commands in that gap. State registered inside setup is then not
    // yet managed and every call fails, which once made the UI look wiped.
    let context = tauri::generate_context!();
    let dir = app_data_dir(&context.config().identifier);
    refuse_if_sandboxed(&dir);
    let store = Store::load(dir.clone());
    let google = Google::load(&dir);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let target = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
                    if event.state() == ShortcutState::Pressed && *shortcut == target {
                        toggle_capture(app);
                    }
                })
                .build(),
        )
        .manage(SidebarHidden::default())
        .manage(store)
        .manage(google)
        .setup(|app| {
            if let Ok(resolved) = app.path().app_data_dir() {
                let used = &app.state::<Store>().dir;
                if &resolved != used {
                    eprintln!("[store] warning: using {} but Tauri resolves {}", used.display(), resolved.display());
                }
            }
            let settings = app.state::<Store>().settings.lock().unwrap().clone();
            sync_autostart_on_launch(app.handle(), settings.autostart);

            if let Some(win) = app.get_webview_window("main") {
                win.set_always_on_top(settings.always_on_top).ok();
                dock(&win, &settings);
                win.show().ok();
                schedule_redock_checks(app.handle().clone());
            }

            build_tray(app.handle())?;

            if let Err(e) = app.global_shortcut().register(CAPTURE_SHORTCUT) {
                eprintln!("failed to register {CAPTURE_SHORTCUT}: {e}");
                app.emit("shortcut-error", e.to_string()).ok();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::WindowEvent;
            match event {
                WindowEvent::Focused(false) if window.label() == "capture" => {
                    window.hide().ok();
                }
                WindowEvent::CloseRequested { api, .. } if window.label() == "journal" => {
                    // Keep the window around so reopening is instant.
                    api.prevent_close();
                    window.hide().ok();
                }
                WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                    // Closing the sidebar hides it to the tray instead of quitting.
                    api.prevent_close();
                    set_sidebar_visible(window.app_handle(), false);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_items,
            set_items,
            add_item,
            save_image,
            image_dir,
            schedule_item,
            unschedule_item,
            list_archive,
            list_journal,
            record_day_events,
            open_journal,
            show_item,
            archive_items,
            restore_items,
            delete_archived,
            get_settings,
            set_settings,
            get_meetings,
            google_status,
            google_can_write,
            create_event,
            show_alert,
            hide_alert,
            alert_action,
            google_connect,
            google_disconnect,
            hide_capture,
            show_capture,
            hide_sidebar,
            show_sidebar,
            redock,
            open_settings,
            log_js,
            quit
        ])
        .run(context)
        .expect("error while running tauri application");
}
