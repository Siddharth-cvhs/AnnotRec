//! The recording / annotation state machine and the commands the toolbar
//! calls.
//!
//! Two independent axes, kept apart on purpose:
//!
//! * **Recording**: `Idle → Recording ⇄ Paused → Stopping → Idle`.
//!   Pause really pauses (no frames, no sound, the clock stops).
//! * **Annotation**: `live ⇄ annotating`. Annotating freezes the *picture*
//!   of the page (the overlay shows a snapshot of the viewport and takes
//!   the mouse), but never touches the recorder: video, microphone and the
//!   timer keep running, so the video records the frozen page with the
//!   drawings on it while the user explains. Clear All removes the drawings
//!   and returns to live.
//!
//! The state lives in `Session`; the mutex is never held while a window is
//! touched (window calls hop to the main thread, which may itself be waiting
//! for the mutex in an event handler).

use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalSize, Manager};

use crate::{
    area::{self, Area, Rect},
    audio, layout,
    wgc::Recorder,
};

struct Active {
    recorder: Recorder,
    path: PathBuf,
}

struct Inner {
    rec: Option<Active>,
    paused: bool,
    stopping: bool,
    annotating: bool,
    mic_on: bool,
    mic_name: Option<String>,
    /// Elapsed recording time up to the last pause, and since when it runs.
    base: Duration,
    since: Option<Instant>,
    /// Viewport position held fixed while recording.
    locked: Option<tauri::PhysicalPosition<i32>>,
    last_file: Option<PathBuf>,
    message: Option<String>,
    url: String,
}

pub struct Session(Mutex<Inner>);

impl Session {
    pub fn new() -> Self {
        Self(Mutex::new(Inner {
            rec: None,
            paused: false,
            stopping: false,
            annotating: false,
            mic_on: true,
            // Filled in by `detect_mic` off the main thread: listing the
            // microphones initialises COM as multithreaded, which the
            // window toolkit refuses on the main thread.
            mic_name: None,
            base: Duration::ZERO,
            since: None,
            locked: None,
            last_file: None,
            message: None,
            url: "sample.html".into(),
        }))
    }
}

/// Finds the default microphone's name in the background, for the toolbar.
pub fn detect_mic(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let name = audio::inputs().iter().find(|i| i.default).map(|i| i.name.clone());
        let mut g = lock(&app);
        if g.mic_name.is_none() {
            g.mic_name = name;
        }
        drop(g);
        emit_state(&app);
    });
}

fn lock(app: &AppHandle) -> std::sync::MutexGuard<'_, Inner> {
    let state: tauri::State<'_, Session> = app.state();
    // `inner()` keeps the borrow on the app handle, not on this local.
    state.inner().0.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StateView {
    phase: &'static str,
    annotating: bool,
    mic_on: bool,
    mic_name: Option<String>,
    elapsed_ms: u64,
    last_file: Option<String>,
    message: Option<String>,
    url: String,
    viewport: (u32, u32),
}

fn view(app: &AppHandle) -> StateView {
    let mut v = {
        let g = lock(app);
        let phase = if g.stopping {
            "stopping"
        } else if g.rec.is_none() {
            "idle"
        } else if g.paused {
            "paused"
        } else {
            "recording"
        };
        StateView {
            phase,
            annotating: g.annotating,
            mic_on: g.mic_on,
            mic_name: g.mic_name.clone(),
            elapsed_ms: (g.base + g.since.map(|s| s.elapsed()).unwrap_or_default()).as_millis() as u64,
            last_file: g.last_file.as_ref().map(|p| p.display().to_string()),
            message: g.message.clone(),
            url: g.url.clone(),
            viewport: (0, 0),
        }
    };
    if let Some(w) = app.get_webview_window(layout::VIEWPORT) {
        if let (Ok(size), Ok(scale)) = (w.inner_size(), w.scale_factor()) {
            v.viewport = ((size.width as f64 / scale).round() as u32, (size.height as f64 / scale).round() as u32);
        }
    }
    v
}

fn emit_state(app: &AppHandle) {
    let _ = app.emit_to(layout::TOOLBAR, "state", view(app));
}

fn say(app: &AppHandle, text: impl Into<String>) {
    lock(app).message = Some(text.into());
    emit_state(app);
}

/// The viewport's client area as a recordable area.
fn viewport_area(app: &AppHandle) -> Result<Area, String> {
    let w = app.get_webview_window(layout::VIEWPORT).ok_or("the viewport window is gone")?;
    let pos = w.inner_position().map_err(|e| e.to_string())?;
    let size = w.inner_size().map_err(|e| e.to_string())?;
    area::area_of(Rect { x: pos.x, y: pos.y, width: size.width, height: size.height })
}

fn save_dir(app: &AppHandle, videos: bool) -> Result<PathBuf, String> {
    let base = if videos { app.path().video_dir() } else { app.path().picture_dir() }.map_err(|e| e.to_string())?;
    let dir = base.join("AnnotRec");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn get_state(app: AppHandle) -> StateView {
    view(&app)
}

fn normalize(input: &str) -> Result<url::Url, String> {
    let t = input.trim();
    if t.is_empty() {
        return Err("Enter an address".into());
    }
    let full = if t.contains("://") || t.starts_with("about:") {
        t.to_string()
    } else if t.starts_with("localhost") || t.starts_with("127.") || t.starts_with("[::1]") {
        format!("http://{t}")
    } else {
        format!("https://{t}")
    };
    url::Url::parse(&full).map_err(|_| format!("'{t}' is not a valid address"))
}

#[tauri::command]
pub fn navigate(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = normalize(&url)?;
    let w = app.get_webview_window(layout::VIEWPORT).ok_or("the viewport window is gone")?;
    let target = serde_json::to_string(parsed.as_str()).map_err(|e| e.to_string())?;
    w.eval(format!("window.location.href = {target};")).map_err(|e| e.to_string())?;
    {
        let mut g = lock(&app);
        g.url = parsed.to_string();
        g.message = None;
    }
    emit_state(&app);
    Ok(())
}

#[tauri::command]
pub fn reload(app: AppHandle) -> Result<(), String> {
    let w = app.get_webview_window(layout::VIEWPORT).ok_or("the viewport window is gone")?;
    w.eval("window.location.reload();").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_viewport(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if lock(&app).rec.is_some() {
        return Err("The viewport is locked while recording".into());
    }
    let w = app.get_webview_window(layout::VIEWPORT).ok_or("the viewport window is gone")?;
    w.set_size(LogicalSize::new(width.max(320.0), height.max(240.0))).map_err(|e| e.to_string())?;
    layout::sync_overlay(&app);
    emit_state(&app);
    Ok(())
}

#[tauri::command]
pub fn set_mic(app: AppHandle, on: bool) {
    {
        let mut g = lock(&app);
        g.mic_on = on;
        if let Some(active) = &g.rec {
            active.recorder.controls.muted.store(!on, std::sync::atomic::Ordering::SeqCst);
        }
    }
    emit_state(&app);
}

#[tauri::command]
pub async fn start_recording(app: AppHandle) -> Result<(), String> {
    {
        let g = lock(&app);
        if g.rec.is_some() || g.stopping {
            return Err("Already recording".into());
        }
    }
    let area = viewport_area(&app)?;
    let path = save_dir(&app, true)?.join(format!("recording-{}.mp4", stamp()));
    let inputs = audio::inputs();
    let mut choice = match inputs.iter().find(|i| i.default).or(inputs.first()) {
        Some(i) => audio::Choice { input: Some(i.clone()), default: true, issue: None },
        None => audio::Choice { input: None, default: false, issue: Some(audio::NO_MIC.into()) },
    };
    let p = path.clone();
    let (recorder, choice) = blocking(move || Recorder::start(&area, &p, &mut choice).map(|r| (r, choice))).await??;

    let viewport = app.get_webview_window(layout::VIEWPORT);
    let locked = viewport.as_ref().and_then(|w| w.outer_position().ok());
    if let Some(w) = &viewport {
        let _ = w.set_resizable(false);
    }
    {
        let mut g = lock(&app);
        recorder.controls.muted.store(!g.mic_on, std::sync::atomic::Ordering::SeqCst);
        g.rec = Some(Active { recorder, path });
        g.paused = false;
        g.base = Duration::ZERO;
        g.since = Some(Instant::now());
        g.locked = locked;
        g.mic_name = choice.input.as_ref().map(|i| i.name.clone());
        g.message = choice.issue;
    }
    emit_state(&app);
    Ok(())
}

#[tauri::command]
pub fn pause_recording(app: AppHandle) -> Result<(), String> {
    {
        let mut g = lock(&app);
        let Some(active) = &g.rec else { return Err("Not recording".into()) };
        active.recorder.controls.paused.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(s) = g.since.take() {
            g.base += s.elapsed();
        }
        g.paused = true;
    }
    emit_state(&app);
    Ok(())
}

#[tauri::command]
pub fn resume_recording(app: AppHandle) -> Result<(), String> {
    {
        let mut g = lock(&app);
        let Some(active) = &g.rec else { return Err("Not recording".into()) };
        active.recorder.controls.paused.store(false, std::sync::atomic::Ordering::SeqCst);
        g.since = Some(Instant::now());
        g.paused = false;
    }
    emit_state(&app);
    Ok(())
}

/// Ends the recording and writes the MP4. Returns the file.
async fn finish(app: &AppHandle) -> Result<PathBuf, String> {
    let active = {
        let mut g = lock(app);
        let a = g.rec.take().ok_or("Not recording")?;
        g.stopping = true;
        g.paused = false;
        g.base = Duration::ZERO;
        g.since = None;
        a
    };
    emit_state(app);
    let Active { recorder, path } = active;
    let result = blocking(move || recorder.stop(Duration::from_secs(20))).await;
    if let Some(w) = app.get_webview_window(layout::VIEWPORT) {
        let _ = w.set_resizable(true);
    }
    let outcome = match result {
        Ok(Ok(())) => Ok(path.clone()),
        Ok(Err(e)) | Err(e) => Err(e),
    };
    {
        let mut g = lock(app);
        g.stopping = false;
        g.locked = None;
        match &outcome {
            Ok(p) => {
                g.last_file = Some(p.clone());
                g.message = Some("Saved. Your MP4 is ready.".into());
            }
            Err(e) => g.message = Some(format!("The recording failed: {e}")),
        }
    }
    emit_state(app);
    outcome
}

#[tauri::command]
pub async fn stop_recording(app: AppHandle) -> Result<(), String> {
    finish(&app).await.map(|_| ())
}

/// Stops a running recording (finalising the file), then exits.
pub fn shutdown(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if lock(&app).rec.is_some() {
            let _ = finish(&app).await;
        }
        app.exit(0);
    });
}

/// The viewport moved: while recording it snaps back so the recorded
/// rectangle stays put; the overlay follows it either way.
pub fn on_viewport_moved(app: &AppHandle) {
    let locked = lock(app).locked;
    if let (Some(pos), Some(w)) = (locked, app.get_webview_window(layout::VIEWPORT)) {
        if w.outer_position().ok() != Some(pos) {
            let _ = w.set_position(pos);
        }
    }
    layout::sync_overlay(app);
}

#[tauri::command]
pub async fn take_screenshot(app: AppHandle) -> Result<(), String> {
    let area = viewport_area(&app)?;
    let dir = save_dir(&app, false)?;
    let png = blocking(move || area::capture_png(&area)).await??;
    let path = dir.join(format!("screenshot-{}.png", stamp()));
    std::fs::write(&path, png).map_err(|e| format!("cannot save the screenshot: {e}"))?;
    say(&app, format!("Screenshot saved: {}", path.display()));
    Ok(())
}

// -------------------------------------------------------------- annotation

/// Freezes the picture of the page: snapshot the viewport, hand it to the
/// overlay as its backdrop and let the overlay take the mouse. The recorder
/// is not involved.
async fn begin_annotation(app: &AppHandle) -> Result<(), String> {
    {
        let mut g = lock(app);
        if g.annotating {
            return Ok(());
        }
        g.annotating = true;
    }
    let result = async {
        let area = viewport_area(app)?;
        let png = blocking(move || area::capture_png(&area)).await??;
        let image = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png));
        let overlay = app.get_webview_window(layout::OVERLAY).ok_or("the overlay window is gone")?;
        app.emit_to(layout::OVERLAY, "freeze", serde_json::json!({ "image": image })).map_err(|e| e.to_string())?;
        overlay.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;
        let _ = overlay.set_focus();
        Ok::<(), String>(())
    }
    .await;
    if result.is_err() {
        lock(app).annotating = false;
    }
    emit_state(app);
    result
}

/// `live` leaves annotation mode (same as Clear All); any other tool
/// freezes the page, if it is not frozen yet, and selects that tool.
#[tauri::command]
pub async fn set_tool(app: AppHandle, tool: String) -> Result<(), String> {
    if tool == "live" {
        return clear_all(app).await;
    }
    begin_annotation(&app).await?;
    app.emit_to(layout::OVERLAY, "overlay-cmd", serde_json::json!({ "type": "tool", "tool": tool }))
        .map_err(|e| e.to_string())
}

/// Undo, redo, colour, width: forwarded to the overlay.
#[tauri::command]
pub fn overlay_cmd(app: AppHandle, cmd: serde_json::Value) -> Result<(), String> {
    app.emit_to(layout::OVERLAY, "overlay-cmd", cmd).map_err(|e| e.to_string())
}

/// Removes every drawing, drops the frozen picture and gives the mouse back
/// to the live page. Recording, microphone and timer are untouched.
#[tauri::command]
pub async fn clear_all(app: AppHandle) -> Result<(), String> {
    app.emit_to(layout::OVERLAY, "clear-all", ()).map_err(|e| e.to_string())?;
    if let Some(overlay) = app.get_webview_window(layout::OVERLAY) {
        overlay.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
    }
    lock(&app).annotating = false;
    if let Some(w) = app.get_webview_window(layout::VIEWPORT) {
        let _ = w.set_focus();
    }
    emit_state(&app);
    Ok(())
}

#[tauri::command]
pub fn open_folder(app: AppHandle) -> Result<(), String> {
    let last = lock(&app).last_file.clone();
    let mut cmd = std::process::Command::new("explorer");
    match last {
        Some(p) => cmd.arg(format!("/select,{}", p.display())),
        None => cmd.arg(save_dir(&app, true)?),
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}
