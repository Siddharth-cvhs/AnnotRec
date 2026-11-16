//! AnnotRec: a screen recorder with live annotation. See `layout` for the
//! window model and `session` for the recording / annotation state machine.

pub mod area;
pub mod audio;
mod layout;
mod session;
pub mod wgc;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(session::Session::new());
            layout::create_windows(app.handle())?;
            session::detect_mic(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            session::get_state,
            session::navigate,
            session::reload,
            session::set_viewport,
            session::set_mic,
            session::start_recording,
            session::pause_recording,
            session::resume_recording,
            session::stop_recording,
            session::take_screenshot,
            session::set_tool,
            session::overlay_cmd,
            session::clear_all,
            session::open_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AnnotRec");
}
