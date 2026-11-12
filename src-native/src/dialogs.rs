use crate::{
    api::Mutation,
    app::{status_color, Agentboard, MUTED},
    model::*,
    preview,
};
use eframe::egui::{self, Color32, RichText};
use serde_json::json;
use std::path::Path;

pub enum Dialog {
    Project {
        name: String,
        repository: String,
        context: String,
    },
    Feature {
        project: Option<Id>,
        name: String,
    },
    Task(TaskDraft),
    Connection {
        id: Option<String>,
        name: String,
        url: String,
    },
    Detail(Id),
    Retry {
        id: Id,
        title: String,
        kind: RetryKind,
        prompt: String,
        model: String,
        effort: String,
    },
    Confirm {
        title: String,
        description: String,
        action: Mutation,
    },
}

pub enum RetryKind {
    Task,
    Review,
    Conflict,
}

pub struct TaskDraft {
    id: Option<Id>,
    project: Option<Id>,
    feature: Option<Id>,
    title: String,
    description: String,
    priority: String,
    model: String,
    effort: String,
}

impl Dialog {
    pub fn new_task(app: &Agentboard, feature: Option<Id>) -> Self {
        let selected =
            feature.and_then(|id| app.board.features.iter().find(|entry| entry.id == id));
        let model = app
            .models
            .iter()
            .find(|model| model.is_default)
            .or_else(|| app.models.first());
        Self::Task(TaskDraft {
            id: None,
            project: selected
                .map(|entry| entry.project_id)
                .or(app.preferences.project)
                .or_else(|| app.board.projects.first().map(|entry| entry.id)),
            feature,
            title: String::new(),
            description: String::new(),
            priority: "MEDIUM".into(),
            model: model.map_or("gpt-6.1-sol", |entry| &entry.id).into(),
            effort: model
                .map_or("low", |entry| &entry.default_reasoning_effort)
                .into(),
        })
    }

    pub fn connection(connection: &Connection) -> Self {
        Self::Connection {
            id: Some(connection.id.clone()),
            name: connection.name.clone(),
            url: connection.url.clone(),
        }
    }

    fn edit(task: &Task) -> Self {
        Self::Task(TaskDraft {
            id: Some(task.id),
            project: Some(task.project_id),
            feature: task.feature_id,
            title: task.title.clone(),
            description: task.description.clone(),
            priority: task.priority.clone(),
            model: task.model_id.clone(),
            effort: task.model_effort.clone(),
        })
    }

    fn retry(task: &Task, kind: RetryKind) -> Self {
        Self::Retry {
            id: task.id,
            title: task.title.clone(),
            kind,
            prompt: String::new(),
            model: task.model_id.clone(),
            effort: task.model_effort.clone(),
        }
    }

    fn title(&self) -> &str {
        match self {
            Self::Project { .. } => "New project",
            Self::Feature { .. } => "New feature",
            Self::Task(draft) if draft.id.is_some() => "Edit task",
            Self::Task(_) => "New task",
            Self::Connection { id: Some(_), .. } => "Edit frontend connection",
            Self::Connection { .. } => "Add frontend connection",
            Self::Detail(_) => "Task details",
            Self::Retry {
                kind: RetryKind::Task,
                ..
            } => "Retry task",
            Self::Retry {
                kind: RetryKind::Review,
                ..
            } => "Request review changes",
            Self::Retry {
                kind: RetryKind::Conflict,
                ..
            } => "Resolve cherry-pick conflict",
            Self::Confirm { title, .. } => title,
        }
    }
}

impl Agentboard {
    pub fn paint_dialog(&mut self, parent: &mut egui::Ui) {
        let context = parent.ctx().clone();
        let Some((owner, mut dialog)) = self.dialog.take() else {
            return;
        };
        if owner != context.viewport_id() {
            self.dialog = Some((owner, dialog));
            return;
        }
        let mut close = false;
        let detail = matches!(dialog, Dialog::Detail(_));
        let response =
            egui::Modal::new(egui::Id::unique("agentboard-dialog")).show(&context, |ui| {
                let screen = ui.ctx().content_rect().size();
                let width = if detail { 800.0_f32 } else { 470.0_f32 };
                ui.set_width(width.min(screen.x - 54.0).max(280.0));
                ui.horizontal(|ui| {
                    ui.heading(dialog.title());
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        close = ui.add_enabled(!self.busy, egui::Button::new("×")).clicked();
                    });
                });
                ui.separator();
                if let Some(error) = &self.error {
                    ui.colored_label(Color32::LIGHT_RED, error);
                }
                if self.busy {
                    ui.spinner();
                }
                egui::ScrollArea::vertical()
                    .max_height((screen.y - 115.0).max(180.0))
                    .show(ui, |ui| {
                        ui.add_enabled_ui(!self.busy, |ui| self.dialog_body(ui, &mut dialog));
                    });
            });
        if self.dialog.is_none() && (self.busy || !(close || response.should_close())) {
            self.dialog = Some((owner, dialog));
        }
    }

    fn submit_dialog(&mut self, mutation: Mutation) {
        if self.mutate(mutation) {
            self.close_dialog_on_success = true;
        }
    }

    fn dialog_body(&mut self, ui: &mut egui::Ui, dialog: &mut Dialog) {
        match dialog {
            Dialog::Project {
                name,
                repository,
                context,
            } => {
                field(ui, "Project name", name);
                ui.label("Repository path");
                ui.horizontal(|ui| {
                    ui.add(
                        egui::TextEdit::singleline(repository)
                            .desired_width((ui.available_width() - 100.0).max(100.0)),
                    );
                    if ui.button("Browse…").clicked() {
                        let mut picker =
                            rfd::FileDialog::new().set_title("Choose a local Git repository");
                        let path = Path::new(repository.trim());
                        if let Some(directory) = path
                            .ancestors()
                            .find(|path| path.is_absolute() && path.is_dir())
                        {
                            picker = picker.set_directory(directory);
                        }
                        if let Some(selected) = picker.pick_folder() {
                            *repository = selected.to_string_lossy().into_owned();
                        }
                    }
                });
                multiline(ui, "Project context for Codex", context, 5);
                if submit(
                    ui,
                    "Create project",
                    !name.trim().is_empty() && !repository.trim().is_empty(),
                ) {
                    self.submit_dialog(Mutation::post("/projects", json!({
                        "name": name.trim(), "repository_path": repository.trim(), "context": context.trim()
                    }), "Project created"));
                }
            }
            Dialog::Feature { project, name } => {
                choose_project(ui, project, &self.board.projects);
                field(ui, "Feature name", name);
                if let Some(project_id) = *project {
                    if submit(ui, "Create feature", !name.trim().is_empty()) {
                        self.submit_dialog(Mutation::post(
                            "/features",
                            json!({"project_id": project_id, "name": name.trim()}),
                            "Feature created",
                        ));
                    }
                }
            }
            Dialog::Task(draft) => {
                let previous = draft.project;
                choose_project(ui, &mut draft.project, &self.board.projects);
                if draft.project != previous {
                    draft.feature = None;
                }
                ui.label("Feature");
                let features = &self.board.features;
                egui::ComboBox::from_id_salt("task-feature")
                    .selected_text(
                        draft
                            .feature
                            .and_then(|id| features.iter().find(|item| item.id == id))
                            .map_or("Select a Feature", |entry| &entry.name),
                    )
                    .show_ui(ui, |ui| {
                        for feature in features
                            .iter()
                            .filter(|item| Some(item.project_id) == draft.project)
                        {
                            ui.selectable_value(
                                &mut draft.feature,
                                Some(feature.id),
                                &feature.name,
                            );
                        }
                    });
                if !features
                    .iter()
                    .any(|item| Some(item.project_id) == draft.project)
                {
                    ui.label(
                        RichText::new("Create a Feature for this project before adding tasks.")
                            .color(MUTED),
                    );
                }
                field(ui, "Title", &mut draft.title);
                multiline(ui, "Description", &mut draft.description, 5);
                ui.label("Priority");
                egui::ComboBox::from_id_salt("priority")
                    .selected_text(&draft.priority)
                    .show_ui(ui, |ui| {
                        for priority in ["LOW", "MEDIUM", "HIGH", "URGENT"] {
                            ui.selectable_value(&mut draft.priority, priority.into(), priority);
                        }
                    });
                choose_model(ui, &self.models, &mut draft.model, &mut draft.effort);
                let ready = draft.project.is_some()
                    && draft.feature.is_some()
                    && !draft.title.trim().is_empty();
                if submit(
                    ui,
                    if draft.id.is_some() {
                        "Save changes"
                    } else {
                        "Create task"
                    },
                    ready,
                ) {
                    let body = json!({
                        "project_id": draft.project, "feature_id": draft.feature, "title": draft.title.trim(),
                        "description": draft.description.trim(), "priority": draft.priority,
                        "model_id": draft.model, "model_effort": draft.effort,
                    });
                    let mutation = match draft.id {
                        Some(id) => Mutation {
                            method: "PUT",
                            path: format!("/tasks/{id}"),
                            body: Some(body),
                            label: "Task updated".into(),
                        },
                        None => Mutation::post("/tasks", body, "Task created"),
                    };
                    self.submit_dialog(mutation);
                }
            }
            Dialog::Connection { id, name, url } => {
                field(ui, "Connection name", name);
                field(ui, "Local HTTP or HTTPS URL", url);
                ui.label(
                    RichText::new("Supported hosts are localhost, 127.0.0.1 and [::1].")
                        .color(MUTED),
                );
                if submit(
                    ui,
                    "Save connection",
                    !name.trim().is_empty() && preview::allowed(url.trim()),
                ) {
                    let body = json!({"name": name.trim(), "url": url.trim()});
                    let mutation = match id {
                        Some(id) => Mutation {
                            method: "PUT",
                            path: format!("/frontend-connections/{id}"),
                            body: Some(body),
                            label: "Connection updated".into(),
                        },
                        None => Mutation::post("/frontend-connections", body, "Connection added"),
                    };
                    self.submit_dialog(mutation);
                }
            }
            Dialog::Detail(id) => self.detail(ui, *id),
            Dialog::Retry {
                id,
                title,
                kind,
                prompt,
                model,
                effort,
            } => {
                ui.strong(title.as_str());
                if !matches!(kind, RetryKind::Conflict) {
                    multiline(
                        ui,
                        if matches!(kind, RetryKind::Review) {
                            "Required revision feedback"
                        } else {
                            "Optional retry prompt"
                        },
                        prompt,
                        6,
                    );
                }
                if !matches!(kind, RetryKind::Review) {
                    choose_model(ui, &self.models, model, effort);
                }
                if submit(
                    ui,
                    "Queue task",
                    !matches!(kind, RetryKind::Review) || !prompt.trim().is_empty(),
                ) {
                    let (action, body) = match kind {
                        RetryKind::Task => {
                            let mut body = json!({"model_id": model, "model_effort": effort});
                            if !prompt.trim().is_empty() {
                                body["prompt"] = json!(prompt.trim());
                            }
                            ("retry", body)
                        }
                        RetryKind::Review => ("retry-review", json!({"prompt": prompt.trim()})),
                        RetryKind::Conflict => (
                            "resolve-cherry-pick",
                            json!({"model_id": model, "model_effort": effort}),
                        ),
                    };
                    self.submit_dialog(Mutation::post(
                        format!("/tasks/{id}/{action}"),
                        body,
                        "Task queued",
                    ));
                }
            }
            Dialog::Confirm {
                description,
                action,
                ..
            } => {
                ui.label(description.as_str());
                if submit(ui, "Confirm", true) {
                    self.submit_dialog(Mutation {
                        method: action.method,
                        path: action.path.clone(),
                        body: action.body.clone(),
                        label: action.label.clone(),
                    });
                }
            }
        }
    }
}

fn field(ui: &mut egui::Ui, name: &str, value: &mut String) {
    ui.label(name);
    ui.add(egui::TextEdit::singleline(value).desired_width(f32::INFINITY));
}

fn multiline(ui: &mut egui::Ui, name: &str, value: &mut String, rows: usize) {
    ui.label(name);
    ui.add(
        egui::TextEdit::multiline(value)
            .desired_width(f32::INFINITY)
            .desired_rows(rows),
    );
}

fn submit(ui: &mut egui::Ui, text: &str, enabled: bool) -> bool {
    ui.add_space(8.0);
    ui.add_enabled(
        enabled,
        egui::Button::new(RichText::new(text).strong()).fill(ui.visuals().selection.bg_fill),
    )
    .clicked()
}

fn choose_project(ui: &mut egui::Ui, project: &mut Option<Id>, projects: &[Project]) {
    ui.label("Project");
    egui::ComboBox::from_id_salt("dialog-project")
        .selected_text(
            projects
                .iter()
                .find(|entry| Some(entry.id) == *project)
                .map_or("Select a project", |entry| &entry.name),
        )
        .show_ui(ui, |ui| {
            for entry in projects {
                ui.selectable_value(project, Some(entry.id), &entry.name);
            }
        });
}

fn choose_model(ui: &mut egui::Ui, models: &[Model], model_id: &mut String, effort: &mut String) {
    ui.label("Codex model and reasoning");
    ui.horizontal_wrapped(|ui| {
        let current = models.iter().find(|model| &model.id == model_id);
        let previous = model_id.clone();
        egui::ComboBox::from_id_salt("agent-model")
            .selected_text(current.map_or(model_id.as_str(), |model| &model.display_name))
            .show_ui(ui, |ui| {
                for model in models {
                    ui.selectable_value(model_id, model.id.clone(), &model.display_name)
                        .on_hover_text(&model.description);
                }
            });
        let selected = models.iter().find(|model| &model.id == model_id);
        if let Some(model) = selected {
            if previous != *model_id
                || !model
                    .supported_reasoning_efforts
                    .iter()
                    .any(|choice| &choice.id == effort)
            {
                *effort = model.default_reasoning_effort.clone();
            }
            egui::ComboBox::from_id_salt("agent-effort")
                .selected_text(effort.as_str())
                .show_ui(ui, |ui| {
                    for choice in &model.supported_reasoning_efforts {
                        ui.selectable_value(effort, choice.id.clone(), &choice.id)
                            .on_hover_text(&choice.description);
                    }
                });
        } else {
            ui.label(effort.as_str());
        }
    });
}

pub(crate) enum TaskAction {
    Dialog(Dialog),
    Write(Mutation),
    Related(Id),
}

impl Agentboard {
    fn detail(&mut self, ui: &mut egui::Ui, id: Id) {
        let detail = self.details.get(&id);
        let task = detail
            .map(|entry| &entry.task)
            .or_else(|| self.board.tasks.iter().find(|entry| entry.id == id));
        let Some(task) = task else {
            ui.label("Task is unavailable.");
            return;
        };
        let project = detail.map(|entry| &entry.project).or_else(|| {
            self.board
                .projects
                .iter()
                .find(|entry| entry.id == task.project_id)
        });
        ui.horizontal_wrapped(|ui| {
            ui.colored_label(status_color(&task.status), status_label(&task.status));
            ui.label(format!("#{} · {}", task.id, task.priority));
            if task.is_rejected {
                ui.colored_label(Color32::LIGHT_RED, "Rejected");
            }
            if task.is_paused {
                ui.colored_label(Color32::LIGHT_YELLOW, "Paused");
            }
        });
        ui.heading(&task.title);
        if let Some(project) = project {
            ui.label(RichText::new(&project.name).color(MUTED))
                .on_hover_text(
                    project
                        .context
                        .as_deref()
                        .unwrap_or(&project.repository_path),
                );
        }
        let mut action = task_actions(ui, task, false);
        ui.separator();
        ui.strong("Description");
        ui.label(if task.description.is_empty() {
            "No description provided."
        } else {
            &task.description
        });
        if let Some(prompt) = &task.retry_prompt {
            ui.strong("Latest retry prompt");
            ui.label(prompt);
        }
        ui.add_space(6.0);
        ui.strong("Workspace");
        egui::Grid::new(("task-fields", id))
            .num_columns(2)
            .striped(true)
            .show(ui, |ui| {
                for (label, value) in [
                    ("Branch", task.branch_name.as_deref()),
                    ("Workspace", task.worktree_path.as_deref()),
                    ("Base branch", task.base_branch.as_deref()),
                    ("Commit summary", task.commit_summary.as_deref()),
                    ("Publish commit", task.publish_commit_sha.as_deref()),
                    ("Model", Some(task.model_id.as_str())),
                    ("Reasoning", Some(task.model_effort.as_str())),
                    ("Mode", Some(task.agent_mode.as_str())),
                    ("Created", Some(task.created_at.as_str())),
                    ("Updated", Some(task.updated_at.as_str())),
                ] {
                    ui.label(RichText::new(label).color(MUTED));
                    ui.add(
                        egui::Label::new(RichText::new(value.unwrap_or("—")).monospace())
                            .wrap()
                            .selectable(true),
                    );
                    ui.end_row();
                }
                ui.label("Retry source");
                if let Some(source) = task.source_task_id {
                    if ui.link(format!("#{source}")).clicked() {
                        action = Some(TaskAction::Related(source));
                    }
                } else {
                    ui.label("Original task");
                }
                ui.end_row();
            });
        ui.add_space(6.0);
        ui.strong("Execution runs");
        match detail {
            Some(detail) if detail.runs.is_empty() => {
                ui.label("The Worker has not started an execution run.");
            }
            Some(detail) => {
                for (index, run) in detail.runs.iter().enumerate() {
                    run_panel(ui, run, index);
                }
            }
            None => {
                ui.spinner();
            }
        }
        self.handle_task_action(ui, action);
    }

    pub(crate) fn handle_task_action(&mut self, ui: &egui::Ui, action: Option<TaskAction>) {
        match action {
            Some(TaskAction::Dialog(dialog)) => self.show_dialog(ui, dialog),
            Some(TaskAction::Write(request)) => {
                self.mutate(request);
            }
            Some(TaskAction::Related(id)) => self.task_detail(ui, id),
            None => {}
        }
    }
}

pub(crate) fn task_actions(ui: &mut egui::Ui, task: &Task, compact: bool) -> Option<TaskAction> {
    let id = task.id;
    let mut action = None;
    ui.horizontal_wrapped(|ui| {
        let status = task.status.as_str();
        let modify = !matches!(
            status,
            "CLAIMED"
                | "IN_PROGRESS"
                | "TESTING"
                | "REVIEWING"
                | "PENDING_PUSH"
                | "CHERRY_PICK_CONFLICT"
                | "PENDING_BRANCH_REMOVAL"
        );
        if !compact && ui.add_enabled(modify, egui::Button::new("Edit")).clicked() {
            action = Some(TaskAction::Dialog(Dialog::edit(task)));
        }
        if !compact
            && ui
                .add_enabled(modify, egui::Button::new("Delete"))
                .clicked()
        {
            action = Some(confirm(
                "Delete task",
                format!("Permanently delete #{} and its execution history?", task.id),
                Mutation::delete(format!("/tasks/{id}"), "Task deleted"),
            ));
        }
        if status == "TODO" {
            let (label, endpoint, result) = if task.is_paused {
                ("Resume task", "resume", "Task resumed")
            } else {
                ("Pause task", "pause", "Task paused")
            };
            if ui.button(label).clicked() {
                action = Some(TaskAction::Write(Mutation::task(id, endpoint, result)));
            }
        }
        if status == "IN_REVIEW" {
            if ui.button("Start review").clicked() {
                action = Some(TaskAction::Write(Mutation::task(
                    id,
                    "start-review",
                    "Review checkout opened",
                )));
            }
            if !compact && ui.button("Request changes").clicked() {
                action = Some(TaskAction::Dialog(Dialog::retry(task, RetryKind::Review)));
            }
        }
        if status == "REVIEWING" {
            if ui.button("Exit review").clicked() {
                action = Some(TaskAction::Write(Mutation::task(
                    id,
                    "exit-review",
                    "Review checkout closed",
                )));
            }
            if ui.button("Review passed").clicked() {
                action = Some(TaskAction::Write(Mutation::task(
                    id,
                    "approve",
                    "Task ready to push",
                )));
            }
        }
        if status == "PENDING_PUSH" && ui.button("Confirm push").clicked() {
            let base = if task.feature_id.is_some() {
                "main"
            } else {
                task.base_branch.as_deref().unwrap_or("the base branch")
            };
            let change = if task.feature_id.is_some() {
                "Cherry-pick the approved checkpoint"
            } else {
                "Merge the approved task"
            };
            action = Some(confirm(
                "Publish approved task",
                format!("{change} for #{} onto {base} and push to origin?", task.id),
                Mutation::task(id, "push", "Task published"),
            ));
        }
        if status == "CHERRY_PICK_CONFLICT" && ui.button("Resolve conflict").clicked() {
            action = Some(TaskAction::Dialog(Dialog::retry(task, RetryKind::Conflict)));
        }
        if status == "PENDING_BRANCH_REMOVAL" && ui.button("Approve branch removal").clicked() {
            action = Some(confirm(
                "Remove task branch",
                format!(
                    "Remove local branch {}?",
                    task.branch_name.as_deref().unwrap_or("for this task")
                ),
                Mutation::task(id, "remove-branch", "Task branch removed"),
            ));
        }
        if (!compact || status == "FAILED") && ui.button("Retry task").clicked() {
            action = Some(TaskAction::Dialog(Dialog::retry(task, RetryKind::Task)));
        }
        if !compact && ui.button("Reject task").clicked() {
            let active = if matches!(status, "CLAIMED" | "IN_PROGRESS" | "TESTING") {
                " The active run will stop."
            } else {
                ""
            };
            let branch = if task.feature_id.is_some() {
                " The shared Feature branch is retained."
            } else {
                " Any task branch will wait for removal approval."
            };
            action = Some(confirm(
                "Reject task",
                format!("Reject #{}?{active}{branch}", task.id),
                Mutation::task(id, "reject", "Task rejected"),
            ));
        }
    });
    action
}

fn confirm(title: &str, description: String, action: Mutation) -> TaskAction {
    TaskAction::Dialog(Dialog::Confirm {
        title: title.into(),
        description,
        action,
    })
}

fn run_panel(ui: &mut egui::Ui, run: &Run, index: usize) {
    let exit = run
        .exit_code
        .map_or_else(|| "Running".into(), |code| format!("Exit {code}"));
    egui::CollapsingHeader::new(format!("Run #{} · {} · {exit}", run.id, run.started_at))
        .id_salt(run.id)
        .default_open(index == 0)
        .show(ui, |ui| {
            if let Some(finished) = &run.finished_at {
                ui.label(format!("Finished {finished}"));
            }
            ui.label(if run.result_summary.is_empty() {
                "No result summary."
            } else {
                &run.result_summary
            });
            ui.strong("Changed files");
            let files = changed_files(&run.code_diff, &run.file_diff);
            if files.is_empty() {
                ui.label("No file changes captured.");
            }
            for (index, file) in files.into_iter().enumerate() {
                egui::CollapsingHeader::new(format!(
                    "{}  {}  +{} −{}",
                    file.status, file.path, file.added, file.deleted
                ))
                .id_salt(("file", run.id, index))
                .show(ui, |ui| {
                    if file.lines.is_empty() {
                        ui.label("Patch content is unavailable in the captured snapshot.");
                    } else {
                        egui::ScrollArea::horizontal()
                            .id_salt(("patch", run.id, index))
                            .show(ui, |ui| {
                                for line in file.lines {
                                    let color = if line.starts_with("@@") {
                                        Color32::LIGHT_BLUE
                                    } else if line.starts_with('+') && !line.starts_with("+++ ") {
                                        Color32::LIGHT_GREEN
                                    } else if line.starts_with('-') && !line.starts_with("--- ") {
                                        Color32::LIGHT_RED
                                    } else {
                                        MUTED
                                    };
                                    ui.add(
                                        egui::Label::new(
                                            RichText::new(line).monospace().color(color),
                                        )
                                        .extend()
                                        .selectable(true),
                                    );
                                }
                            });
                    }
                });
            }
            for (title, output) in [("stdout", &run.stdout), ("stderr", &run.stderr)] {
                egui::CollapsingHeader::new(title)
                    .id_salt(("log", run.id, title))
                    .show(ui, |ui| {
                        ui.add(
                            egui::Label::new(
                                RichText::new(if output.is_empty() {
                                    "No output captured."
                                } else {
                                    output
                                })
                                .monospace(),
                            )
                            .wrap()
                            .selectable(true),
                        );
                    });
            }
        });
}

struct FilePatch<'a> {
    path: String,
    status: &'static str,
    added: u64,
    deleted: u64,
    lines: Vec<&'a str>,
}

fn changed_files<'a>(patch: &'a str, summary: &str) -> Vec<FilePatch<'a>> {
    let mut files: Vec<FilePatch<'a>> = Vec::new();
    for line in patch.lines() {
        if let Some(header) = line.strip_prefix("diff --git ") {
            let path = header.rsplit_once(" b/").map_or(header, |(_, path)| path);
            files.push(FilePatch {
                path: path.into(),
                status: "Modified",
                added: 0,
                deleted: 0,
                lines: vec![line],
            });
        } else if let Some(file) = files.last_mut() {
            if let Some(path) = line.strip_prefix("+++ ") {
                if path != "/dev/null" {
                    file.path = patch_path(path, "b/");
                }
            } else if let Some(path) = line.strip_prefix("--- ") {
                if path != "/dev/null" {
                    file.path = patch_path(path, "a/");
                }
            } else if line.starts_with("new file mode ") {
                file.status = "Added";
            } else if line.starts_with("deleted file mode ") {
                file.status = "Deleted";
            } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                file.status = "Binary";
            } else if line.starts_with('+') {
                file.added += 1;
            } else if line.starts_with('-') {
                file.deleted += 1;
            }
            file.lines.push(line);
        }
    }
    for line in summary.lines() {
        let mut fields = line.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if [added, deleted]
            .iter()
            .any(|value| *value != "-" && value.parse::<u64>().is_err())
        {
            continue;
        }
        let totals = (added.parse().unwrap_or(0), deleted.parse().unwrap_or(0));
        let path = patch_path(path, "");
        if let Some(file) = files.iter_mut().find(|entry| entry.path == path) {
            (file.added, file.deleted) = totals;
        } else {
            files.push(FilePatch {
                path,
                status: if added == "-" || deleted == "-" {
                    "Binary"
                } else {
                    "Modified"
                },
                added: totals.0,
                deleted: totals.1,
                lines: Vec::new(),
            });
        }
    }
    files
}

fn patch_path(path: &str, prefix: &str) -> String {
    let path =
        serde_json::from_str::<String>(path).unwrap_or_else(|_| path.trim_matches('"').to_owned());
    path.strip_prefix(prefix).unwrap_or(&path).into()
}

#[cfg(test)]
mod tests {
    #[test]
    fn combines_patch_lines_and_files_whose_patches_were_capped() {
        let patch = "diff --git a/with spaces.txt b/with spaces.txt\n--- a/with spaces.txt\n+++ b/with spaces.txt\n@@ -1 +1 @@\n-old\n+new\n";
        let files = super::changed_files(patch, "1\t1\twith spaces.txt\n-\t-\tbinary.png\n");
        assert_eq!(files.len(), 2);
        assert_eq!(
            (&*files[0].path, files[0].added, files[0].deleted),
            ("with spaces.txt", 1, 1)
        );
        assert!(files[0].lines.contains(&"+new"));
        assert_eq!(files[1].status, "Binary");
        assert!(files[1].lines.is_empty());
    }
}
