use crate::model::Connection;
use eframe::egui;

pub fn allowed(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            && url.username().is_empty()
            && url.password().is_none()
    })
}

pub fn open_external(connection: &Connection) -> Result<(), String> {
    if !allowed(&connection.url) {
        return Err("Only loopback HTTP and HTTPS URLs are supported.".into());
    }
    open::that_detached(&connection.url).map_err(|error| error.to_string())
}

pub struct Preview {
    #[cfg(any(windows, target_os = "macos"))]
    view: Option<wry::WebView>,
    #[cfg(windows)]
    context: wry::WebContext,
    #[cfg(any(windows, target_os = "macos"))]
    url: String,
    #[cfg(any(windows, target_os = "macos"))]
    rect: Option<egui::Rect>,
    #[cfg(any(windows, target_os = "macos"))]
    visible: bool,
}

impl Preview {
    pub fn new(_home: &std::path::Path) -> Self {
        Self {
            #[cfg(any(windows, target_os = "macos"))]
            view: None,
            #[cfg(windows)]
            context: wry::WebContext::new(Some(_home.join("preview-data"))),
            #[cfg(any(windows, target_os = "macos"))]
            url: String::new(),
            #[cfg(any(windows, target_os = "macos"))]
            rect: None,
            #[cfg(any(windows, target_os = "macos"))]
            visible: false,
        }
    }

    pub fn available() -> bool {
        cfg!(any(windows, target_os = "macos"))
    }

    pub fn show(
        &mut self,
        frame: &eframe::Frame,
        url: &str,
        rect: egui::Rect,
    ) -> Result<(), String> {
        if !allowed(url) {
            return Err("Only loopback HTTP and HTTPS URLs are supported.".into());
        }
        #[cfg(any(windows, target_os = "macos"))]
        {
            use wry::dpi::{LogicalPosition, LogicalSize};
            let bounds = wry::Rect {
                position: LogicalPosition::new(rect.min.x, rect.min.y).into(),
                size: LogicalSize::new(rect.width().max(1.0), rect.height().max(1.0)).into(),
            };
            if let Some(view) = &self.view {
                if self.rect != Some(rect) {
                    view.set_bounds(bounds).map_err(|error| error.to_string())?;
                }
                if self.url != url {
                    view.load_url(url).map_err(|error| error.to_string())?;
                }
                if !self.visible {
                    view.set_visible(true).map_err(|error| error.to_string())?;
                }
            } else {
                #[cfg(windows)]
                let builder = wry::WebViewBuilder::new_with_web_context(&mut self.context);
                #[cfg(target_os = "macos")]
                let builder = wry::WebViewBuilder::new();
                self.view = Some(
                    builder
                        .with_url(url)
                        .with_bounds(bounds)
                        .with_navigation_handler(allowed_url)
                        .with_new_window_req_handler(|url, _| {
                            if url::Url::parse(&url).is_ok_and(|target| target.scheme() == "https")
                            {
                                let _ = open::that_detached(url);
                            }
                            wry::NewWindowResponse::Deny
                        })
                        .build_as_child(frame)
                        .map_err(|error| error.to_string())?,
                );
            }
            self.url = url.into();
            self.rect = Some(rect);
            self.visible = true;
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = (frame, rect);
        Ok(())
    }

    pub fn hide(&mut self) {
        #[cfg(any(windows, target_os = "macos"))]
        if self.visible {
            if let Some(view) = &self.view {
                let _ = view.set_visible(false);
            }
        }
        #[cfg(any(windows, target_os = "macos"))]
        {
            self.visible = false;
        }
    }

    pub fn reload(&self) -> Result<(), String> {
        #[cfg(any(windows, target_os = "macos"))]
        if let Some(view) = &self.view {
            return view.load_url(&self.url).map_err(|error| error.to_string());
        }
        Ok(())
    }
}

pub fn detach(connection: &Connection) -> Result<(), String> {
    if !allowed(&connection.url) {
        return Err("Only loopback HTTP and HTTPS URLs are supported.".into());
    }
    if !Preview::available() {
        return open_external(connection);
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut child = std::process::Command::new(executable)
        .args(["--frontend-preview", &connection.url, &connection.name])
        .spawn()
        .map_err(|error| error.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

pub fn run_detached(url: String, title: String) -> Result<(), Box<dyn std::error::Error>> {
    if !allowed(&url) {
        return Err("Only loopback HTTP and HTTPS URLs are supported.".into());
    }
    if !Preview::available() {
        open::that_detached(url)?;
        return Ok(());
    }
    let home = crate::desktop_home()?;
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title(format!("{title} · Agentboard"))
            .with_inner_size([1090.0, 720.0])
            .with_icon(crate::app::icon(0)),
        ..Default::default()
    };
    eframe::run_native(
        "agentboard-preview",
        options,
        Box::new(move |cc| {
            crate::app::theme(&cc.egui_ctx, 0);
            Ok(Box::new(DetachedPreview {
                title,
                url,
                preview: Preview::new(&home),
                error: None,
            }))
        }),
    )?;
    Ok(())
}

struct DetachedPreview {
    title: String,
    url: String,
    preview: Preview,
    error: Option<String>,
}

impl eframe::App for DetachedPreview {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.heading(&self.title);
                if ui.button("Reload").clicked() {
                    self.error = self.preview.reload().err();
                }
                if ui.button("Open in browser").clicked() {
                    self.error = open::that_detached(&self.url)
                        .err()
                        .map(|error| error.to_string());
                }
            });
            ui.monospace(&self.url);
            if let Some(error) = &self.error {
                ui.colored_label(egui::Color32::LIGHT_RED, error);
            }
            let (rect, _) = ui.allocate_exact_size(
                ui.available_size().max(egui::Vec2::splat(1.0)),
                egui::Sense::hover(),
            );
            if let Err(error) = self.preview.show(frame, &self.url, rect) {
                self.error = Some(error);
            }
        });
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn allowed_url(url: String) -> bool {
    allowed(&url)
}

#[cfg(test)]
mod tests {
    #[test]
    fn preview_restricts_top_level_navigation_to_local_http() {
        for url in [
            "http://127.0.0.1:4300",
            "https://localhost:3000/app",
            "http://[::1]:8080",
        ] {
            assert!(super::allowed(url), "{url}");
        }
        for url in [
            "file:///c:/work",
            "http://localhost.example.org",
            "http://x@localhost",
            "https://example.org",
        ] {
            assert!(!super::allowed(url), "{url}");
        }
    }
}
