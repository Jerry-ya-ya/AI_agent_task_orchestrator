#[path = "../../src-native/src/sidecar.rs"]
mod sidecar;

use std::{error::Error, path::PathBuf};
use tauri::{AppHandle, Manager};

pub use sidecar::{Backend, BackendConnection};

pub fn start(app: &AppHandle) -> Result<(Backend, BackendConnection), Box<dyn Error>> {
    let executable = std::env::current_exe()?.with_file_name(if cfg!(windows) {
        "orchestrator-backend.exe"
    } else {
        "orchestrator-backend"
    });
    let worklog = if cfg!(dev) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../worklog.md")
    } else {
        app.path().resource_dir()?.join("worklog.md")
    };
    Backend::start(
        &executable,
        &app.path().app_data_dir()?.join("data"),
        &sidecar::legacy_directory(&app.path().config_dir()?, crate::TITLE),
        &worklog,
    )
}
