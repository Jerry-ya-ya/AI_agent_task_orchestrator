use crate::{
    api::{Api, Board, Data, Job, Load, Mutation, Reply},
    dialogs::Dialog,
    graph::GraphView,
    memory::{self, format_memory, MemoryUsage},
    model::*,
    preview::Preview,
    sidecar::BackendConnection,
};
use eframe::egui::{self, Color32, RichText, Vec2};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    time::{Duration, Instant},
};

pub const BG: Color32 = Color32::from_rgb(14, 19, 29);
pub const PANEL: Color32 = Color32::from_rgb(22, 29, 42);
pub const CARD: Color32 = Color32::from_rgb(29, 38, 53);
pub const MUTED: Color32 = Color32::from_rgb(156, 172, 195);
const EXPAND_NAVIGATION_ICON: egui::ImageSource<'static> =
    egui::include_image!("../icons/expand.svg");
pub const THEMES: [(&str, Color32); 5] = [
    ("Midnight", Color32::from_rgb(111, 156, 255)),
    ("Ocean", Color32::from_rgb(71, 209, 200)),
    ("Violet", Color32::from_rgb(188, 144, 255)),
    ("Ember", Color32::from_rgb(255, 150, 103)),
    ("Frost", Color32::from_rgb(152, 201, 233)),
];
pub const ICONS: [(&str, &[u8]); 4] = [
    (
        "Original",
        include_bytes!("../../src/frontend/public/icon.png"),
    ),
    (
        "Violet",
        include_bytes!("../../src/frontend/public/icon-violet.png"),
    ),
    (
        "Ember",
        include_bytes!("../../src/frontend/public/icon-ember.png"),
    ),
    (
        "Frost",
        include_bytes!("../../src/frontend/public/icon-frost.png"),
    ),
];

#[derive(Clone, Debug, PartialEq)]
pub enum Page {
    Board,
    Features,
    History,
    Worklog,
    Settings,
    Connections,
    Frontend(String),
}

impl Page {
    fn navigation_icon(&self) -> egui::ImageSource<'static> {
        match self {
            Self::Board => egui::include_image!("../icons/taskboard.svg"),
            Self::Features => egui::include_image!("../icons/features.svg"),
            Self::History => egui::include_image!("../icons/history.svg"),
            Self::Worklog => egui::include_image!("../icons/worklog.svg"),
            Self::Connections => egui::include_image!("../icons/connections.svg"),
            Self::Settings => egui::include_image!("../icons/settings.svg"),
            Self::Frontend(_) => egui::include_image!("../icons/frontend.svg"),
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Board => "Taskboard",
            Self::Features => "Features",
            Self::History => "Task history",
            Self::Worklog => "Update log",
            Self::Settings => "Settings",
            Self::Connections => "Frontend connections",
            Self::Frontend(_) => "Frontend preview",
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub theme: usize,
    pub icon: usize,
    pub project: Option<Id>,
    pub zoom_speed: HashMap<Id, u8>,
    worker_paused: Option<bool>,
    quota_loop: bool,
    compact: bool,
}

pub struct Agentboard {
    api: Api,
    pub board: Board,
    pub details: HashMap<Id, Detail>,
    pub models: Vec<Model>,
    pub branches: Vec<BranchMap>,
    usage: Option<Usage>,
    memory: Option<MemoryUsage>,
    memory_samples: std::sync::mpsc::Receiver<Option<MemoryUsage>>,
    usage_menu_open: bool,
    pub worklog: Option<String>,
    page: Page,
    detached: Vec<(u64, Page)>,
    sequence: u64,
    pub dialog: Option<(egui::ViewportId, Dialog)>,
    pub close_dialog_on_success: bool,
    pub graph: GraphView,
    pub preview: Preview,
    pub preview_slot: Option<(String, egui::Rect)>,
    pub preferences: Preferences,
    preferences_path: PathBuf,
    pub icons: Vec<egui::TextureHandle>,
    pub requests: HashSet<Load>,
    pub busy: bool,
    connected: bool,
    pub error: Option<String>,
    notice: Option<(String, Instant)>,
    restore_preferences: bool,
    last_board: Instant,
    last_usage: Instant,
    last_branches: Instant,
    pub history_query: String,
}

impl Agentboard {
    pub fn new(
        cc: &eframe::CreationContext<'_>,
        connection: BackendConnection,
        home: PathBuf,
    ) -> Self {
        let preferences_path = home.join("native-preferences.json");
        let mut preferences: Preferences = std::fs::read(&preferences_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        preferences.theme = preferences.theme.min(THEMES.len() - 1);
        preferences.icon = preferences.icon.min(ICONS.len() - 1);
        install_fonts(&cc.egui_ctx);
        egui_extras::install_image_loaders(&cc.egui_ctx);
        theme(&cc.egui_ctx, preferences.theme);
        cc.egui_ctx
            .send_viewport_cmd(egui::ViewportCommand::Icon(Some(icon(preferences.icon))));
        let icons = ICONS
            .iter()
            .enumerate()
            .map(|(index, (name, _))| {
                let image = icon(index);
                cc.egui_ctx.load_texture(
                    *name,
                    egui::ColorImage::from_rgba_unmultiplied(
                        [image.width as usize, image.height as usize],
                        &image.rgba,
                    ),
                    egui::TextureOptions::LINEAR,
                )
            })
            .collect();
        let mut app = Self {
            api: Api::spawn(connection, cc.egui_ctx.clone()),
            board: Board::default(),
            details: HashMap::new(),
            models: fallback_models(),
            branches: Vec::new(),
            usage: None,
            memory: None,
            memory_samples: memory::monitor(cc.egui_ctx.clone()),
            usage_menu_open: false,
            worklog: None,
            page: Page::Board,
            detached: Vec::new(),
            sequence: 0,
            dialog: None,
            close_dialog_on_success: false,
            graph: GraphView::default(),
            preview: Preview::new(&home),
            preview_slot: None,
            preferences,
            preferences_path,
            icons,
            requests: HashSet::new(),
            busy: false,
            connected: false,
            error: None,
            notice: None,
            restore_preferences: true,
            last_board: Instant::now(),
            last_usage: Instant::now(),
            last_branches: Instant::now(),
            history_query: String::new(),
        };
        for load in [Load::Board, Load::Models, Load::Usage] {
            app.load(load, false);
        }
        app
    }

    pub fn load(&mut self, load: Load, force: bool) {
        if self.requests.insert(load) && self.api.jobs.send(Job::Read(load, force)).is_err() {
            self.requests.remove(&load);
            self.error = Some("The backend request worker stopped.".into());
        }
    }

    pub fn mutate(&mut self, mutation: Mutation) -> bool {
        if self.busy {
            return false;
        }
        self.error = None;
        if self.api.jobs.send(Job::Write(mutation)).is_err() {
            self.error = Some("The backend request worker stopped.".into());
            return false;
        }
        self.busy = true;
        true
    }

    pub fn show_dialog(&mut self, ui: &egui::Ui, dialog: Dialog) {
        if self.busy {
            return;
        }
        self.error = None;
        self.dialog = Some((ui.ctx().viewport_id(), dialog));
    }

    pub fn task_detail(&mut self, ui: &egui::Ui, id: Id) {
        self.load(Load::Detail(id), false);
        self.show_dialog(ui, Dialog::Detail(id));
    }

    pub fn save_preferences(&mut self) {
        let temporary = self.preferences_path.with_extension("tmp");
        let result = serde_json::to_vec_pretty(&self.preferences)
            .map_err(std::io::Error::other)
            .and_then(|bytes| std::fs::write(&temporary, bytes))
            .and_then(|()| std::fs::rename(&temporary, &self.preferences_path));
        if let Err(error) = result {
            self.error = Some(format!("Could not save preferences: {error}"));
        }
    }

    fn receive(&mut self) {
        while let Ok(reply) = self.api.replies.try_recv() {
            match reply {
                Reply::Data(load, data) => {
                    self.requests.remove(&load);
                    match data {
                        Ok(Data::Board(board)) => {
                            self.connected = true;
                            self.board = board;
                            if self.restore_preferences {
                                self.restore_preferences = false;
                                if self.preferences.quota_loop
                                    != self.board.worker.quota_loop_enabled
                                {
                                    let request = Mutation::post(
                                        "/worker/quota-loop",
                                        json!({"enabled": self.preferences.quota_loop}),
                                        "Quota preference restored",
                                    );
                                    let _ = self.api.jobs.send(Job::Restore(request));
                                }
                                if self.preferences.worker_paused == Some(false)
                                    && self.board.worker.paused
                                {
                                    let _ = self.api.jobs.send(Job::Restore(Mutation::post(
                                        "/worker/resume",
                                        json!({}),
                                        "Dispatch preference restored",
                                    )));
                                }
                            } else if self.board.worker.auto_paused
                                && self.preferences.worker_paused != Some(true)
                            {
                                self.preferences.worker_paused = Some(true);
                                self.save_preferences();
                            }
                        }
                        Ok(Data::Branches(value)) => self.branches = value,
                        Ok(Data::Usage(value)) => self.usage = Some(value),
                        Ok(Data::Models(value)) if !value.is_empty() => self.models = value,
                        Ok(Data::Models(_)) => {}
                        Ok(Data::Worklog(value)) => self.worklog = Some(value),
                        Ok(Data::Detail(value)) => {
                            self.details.insert(value.task.id, *value);
                        }
                        Err(error) => {
                            if load == Load::Board {
                                self.connected = false;
                            }
                            self.error = Some(error);
                        }
                    }
                }
                Reply::Restore(result) => {
                    if let Err(error) = result {
                        self.error = Some(error);
                    }
                    self.load(Load::Board, false);
                }
                Reply::Mutation(result) => {
                    self.busy = false;
                    let close = std::mem::take(&mut self.close_dialog_on_success);
                    match result {
                        Ok(label) => {
                            if close {
                                self.dialog = None;
                            }
                            if label == "Dispatch paused" || label == "Todo batch started" {
                                self.preferences.worker_paused = Some(label == "Dispatch paused");
                                self.save_preferences();
                            } else if label == "Quota refresh enabled"
                                || label == "Quota refresh disabled"
                            {
                                self.preferences.quota_loop = label == "Quota refresh enabled";
                                self.save_preferences();
                            }
                            self.notice = Some((label, Instant::now()));
                        }
                        Err(error) => self.error = Some(error),
                    }
                    self.load(Load::Board, false);
                    if self.branch_visible() {
                        self.load(Load::Branches, false);
                    }
                    if let Some((_, Dialog::Detail(id))) = self.dialog {
                        self.load(Load::Detail(id), false);
                    }
                }
            }
        }
    }

    fn branch_visible(&self) -> bool {
        matches!(self.page, Page::Features)
            || self
                .detached
                .iter()
                .any(|(_, page)| matches!(page, Page::Features))
    }

    pub fn select(&mut self, page: Page) {
        self.load_page(&page);
        self.page = page;
    }

    fn load_page(&mut self, page: &Page) {
        match page {
            Page::Features => self.load(Load::Branches, false),
            Page::Worklog => self.load(Load::Worklog, false),
            _ => {}
        }
    }

    pub fn detach(&mut self, page: Page) {
        if let Page::Frontend(id) = &page {
            if let Some(connection) = self.board.connections.iter().find(|entry| &entry.id == id) {
                if let Err(error) = crate::preview::detach(connection) {
                    self.error = Some(error);
                }
            }
            return;
        }
        self.sequence += 1;
        self.load_page(&page);
        self.detached.push((self.sequence, page));
    }

    pub fn change_icon(&mut self, ctx: &egui::Context, index: usize) {
        self.preferences.icon = index;
        let image = Some(icon(index));
        ctx.send_viewport_cmd_to(
            egui::ViewportId::ROOT,
            egui::ViewportCommand::Icon(image.clone()),
        );
        for (id, _) in &self.detached {
            ctx.send_viewport_cmd_to(window_id(*id), egui::ViewportCommand::Icon(image.clone()));
        }
        self.save_preferences();
    }
}

impl Agentboard {
    fn header(&mut self, ui: &mut egui::Ui) {
        egui::Panel::top("header")
            .frame(
                egui::Frame::new()
                    .fill(PANEL)
                    .inner_margin(egui::Margin::symmetric(14, 8)),
            )
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    let icon = &self.icons[self.preferences.icon];
                    ui.image((icon.id(), Vec2::splat(29.0)));
                    let title = ui.add(
                        egui::Label::new(RichText::new("Agentboard").size(19.0).strong())
                            .sense(egui::Sense::click_and_drag()),
                    );
                    handle_title_bar_drag(&title);
                    ui.add_space(9.0);
                    ui.colored_label(
                        if self.connected {
                            Color32::LIGHT_GREEN
                        } else {
                            Color32::LIGHT_RED
                        },
                        if self.connected { "Online" } else { "Offline" },
                    );
                    let worker = &self.board.worker;
                    let status = if worker.paused {
                        "Paused".into()
                    } else if let Some(id) = worker.active_task_id {
                        format!("Running #{id}")
                    } else if worker.busy {
                        "Running".into()
                    } else {
                        "Idle".into()
                    };
                    ui.label(RichText::new(status).color(MUTED))
                        .on_hover_text(&worker.message);
                    let codex_open = self.usage(ui);
                    self.usage_menu_open = self.memory_usage(ui) || codex_open;
                    let header_height = ui.min_rect().height().max(29.0);
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        for (label, tip, command) in [
                            ("×", "Close", egui::ViewportCommand::Close),
                            (
                                "□",
                                "Maximize or restore",
                                egui::ViewportCommand::Maximized(!is_maximized(ui)),
                            ),
                            ("−", "Minimize", egui::ViewportCommand::Minimized(true)),
                        ] {
                            if ui.small_button(label).on_hover_text(tip).clicked() {
                                ui.ctx().send_viewport_cmd(command);
                            }
                        }
                        if ui
                            .add_enabled(
                                self.connected && !self.busy,
                                egui::Button::new("New task")
                                    .fill(THEMES[self.preferences.theme].1.gamma_multiply(0.35)),
                            )
                            .clicked()
                        {
                            self.show_dialog(ui, Dialog::new_task(self, None));
                        }
                        if ui
                            .add_enabled(
                                self.connected && !self.busy,
                                egui::Button::new("New project"),
                            )
                            .clicked()
                        {
                            self.show_dialog(
                                ui,
                                Dialog::Project {
                                    name: String::new(),
                                    repository: String::new(),
                                    context: String::new(),
                                },
                            );
                        }
                        let worker = &self.board.worker;
                        let (quota, paused) = (worker.quota_loop_enabled, worker.paused);
                        let ready = self.connected && worker.running && !self.busy;
                        if ui
                            .add_enabled(
                                ready,
                                egui::Button::new(if quota { "Quota on" } else { "Quota off" }),
                            )
                            .clicked()
                        {
                            self.mutate(Mutation::post(
                                "/worker/quota-loop",
                                json!({"enabled": !quota}),
                                if quota {
                                    "Quota refresh disabled"
                                } else {
                                    "Quota refresh enabled"
                                },
                            ));
                        }
                        if ui
                            .add_enabled(
                                ready,
                                egui::Button::new(if paused {
                                    "Run Todo batch"
                                } else {
                                    "Pause dispatch"
                                }),
                            )
                            .clicked()
                        {
                            self.mutate(Mutation::post(
                                if paused {
                                    "/worker/resume"
                                } else {
                                    "/worker/pause"
                                },
                                json!({}),
                                if paused {
                                    "Todo batch started"
                                } else {
                                    "Dispatch paused"
                                },
                            ));
                        }
                        if !self.usage_menu_open
                            && self.dialog.is_none()
                            && ui.available_width() > 0.0
                        {
                            let (_, drag_area) = ui.allocate_exact_size(
                                Vec2::new(ui.available_width(), header_height),
                                egui::Sense::click_and_drag(),
                            );
                            handle_title_bar_drag(&drag_area);
                        }
                    });
                })
            });
    }

    fn usage(&mut self, ui: &mut egui::Ui) -> bool {
        const FIVE_HOURS: u32 = 5 * 60;
        const ONE_WEEK: u32 = 7 * 24 * 60;
        let label = self
            .usage
            .as_ref()
            .and_then(|usage| usage.window(FIVE_HOURS))
            .map_or_else(
                || "Codex 5h —".into(),
                |window| format!("Codex 5h {:.0}%", window.remaining_percent),
            );
        ui.menu_button(label, |ui| {
            ui.set_min_width(220.0);
            ui.strong("Codex remaining");
            for (name, duration) in [("Five hours", FIVE_HOURS), ("One week", ONE_WEEK)] {
                let window = self.usage.as_ref().and_then(|usage| usage.window(duration));
                if let Some(window) = window {
                    ui.label(name);
                    ui.add(
                        egui::ProgressBar::new(window.remaining_percent / 100.0)
                            .text(format!("{:.0}% remaining", window.remaining_percent)),
                    );
                    if let Some(reset) = window.resets_at {
                        ui.label(format!("Resets {}", timestamp(reset)));
                    }
                } else {
                    ui.label(format!("{name}: —"));
                }
            }
            if let Some(usage) = &self.usage {
                if let Some(plan) = &usage.plan_type {
                    ui.label(format!("Plan: {plan}"));
                }
                if let Some(credits) = usage.reset_credits {
                    ui.label(format!("Reset credits: {credits}"));
                }
                ui.label(format!("Checked {}", usage.checked_at));
                if !usage.available {
                    ui.label(&usage.message);
                }
            } else {
                ui.label("Usage has not been loaded.");
            }
            if let Some(reset) = self.board.worker.quota_waiting_until {
                ui.label(format!("Worker retries {}", timestamp(reset)));
            }
            if ui.button("Refresh usage").clicked() {
                self.load(Load::Usage, true);
            }
        })
        .inner
        .is_some()
    }

    fn memory_usage(&self, ui: &mut egui::Ui) -> bool {
        let label = self
            .memory
            .as_ref()
            .filter(|usage| usage.webviewer.is_some())
            .map_or_else(
                || "RAM —".into(),
                |usage| format!("RAM {}", format_memory(usage.total())),
            );
        ui.menu_button(label, |ui| {
            ui.set_min_width(185.0);
            ui.strong("Memory usage");
            egui::Grid::new("memory-usage")
                .num_columns(2)
                .show(ui, |ui| {
                    let rows = [
                        ("Crust", self.memory.as_ref().map(|usage| usage.crust)),
                        (
                            "WebViewer",
                            self.memory.as_ref().and_then(|usage| usage.webviewer),
                        ),
                    ];
                    for (label, bytes) in rows {
                        ui.label(label);
                        ui.label(bytes.map_or_else(|| "—".into(), format_memory));
                        ui.end_row();
                    }
                });
        })
        .inner
        .is_some()
    }

    fn sidebar(&mut self, ui: &mut egui::Ui) {
        let compact = self.preferences.compact;
        egui::Panel::left("navigation")
            .exact_size(if compact { 57.0 } else { 195.0 })
            .frame(egui::Frame::new().fill(PANEL).inner_margin(10))
            .show(ui, |ui| {
                let toggle = if compact {
                    egui::Button::image(navigation_image(
                        EXPAND_NAVIGATION_ICON,
                        "Expand navigation",
                    ))
                } else {
                    egui::Button::new("«  Collapse")
                };
                let toggle_response = if compact {
                    ui.add_sized([ui.available_width(), 36.0], toggle)
                        .on_hover_text("Expand navigation")
                } else {
                    ui.add(toggle)
                };
                if toggle_response.clicked() {
                    self.preferences.compact = !compact;
                    self.save_preferences();
                }
                ui.add_space(11.0);
                for page in [
                    Page::Board,
                    Page::Features,
                    Page::History,
                    Page::Worklog,
                    Page::Connections,
                    Page::Settings,
                ] {
                    self.nav_item(ui, page, None);
                }
                ui.add_space(8.0);
                egui::ScrollArea::vertical().show(ui, |ui| {
                    for connection in self.board.connections.clone() {
                        self.nav_item(ui, Page::Frontend(connection.id), Some(&connection.name));
                    }
                });
            });
    }

    fn nav_item(&mut self, ui: &mut egui::Ui, page: Page, custom: Option<&str>) {
        let title = custom.unwrap_or(page.name());
        let button = if self.preferences.compact {
            egui::Button::image(navigation_image(page.navigation_icon(), title))
        } else {
            egui::Button::new(RichText::new(title).size(13.0))
        };
        let response = ui
            .add_sized(
                [ui.available_width(), 36.0],
                button
                    .frame_when_inactive(page == self.page)
                    .selected(page == self.page)
                    .sense(egui::Sense::click_and_drag()),
            )
            .on_hover_text(title);
        if response.clicked() {
            self.select(page.clone());
        }
        if response.drag_stopped()
            && ui
                .input(|input| input.pointer.hover_pos())
                .is_some_and(|position| position.x > response.rect.right() + 18.0)
        {
            self.detach(page.clone());
        }
        response.context_menu(|ui| {
            if ui.button("Open in new window").clicked() {
                self.detach(page.clone());
                ui.close();
            }
        });
    }

    fn draw_page(&mut self, ui: &mut egui::Ui, page: &Page, root: bool) {
        if !self.board.worker.agent_available && self.connected {
            ui.label(
                RichText::new(&self.board.worker.message).color(Color32::from_rgb(235, 187, 120)),
            );
        }
        if let Some(error) = self.error.clone() {
            ui.horizontal_wrapped(|ui| {
                ui.colored_label(Color32::LIGHT_RED, error);
                if ui.small_button("Dismiss").clicked() {
                    self.error = None;
                }
            });
        }
        if let Some((message, time)) = &self.notice {
            if time.elapsed() < Duration::from_secs(6) {
                ui.colored_label(Color32::LIGHT_GREEN, message);
            }
        }
        match page {
            Page::Board => self.taskboard(ui),
            Page::Features => self.features(ui),
            Page::History => self.history(ui),
            Page::Worklog => self.worklog(ui),
            Page::Settings => self.settings(ui),
            Page::Connections => self.connections(ui),
            Page::Frontend(id) => self.frontend(ui, id, root),
        }
    }
}

impl eframe::App for Agentboard {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if let Ok(sample) = self.memory_samples.try_recv() {
            self.memory = sample;
        }
        self.receive();
        if self.last_board.elapsed() >= Duration::from_secs(3) {
            self.last_board = Instant::now();
            self.load(Load::Board, false);
            if let Some((_, Dialog::Detail(id))) = self.dialog {
                self.load(Load::Detail(id), false);
            }
        }
        if self.last_usage.elapsed() >= Duration::from_secs(45) {
            self.last_usage = Instant::now();
            self.load(Load::Usage, false);
        }
        if self.last_branches.elapsed() >= Duration::from_secs(12) && self.branch_visible() {
            self.last_branches = Instant::now();
            self.load(Load::Branches, false);
        }
        ctx.request_repaint_after(Duration::from_secs(1));
    }

    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        self.preview_slot = None;
        self.header(ui);
        self.sidebar(ui);
        let page = self.page.clone();
        content_panel(ui, |ui| self.draw_page(ui, &page, true));
        let root_modal = self
            .dialog
            .as_ref()
            .is_some_and(|(owner, _)| *owner == ui.ctx().viewport_id());
        if let Some((url, rect)) = self
            .preview_slot
            .take()
            .filter(|_| !root_modal && !self.usage_menu_open)
        {
            if let Err(error) = self.preview.show(frame, &url, rect) {
                self.error = Some(error);
            }
        } else {
            self.preview.hide();
        }
        self.paint_dialog(ui);
        let ctx = ui.ctx().clone();
        for (id, page) in self.detached.clone() {
            let title = page.name();
            let viewport = window_id(id);
            let closed = ctx.show_viewport_immediate(
                viewport,
                egui::ViewportBuilder::default()
                    .with_title(format!("{title} · Agentboard"))
                    .with_inner_size([1090.0, 720.0])
                    .with_min_inner_size([650.0, 480.0]),
                |ui, class| {
                    if class == egui::ViewportClass::EmbeddedWindow {
                        let mut open = true;
                        egui::Window::new(title)
                            .open(&mut open)
                            .show(ui.ctx(), |ui| self.draw_page(ui, &page, false));
                        return !open;
                    }
                    content_panel(ui, |ui| self.draw_page(ui, &page, false));
                    self.paint_dialog(ui);
                    ui.input(|input| input.viewport().close_requested())
                },
            );
            if closed {
                self.detached.retain(|(entry, _)| *entry != id);
                if self
                    .dialog
                    .as_ref()
                    .is_some_and(|(owner, _)| *owner == viewport)
                {
                    self.dialog = None;
                }
            }
        }
    }
}

fn content_panel(ui: &mut egui::Ui, content: impl FnOnce(&mut egui::Ui)) {
    egui::CentralPanel::default()
        .frame(egui::Frame::new().fill(BG).inner_margin(18))
        .show(ui, content);
}

fn navigation_image(source: egui::ImageSource<'static>, label: &str) -> egui::Image<'static> {
    egui::Image::new(source)
        .fit_to_exact_size(Vec2::splat(20.0))
        .alt_text(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapsed_navigation_icons_render_as_visible_svg_images() {
        let pages = [
            Page::Board,
            Page::Features,
            Page::History,
            Page::Worklog,
            Page::Connections,
            Page::Settings,
            Page::Frontend("preview".into()),
        ];
        for icon in pages
            .iter()
            .map(Page::navigation_icon)
            .chain([EXPAND_NAVIGATION_ICON])
        {
            let egui::ImageSource::Bytes { uri, bytes } = icon else {
                panic!("Navigation icons must be embedded");
            };
            let image = egui_extras::image::load_svg_bytes(&bytes, &Default::default())
                .unwrap_or_else(|error| panic!("{uri}: {error}"));
            assert!(image.pixels.iter().any(|pixel| pixel.a() > 0), "{uri}");
        }
    }
}

fn window_id(id: u64) -> egui::ViewportId {
    egui::ViewportId::from_hash_of(("detached", id))
}
fn is_maximized(ui: &egui::Ui) -> bool {
    ui.input(|input| input.viewport().maximized.unwrap_or(false))
}

fn handle_title_bar_drag(response: &egui::Response) {
    if response.double_clicked_by(egui::PointerButton::Primary) {
        let maximized = response
            .ctx
            .input(|input| input.viewport().maximized.unwrap_or(false));
        response
            .ctx
            .send_viewport_cmd(egui::ViewportCommand::Maximized(!maximized));
    } else {
        drag_title_bar(response);
    }
}

#[cfg(windows)]
fn drag_title_bar(response: &egui::Response) {
    use windows_sys::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};

    let primary = egui::PointerButton::Primary;
    if response
        .ctx
        .input(|input| input.viewport().maximized == Some(true))
    {
        if response.drag_started_by(primary) {
            response
                .ctx
                .send_viewport_cmd(egui::ViewportCommand::StartDrag);
        }
    } else {
        let ctx = &response.ctx;
        let grab_id = response.id.with("title-bar-grab");
        if response.is_pointer_button_down_on() {
            if let Some(grab_point) = ctx.input(|input| input.pointer.press_origin()) {
                ctx.data_mut(|data| data.insert_temp(grab_id, grab_point));
            }
        }
        let finished = response.drag_stopped_by(primary);
        if !response.dragged_by(primary) && !finished {
            return;
        }
        let Some(grab_point) = ctx.data_mut(|data| {
            if finished {
                data.remove_temp::<egui::Pos2>(grab_id)
            } else {
                data.get_temp(grab_id)
            }
        }) else {
            return;
        };
        let mut cursor = POINT { x: 0, y: 0 };
        // GetCursorPos writes the absolute cursor position into this valid POINT.
        if unsafe { GetCursorPos(&mut cursor) } != 0 {
            let scale = ctx.pixels_per_point();
            let position =
                egui::pos2(cursor.x as f32 / scale, cursor.y as f32 / scale) - grab_point.to_vec2();
            ctx.send_viewport_cmd(egui::ViewportCommand::OuterPosition(position));
        }
    }
}

#[cfg(not(windows))]
fn drag_title_bar(response: &egui::Response) {
    if response.drag_started_by(egui::PointerButton::Primary) {
        response
            .ctx
            .send_viewport_cmd(egui::ViewportCommand::StartDrag);
    }
}

pub fn icon(index: usize) -> std::sync::Arc<egui::IconData> {
    let source = image::load_from_memory(ICONS[index].1).expect("embedded app icon");
    let rgba = source.thumbnail(96, 96).to_rgba8();
    std::sync::Arc::new(egui::IconData {
        width: rgba.width(),
        height: rgba.height(),
        rgba: rgba.into_raw(),
    })
}

pub fn theme(ctx: &egui::Context, index: usize) {
    ctx.set_theme(egui::Theme::Dark);
    let mut visuals = egui::Visuals::dark();
    visuals.window_fill = PANEL;
    visuals.panel_fill = BG;
    visuals.extreme_bg_color = BG;
    visuals.faint_bg_color = CARD;
    visuals.selection.bg_fill = THEMES[index].1.gamma_multiply(0.36);
    visuals.selection.stroke.color = THEMES[index].1;
    visuals.hyperlink_color = THEMES[index].1;
    visuals.widgets.inactive.bg_fill = CARD;
    visuals.widgets.hovered.bg_fill = Color32::from_rgb(42, 55, 76);
    visuals.widgets.active.bg_fill = Color32::from_rgb(54, 72, 96);
    ctx.set_visuals_of(egui::Theme::Dark, visuals);
    ctx.global_style_mut(|style| {
        style.spacing.item_spacing = Vec2::new(8.0, 7.0);
        style.spacing.button_padding = Vec2::new(10.0, 5.0);
        style
            .text_styles
            .insert(egui::TextStyle::Body, egui::FontId::proportional(14.0));
        style
            .text_styles
            .insert(egui::TextStyle::Button, egui::FontId::proportional(13.0));
    });
}

fn install_fonts(ctx: &egui::Context) {
    let candidates = if cfg!(windows) {
        let windows = std::env::var_os("WINDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:/Windows"));
        vec![
            windows.join("Fonts/msjh.ttc"),
            windows.join("Fonts/mingliu.ttc"),
        ]
    } else {
        vec![
            PathBuf::from("/System/Library/Fonts/PingFang.ttc"),
            PathBuf::from("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        ]
    };
    if let Some(bytes) = candidates.iter().find_map(|path| std::fs::read(path).ok()) {
        let mut fonts = egui::FontDefinitions::default();
        let name = "System CJK";
        fonts.font_data.insert(
            name.into(),
            std::sync::Arc::new(egui::FontData::from_owned(bytes)),
        );
        for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
            fonts.families.entry(family).or_default().push(name.into());
        }
        ctx.set_fonts(fonts);
    }
}

pub fn heading(ui: &mut egui::Ui, title: &str, subtitle: &str) {
    ui.label(RichText::new(title).size(28.0).strong());
    ui.label(RichText::new(subtitle).color(MUTED));
    ui.add_space(10.0);
}

pub fn status_color(status: &str) -> Color32 {
    match status {
        "DONE" => Color32::from_rgb(119, 225, 181),
        "FAILED" | "REJECTED" | "CHERRY_PICK_CONFLICT" => Color32::from_rgb(244, 129, 129),
        "IN_REVIEW" | "REVIEWING" | "PENDING_PUSH" => Color32::from_rgb(237, 195, 116),
        "IN_PROGRESS" | "TESTING" => Color32::from_rgb(134, 177, 255),
        _ => MUTED,
    }
}

fn timestamp(value: i64) -> String {
    let seconds = if value > 10_000_000_000 {
        value / 1_000
    } else {
        value
    };
    chrono::DateTime::from_timestamp(seconds, 0)
        .map(|date| {
            date.with_timezone(&chrono::Local)
                .format("%b %d, %H:%M")
                .to_string()
        })
        .unwrap_or_else(|| "unknown".into())
}
