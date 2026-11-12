use crate::{
    api::{Load, Mutation},
    app::{heading, status_color, theme, Agentboard, Page, CARD, ICONS, MUTED, THEMES},
    dialogs::{task_actions, Dialog, TaskAction},
    graph::GraphEvent,
    model::*,
    preview::{self, Preview},
};
use eframe::egui::{self, Color32, RichText, Vec2};
use serde_json::json;
use std::collections::HashSet;

impl Agentboard {
    pub fn taskboard(&mut self, ui: &mut egui::Ui) {
        heading(
            ui,
            "Taskboard",
            &format!(
                "{} tasks across {} projects",
                self.board.tasks.len(),
                self.board.projects.len()
            ),
        );
        if self.board.projects.is_empty() {
            ui.label("Add a local Git repository to create your first project.");
        }
        let lane_height = (ui.available_height() - 18.0).max(175.0);
        let mut action = None;
        egui::ScrollArea::horizontal()
            .id_salt("board-scroll")
            .show(ui, |ui| {
                ui.horizontal_top(|ui| {
                    for (status, label) in STATUSES {
                        let mut matching: Vec<_> = self
                            .board
                            .tasks
                            .iter()
                            .filter(|task| task.status == *status)
                            .collect();
                        let count = matching.len();
                        if matches!(*status, "DONE" | "REJECTED" | "FAILED") {
                            matching.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
                            matching.truncate(5);
                        } else {
                            matching.sort_by(|left, right| {
                                priority(&right.priority)
                                    .cmp(&priority(&left.priority))
                                    .then_with(|| left.created_at.cmp(&right.created_at))
                            });
                        }
                        let width = 204.0;
                        ui.allocate_ui_with_layout(
                            Vec2::new(width, lane_height),
                            egui::Layout::top_down(egui::Align::Min),
                            |ui| {
                                ui.set_width(width);
                                ui.set_max_width(width);
                                ui.horizontal(|ui| {
                                    let (dot, _) = ui.allocate_exact_size(
                                        Vec2::splat(8.0),
                                        egui::Sense::hover(),
                                    );
                                    ui.painter().circle_filled(
                                        dot.center(),
                                        3.4,
                                        status_color(status),
                                    );
                                    ui.strong(*label);
                                    ui.label(RichText::new(count.to_string()).color(MUTED));
                                });
                                ui.separator();
                                egui::ScrollArea::vertical()
                                    .id_salt(status)
                                    .max_height(lane_height - 30.0)
                                    .show(ui, |ui| {
                                        for task in matching {
                                            egui::Frame::new()
                                                .fill(CARD)
                                                .corner_radius(8)
                                                .inner_margin(9)
                                                .show(ui, |ui| {
                                                    ui.set_width(width - 24.0);
                                                    ui.label(
                                                        RichText::new(format!(
                                                            "#{}   {}",
                                                            task.id, task.priority
                                                        ))
                                                        .size(11.0)
                                                        .color(MUTED),
                                                    );
                                                    if ui
                                                        .add(
                                                            egui::Button::new(
                                                                RichText::new(&task.title).strong(),
                                                            )
                                                            .wrap()
                                                            .frame(false),
                                                        )
                                                        .clicked()
                                                    {
                                                        action = Some(TaskAction::Related(task.id));
                                                    }
                                                    if let Some(project) =
                                                        self.board.projects.iter().find(|project| {
                                                            project.id == task.project_id
                                                        })
                                                    {
                                                        ui.label(
                                                            RichText::new(&project.name)
                                                                .size(12.0)
                                                                .color(MUTED),
                                                        );
                                                    }
                                                    if task.is_paused {
                                                        ui.colored_label(
                                                            Color32::LIGHT_YELLOW,
                                                            "Paused",
                                                        );
                                                    }
                                                    if let Some(source) = task.source_task_id {
                                                        ui.label(
                                                            RichText::new(format!(
                                                                "Retry of #{source}"
                                                            ))
                                                            .size(12.0)
                                                            .color(MUTED),
                                                        );
                                                    }
                                                    if let Some(run) = &task.latest_run {
                                                        ui.add(
                                                            egui::Label::new(
                                                                RichText::new(&run.result_summary)
                                                                    .size(12.0)
                                                                    .color(MUTED),
                                                            )
                                                            .truncate(),
                                                        );
                                                    }
                                                    if let Some(event) = ui
                                                        .add_enabled_ui(!self.busy, |ui| {
                                                            task_actions(ui, task, true)
                                                        })
                                                        .inner
                                                    {
                                                        action = Some(event);
                                                    }
                                                });
                                            ui.add_space(6.0);
                                        }
                                    });
                            },
                        );
                    }
                });
            });
        self.handle_task_action(ui, action);
    }

    pub fn history(&mut self, ui: &mut egui::Ui) {
        heading(ui, "Task history", "Completed, rejected and failed tasks");
        ui.add(
            egui::TextEdit::singleline(&mut self.history_query)
                .hint_text("Search title, project or task number"),
        );
        ui.add_space(8.0);
        let query = self.history_query.to_lowercase();
        let mut history: Vec<_> = self
            .board
            .tasks
            .iter()
            .filter(|task| is_archived(task))
            .collect();
        history.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        let mut rows = 0;
        let mut open = None;
        egui::ScrollArea::vertical().show(ui, |ui| {
            for task in history {
                let project = self
                    .board
                    .projects
                    .iter()
                    .find(|project| project.id == task.project_id)
                    .map_or("Unknown project", |project| project.name.as_str());
                if !format!("{} {} {}", task.title, project, task.id)
                    .to_lowercase()
                    .contains(&query)
                {
                    continue;
                }
                rows += 1;
                egui::Frame::new()
                    .fill(CARD)
                    .corner_radius(8)
                    .inner_margin(10)
                    .show(ui, |ui| {
                        ui.set_min_width(ui.available_width());
                        ui.horizontal_wrapped(|ui| {
                            ui.colored_label(
                                status_color(&task.status),
                                status_label(&task.status),
                            );
                            if ui.link(format!("#{}  {}", task.id, task.title)).clicked() {
                                open = Some(task.id);
                            }
                            ui.label(RichText::new(project).color(MUTED));
                            ui.label(&task.updated_at);
                        });
                        if let Some(run) = &task.latest_run {
                            ui.label(&run.result_summary);
                        }
                    });
                ui.add_space(5.0);
            }
            if rows == 0 {
                ui.label("No matching tasks.");
            }
        });
        if let Some(id) = open {
            self.task_detail(ui, id);
        }
    }

    pub fn features(&mut self, ui: &mut egui::Ui) {
        heading(ui, "Features", "Git history and task checkpoints");
        let projects = self.board.projects.clone();
        if !projects
            .iter()
            .any(|project| Some(project.id) == self.preferences.project)
        {
            self.preferences.project = projects.first().map(|project| project.id);
        }
        let old = self.preferences.project;
        ui.horizontal(|ui| {
            egui::ComboBox::from_id_salt("feature-project")
                .selected_text(
                    projects
                        .iter()
                        .find(|project| Some(project.id) == self.preferences.project)
                        .map_or("Select a project", |project| &project.name),
                )
                .show_ui(ui, |ui| {
                    for project in &projects {
                        ui.selectable_value(
                            &mut self.preferences.project,
                            Some(project.id),
                            &project.name,
                        );
                    }
                });
            if ui
                .add_enabled(!projects.is_empty(), egui::Button::new("New feature"))
                .clicked()
            {
                self.show_dialog(
                    ui,
                    Dialog::Feature {
                        project: self.preferences.project,
                        name: String::new(),
                    },
                );
            }
            if ui.button("Refresh graph").clicked() {
                self.load(Load::Branches, false);
            }
        });
        if self.preferences.project != old {
            self.save_preferences();
        }
        let Some(id) = self.preferences.project else {
            ui.label("Add a project to view its Git branches.");
            return;
        };
        let Some(map) = self.branches.iter().find(|map| map.project.id == id) else {
            ui.label(if self.requests.contains(&Load::Branches) {
                "Loading branch history…"
            } else {
                "Branch history is unavailable."
            });
            return;
        };
        let protected = self
            .board
            .tasks
            .iter()
            .filter(|task| task.project_id == id && protects_pointer(task))
            .map(|task| task.feature_id)
            .collect::<HashSet<_>>();
        let speed = self.preferences.zoom_speed.entry(id).or_insert(1);
        let previous_speed = *speed;
        let event = self.graph.show(ui, map, speed, &protected);
        if *speed != previous_speed {
            self.save_preferences();
        }
        match event {
            Some(GraphEvent::Task(id)) => self.task_detail(ui, id),
            Some(GraphEvent::CreateTask(id)) => {
                self.show_dialog(ui, Dialog::new_task(self, Some(id)))
            }
            Some(GraphEvent::CreateFeature(id)) => self.show_dialog(
                ui,
                Dialog::Feature {
                    project: Some(id),
                    name: String::new(),
                },
            ),
            Some(GraphEvent::Order(id, branches)) => {
                self.mutate(Mutation {
                    method: "PUT",
                    path: format!("/projects/{id}/branches/order"),
                    body: Some(json!({"branch_names": branches})),
                    label: "Branch order saved".into(),
                });
            }
            Some(GraphEvent::Confirm(title, description, action)) => self.show_dialog(
                ui,
                Dialog::Confirm {
                    title,
                    description,
                    action,
                },
            ),
            None => {}
        }
    }

    pub fn worklog(&mut self, ui: &mut egui::Ui) {
        heading(ui, "Update log", "Release notes, newest first");
        if ui.small_button("Reload").clicked() {
            self.load(Load::Worklog, false);
        }
        let Some(worklog) = &self.worklog else {
            ui.label("Loading update log…");
            return;
        };
        let sections = worklog_sections(worklog);
        egui::ScrollArea::vertical().show(ui, |ui| {
            if sections.is_empty() {
                ui.label("No worklog entries found.");
            }
            for (date, entries) in sections {
                ui.add_space(10.0);
                egui::Frame::new()
                    .fill(CARD)
                    .corner_radius(9)
                    .inner_margin(12)
                    .show(ui, |ui| {
                        ui.set_min_width(ui.available_width());
                        ui.strong(date);
                        for entry in entries {
                            ui.label(format!("•  {entry}"));
                        }
                    });
            }
        });
    }

    pub fn settings(&mut self, ui: &mut egui::Ui) {
        heading(
            ui,
            "Settings",
            "Appearance is shared across desktop windows",
        );
        ui.strong("Theme color");
        ui.horizontal_wrapped(|ui| {
            for (index, (name, color)) in THEMES.iter().enumerate() {
                if ui
                    .add(
                        egui::Button::new(RichText::new(*name).color(*color))
                            .selected(self.preferences.theme == index),
                    )
                    .clicked()
                {
                    self.preferences.theme = index;
                    theme(ui.ctx(), index);
                    self.save_preferences();
                }
            }
        });
        ui.add_space(18.0);
        ui.strong("Application icon");
        ui.horizontal_wrapped(|ui| {
            for (index, (name, _)) in ICONS.iter().enumerate() {
                ui.vertical(|ui| {
                    if ui
                        .add(
                            egui::Button::image((self.icons[index].id(), Vec2::splat(62.0)))
                                .selected(self.preferences.icon == index),
                        )
                        .on_hover_text(*name)
                        .clicked()
                    {
                        self.change_icon(ui.ctx(), index);
                    }
                    ui.label(*name);
                });
            }
        });
        ui.add_space(18.0);
        if ui.button("Refresh Codex models").clicked() {
            self.load(Load::Models, true);
        }
    }

    pub fn connections(&mut self, ui: &mut egui::Ui) {
        heading(
            ui,
            "Frontend connections",
            "Open development servers running on this computer",
        );
        if ui.button("Add connection").clicked() {
            self.show_dialog(
                ui,
                Dialog::Connection {
                    id: None,
                    name: String::new(),
                    url: "http://127.0.0.1:".into(),
                },
            );
        }
        egui::ScrollArea::vertical().show(ui, |ui| {
            for connection in self.board.connections.clone() {
                ui.horizontal_wrapped(|ui| {
                    if ui.link(&connection.name).clicked() {
                        self.select(Page::Frontend(connection.id.clone()));
                    }
                    ui.monospace(&connection.url);
                    if ui.small_button("Edit").clicked() {
                        self.show_dialog(ui, Dialog::connection(&connection));
                    }
                    if ui.small_button("Remove").clicked() {
                        self.remove_connection(ui, &connection);
                    }
                    if ui.small_button("Detach").clicked() {
                        self.detach(Page::Frontend(connection.id.clone()));
                    }
                });
            }
        });
    }

    pub fn frontend(&mut self, ui: &mut egui::Ui, id: &str, root: bool) {
        let Some(connection) = self
            .board
            .connections
            .iter()
            .find(|connection| connection.id == id)
            .cloned()
        else {
            heading(
                ui,
                "Frontend preview",
                "This connection is no longer available.",
            );
            return;
        };
        heading(ui, &connection.name, &connection.url);
        ui.horizontal(|ui| {
            if ui.button("Open in browser").clicked() {
                if let Err(error) = preview::open_external(&connection) {
                    self.error = Some(error);
                }
            }
            if root && Preview::available() && ui.button("Reload").clicked() {
                if let Err(error) = self.preview.reload() {
                    self.error = Some(error);
                }
            }
            if ui.button("Edit").clicked() {
                self.show_dialog(ui, Dialog::connection(&connection));
            }
            if ui.button("Remove").clicked() {
                self.remove_connection(ui, &connection);
            }
        });
        if root && Preview::available() {
            let (rect, _) = ui.allocate_exact_size(
                ui.available_size().max(Vec2::splat(1.0)),
                egui::Sense::hover(),
            );
            self.preview_slot = Some((connection.url, rect));
        } else {
            ui.label("Use Open in browser to view this connection from this window.");
        }
    }

    fn remove_connection(&mut self, ui: &egui::Ui, connection: &Connection) {
        self.show_dialog(
            ui,
            Dialog::Confirm {
                title: "Remove frontend connection".into(),
                description: format!("Remove the saved connection to {}?", connection.name),
                action: Mutation::delete(
                    format!("/frontend-connections/{}", connection.id),
                    "Connection removed",
                ),
            },
        );
    }
}

fn priority(value: &str) -> u8 {
    match value {
        "URGENT" => 4,
        "HIGH" => 3,
        "MEDIUM" => 2,
        _ => 1,
    }
}

fn worklog_sections(content: &str) -> Vec<(&str, Vec<&str>)> {
    let mut sections: Vec<(&str, Vec<&str>)> = Vec::new();
    for line in content.lines() {
        if let Some(date) = line.strip_prefix("## ") {
            if chrono::NaiveDate::parse_from_str(date.trim(), "%Y/%m/%d").is_ok() {
                sections.push((date.trim(), Vec::new()));
            }
        } else if let Some(entry) = line.trim().strip_prefix("- ") {
            if let Some((_, entries)) = sections.last_mut() {
                entries.push(entry);
            }
        }
    }
    sections.retain(|(_, entries)| !entries.is_empty());
    sections.sort_by(|left, right| right.0.cmp(left.0));
    for (_, entries) in &mut sections {
        entries.reverse();
    }
    sections
}

#[cfg(test)]
mod tests {
    #[test]
    fn worklog_shows_latest_dates_and_entries_first() {
        let content = "# Log\n\n## 2026/11/10\n\n- First\n- Second\n\n## 2026/11/12\n\n- Latest\n";
        assert_eq!(
            super::worklog_sections(content),
            [
                ("2026/11/12", vec!["Latest"]),
                ("2026/11/10", vec!["Second", "First"])
            ]
        );
    }
}
