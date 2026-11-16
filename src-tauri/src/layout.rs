//! The three windows and how they stay together.
//!
//! * `viewport`: the live page being shown (an embedded WebView2, i.e. the
//!   Edge engine). Its inner (client) area is the recorded rectangle.
//! * `overlay`: a transparent, borderless, always-on-top window sitting
//!   exactly on the viewport's client area. In live mode it is click-through
//!   (the page gets the mouse); in annotation mode it takes the mouse and
//!   shows the frozen picture of the page with the drawings on top. Because
//!   the recorder captures the screen, whatever the overlay shows lands in
//!   the video.
//! * `toolbar`: the controls, beside the viewport. Excluded from screen
//!   capture, so it never appears in the video even if dragged over it.

use tauri::{
    AppHandle, Manager, PhysicalSize, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

use crate::session;

pub const VIEWPORT: &str = "viewport";
pub const OVERLAY: &str = "overlay";
pub const TOOLBAR: &str = "toolbar";

const TOOLBAR_WIDTH: f64 = 340.0;
const MARGIN: f64 = 24.0;

pub fn create_windows(app: &AppHandle) -> tauri::Result<()> {
    // Size the viewport to the primary monitor, leaving room for the toolbar.
    let (mon_w, mon_h) = match app.primary_monitor()? {
        Some(m) => {
            let s = m.scale_factor();
            (m.size().width as f64 / s, m.size().height as f64 / s)
        }
        None => (1536.0, 864.0),
    };
    let vp_w = (mon_w - TOOLBAR_WIDTH - MARGIN * 3.0).clamp(640.0, 1400.0).floor();
    let vp_h = (mon_h - MARGIN * 2.0 - 60.0).clamp(420.0, 860.0).floor();

    let viewport = WebviewWindowBuilder::new(app, VIEWPORT, WebviewUrl::App("sample.html".into()))
        .title("AnnotRec viewport (the recorded area is inside this window)")
        .inner_size(vp_w, vp_h)
        .position(MARGIN, MARGIN)
        .resizable(true)
        .build()?;

    let overlay = WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("index.html?window=overlay".into()))
        .title("AnnotRec overlay")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .inner_size(vp_w, vp_h)
        .build()?;
    overlay.set_ignore_cursor_events(true)?;
    sync_overlay(app);

    let toolbar = WebviewWindowBuilder::new(app, TOOLBAR, WebviewUrl::App("index.html?window=toolbar".into()))
        .title("AnnotRec")
        .inner_size(TOOLBAR_WIDTH, (mon_h - MARGIN * 2.0 - 60.0).clamp(520.0, 820.0))
        .position(MARGIN * 2.0 + vp_w, MARGIN)
        .resizable(false)
        .maximizable(false)
        .always_on_top(true)
        // WDA_EXCLUDEFROMCAPTURE: the toolbar is never in the recording.
        .content_protected(true)
        .build()?;

    let handle = app.clone();
    viewport.on_window_event(move |event| match event {
        WindowEvent::Moved(_) => session::on_viewport_moved(&handle),
        WindowEvent::Resized(_) => sync_overlay(&handle),
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            session::shutdown(&handle);
        }
        _ => {}
    });
    let handle = app.clone();
    toolbar.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            session::shutdown(&handle);
        }
    });
    Ok(())
}

/// Puts the overlay exactly on the viewport's client area.
pub fn sync_overlay<R: Runtime>(app: &AppHandle<R>) {
    let (Some(viewport), Some(overlay)) = (app.get_webview_window(VIEWPORT), app.get_webview_window(OVERLAY)) else {
        return;
    };
    if let (Ok(pos), Ok(size)) = (viewport.inner_position(), viewport.inner_size()) {
        let _ = overlay.set_size(PhysicalSize::new(size.width, size.height));
        let _ = overlay.set_position(pos);
    }
}
