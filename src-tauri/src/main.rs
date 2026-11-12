#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use backend::{Backend, BackendConnection};
use serde::Deserialize;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};
use tauri::{
    image::Image, webview::NewWindowResponse, AppHandle, Manager, PhysicalPosition, RunEvent,
    State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const TITLE: &str = "AI Agent Task Orchestrator";
const DEV_HOST: &str = "127.0.0.1";
const DETACHED_SIZE: (f64, f64) = (1180.0, 780.0);

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AppIcon {
    #[default]
    Original,
    Violet,
    Ember,
    Frost,
}

impl AppIcon {
    fn bytes(self) -> &'static [u8] {
        match self {
            Self::Original => include_bytes!("../../src/frontend/public/icon.png"),
            Self::Violet => include_bytes!("../../src/frontend/public/icon-violet.png"),
            Self::Ember => include_bytes!("../../src/frontend/public/icon-ember.png"),
            Self::Frost => include_bytes!("../../src/frontend/public/icon-frost.png"),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Page {
    Features,
    Taskboard,
    History,
    Worklog,
    Settings,
    Frontend,
}

impl Page {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Features => "features",
            Self::Taskboard => "taskboard",
            Self::History => "history",
            Self::Worklog => "worklog",
            Self::Settings => "settings",
            Self::Frontend => "frontend",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenPageRequest {
    page: Page,
    connection_id: Option<uuid::Uuid>,
    screen_x: f64,
    screen_y: f64,
}

#[tauri::command]
fn desktop_connection(connection: State<'_, BackendConnection>) -> BackendConnection {
    connection.inner().clone()
}

#[tauri::command]
async fn choose_repository(window: WebviewWindow, suggested_path: String) -> Option<String> {
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose a local Git repository");
    let suggestion = Path::new(suggested_path.trim());
    if let Some(directory) = suggestion
        .ancestors()
        .find(|path| path.is_absolute() && path.is_dir())
    {
        dialog = dialog.set_directory(directory);
    }
    dialog.blocking_pick_folder().and_then(|path| {
        path.into_path()
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    })
}

#[tauri::command]
async fn set_window_icon(app: AppHandle, icon: AppIcon) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let image = Image::from_bytes(icon.bytes()).map_err(|error| error.to_string())?;
        for window in app.webview_windows().values() {
            window
                .set_icon(image.clone())
                .map_err(|error| error.to_string())?;
        }
    }
    #[cfg(target_os = "macos")]
    app.run_on_main_thread(move || {
        use objc2::{AllocAnyThread, MainThreadMarker};
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::NSData;

        if let Some(marker) = MainThreadMarker::new() {
            let data = NSData::with_bytes(icon.bytes());
            if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
                let app = NSApplication::sharedApplication(marker);
                // AppKit requires this call to run on the main thread.
                unsafe { app.setApplicationIconImage(Some(&image)) };
            }
        }
    })
    .map_err(|error| error.to_string())?;
    *app.state::<Mutex<AppIcon>>().lock().unwrap() = icon;
    Ok(())
}

#[tauri::command]
async fn open_page(
    app: AppHandle,
    window: WebviewWindow,
    request: OpenPageRequest,
    counter: State<'_, AtomicUsize>,
) -> Result<(), String> {
    if matches!(request.page, Page::Frontend) != request.connection_id.is_some()
        || !request.screen_x.is_finite()
        || !request.screen_y.is_finite()
    {
        return Err("Invalid detached page".into());
    }

    let position = detached_position(&window, &request);
    let label = format!("page-{}", counter.fetch_add(1, Ordering::Relaxed));
    let detached = create_window(&app, &label, request.page, request.connection_id)
        .map_err(|error| error.to_string())?;
    if let Some(position) = position {
        let _ = detached.set_position(position);
    }
    detached.show().map_err(|error| error.to_string())?;
    detached.set_focus().map_err(|error| error.to_string())
}

fn detached_position(
    window: &WebviewWindow,
    request: &OpenPageRequest,
) -> Option<PhysicalPosition<i32>> {
    let cursor = window.cursor_position().unwrap_or_else(|_| {
        let scale = window.scale_factor().unwrap_or(1.0);
        PhysicalPosition::new(request.screen_x * scale, request.screen_y * scale)
    });
    let monitor = window
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (width, height) = DETACHED_SIZE;
    let clamp = |cursor: f64, offset: f64, start: i32, available: u32, size: f64| {
        let start = f64::from(start);
        (cursor - offset * scale)
            .clamp(
                start,
                start + (f64::from(available) - size * scale).max(0.0),
            )
            .round() as i32
    };
    Some(PhysicalPosition::new(
        clamp(cursor.x, 48.0, area.position.x, area.size.width, width),
        clamp(cursor.y, 32.0, area.position.y, area.size.height, height),
    ))
}

fn create_window(
    app: &AppHandle,
    label: &str,
    page: Page,
    connection_id: Option<uuid::Uuid>,
) -> tauri::Result<WebviewWindow> {
    // Page and connection ID are typed, so only the app's own URL can be built.
    let mut path = format!("index.html?page={}", page.as_str());
    if let Some(id) = connection_id {
        path.push_str(&format!("&connectionId={id}"));
    }
    let (width, height) = if label == "main" {
        (1440.0, 900.0)
    } else {
        DETACHED_SIZE
    };
    let opener = app.clone();
    let icon = *app.state::<Mutex<AppIcon>>().lock().unwrap();
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(path.into()))
        .title(TITLE)
        .inner_size(width, height)
        .min_inner_size(980.0, 680.0)
        .decorations(false)
        .visible(false)
        .icon(Image::from_bytes(icon.bytes())?)?
        .on_navigation(|url| {
            matches!(url.host_str(), Some("localhost")) && url.scheme() == "tauri"
                || url.host_str() == Some("tauri.localhost") && url.scheme() == "http"
                || cfg!(dev)
                    && url.scheme() == "http"
                    && url.host_str() == Some(DEV_HOST)
                    && url.port() == Some(4300)
        })
        .on_new_window(move |url, _| {
            if url.scheme() == "https" {
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .build()
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let window = app
                .get_webview_window("main")
                .or_else(|| app.webview_windows().into_values().next());
            if let Some(window) = window {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(AppIcon::default()))
        .manage(AtomicUsize::new(1))
        .invoke_handler(tauri::generate_handler![
            desktop_connection,
            choose_repository,
            open_page,
            set_window_icon
        ])
        .setup(|app| {
            match Backend::start(app.handle()) {
                Ok((backend, connection)) => {
                    app.manage(Mutex::new(Some(backend)));
                    app.manage(connection);
                    create_window(app.handle(), "main", Page::Taskboard, None)?.show()?;
                }
                Err(error) => {
                    let handle = app.handle().clone();
                    app.dialog()
                        .message(error.to_string())
                        .title(format!("{TITLE} failed to start"))
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .show(move |_| handle.exit(1));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build the desktop app");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(backend) = app.try_state::<Mutex<Option<Backend>>>() {
                drop(backend.lock().unwrap().take());
            }
        }
    });
}
