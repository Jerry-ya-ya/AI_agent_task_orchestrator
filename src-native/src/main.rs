#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod app;
mod dialogs;
mod graph;
mod memory;
mod model;
mod pages;
mod preview;
mod sidecar;

use eframe::egui;
use std::{error::Error, io, path::PathBuf};

const TITLE: &str = "AI Agent Task Orchestrator";
const APP_ID: &str = "dev.local.ai-agent-task-orchestrator";

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        rfd::MessageDialog::new()
            .set_title(TITLE)
            .set_level(rfd::MessageLevel::Error)
            .set_description(error.to_string())
            .show();
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    if let [mode, url, title] = arguments.as_slice() {
        if mode == "--frontend-preview" {
            return preview::run_detached(url.clone(), title.clone());
        }
    }
    let folder = std::env::current_exe()?
        .parent()
        .ok_or_else(|| io::Error::other("Missing executable directory"))?
        .to_owned();
    let executable = std::env::var_os("ORCHESTRATOR_SIDECAR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            folder.join(if cfg!(windows) {
                "orchestrator-backend.exe"
            } else {
                "orchestrator-backend"
            })
        });
    let worklog = std::env::var_os("ORCHESTRATOR_WORKLOG")
        .map(PathBuf::from)
        .unwrap_or_else(|| folder.join("worklog.md"));
    let isolated = std::env::var_os("ORCHESTRATOR_DESKTOP_DATA_DIR").map(PathBuf::from);
    let home = desktop_home()?;
    let legacy = if isolated.is_some() {
        home.join("legacy")
    } else {
        sidecar::legacy_directory(
            &dirs::config_dir()
                .ok_or_else(|| io::Error::other("No user configuration directory"))?,
            TITLE,
        )
    };
    let (_backend, connection) =
        sidecar::Backend::start(&executable, &home.join("data"), &legacy, &worklog)?;
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Agentboard")
            .with_inner_size([1400.0, 880.0])
            .with_min_inner_size([880.0, 600.0])
            .with_decorations(false)
            .with_icon(app::icon(0)),
        ..Default::default()
    };
    eframe::run_native(
        APP_ID,
        options,
        Box::new(move |cc| Ok(Box::new(app::Agentboard::new(cc, connection, home)))),
    )?;
    Ok(())
}

fn desktop_home() -> io::Result<PathBuf> {
    if let Some(path) = std::env::var_os("ORCHESTRATOR_DESKTOP_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    dirs::data_dir()
        .map(|path| path.join(APP_ID))
        .ok_or_else(|| io::Error::other("No application data directory"))
}
