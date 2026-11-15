use crate::{
    api::Mutation,
    app::{status_color, CARD, MUTED},
    model::*,
};
use eframe::egui::{self, Color32, Pos2, Rect, RichText, Sense, Stroke, Vec2};
use serde_json::json;
use std::collections::{HashMap, HashSet};

pub enum GraphEvent {
    Task(Id),
    CreateTask(Id),
    CreateFeature(Id),
    Order(Id, Vec<String>),
    Confirm(String, String, Mutation),
}

#[derive(Clone, Copy)]
struct Camera {
    pan: Vec2,
    zoom: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            pan: Vec2::ZERO,
            zoom: 1.0,
        }
    }
}

#[derive(Default)]
pub struct GraphView {
    cameras: HashMap<(egui::ViewportId, Id), Camera>,
}

const COLORS: [Color32; 5] = [
    Color32::from_rgb(110, 179, 255),
    Color32::from_rgb(127, 221, 189),
    Color32::from_rgb(201, 152, 254),
    Color32::from_rgb(237, 178, 120),
    Color32::from_rgb(240, 136, 169),
];

impl GraphView {
    pub fn show(
        &mut self,
        ui: &mut egui::Ui,
        map: &BranchMap,
        speed: &mut u8,
        protected: &HashSet<Option<Id>>,
    ) -> Option<GraphEvent> {
        let mut event = None;
        let mut reset = false;
        let lanes: Vec<_> = map
            .branches
            .iter()
            .filter(|lane| !lane.is_primary)
            .collect();
        ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new(format!("Base: {}    Checkout: {}",
                map.primary_branch.as_deref().unwrap_or("—"), map.current_branch.as_deref().unwrap_or("—"))).color(MUTED));
            if ui.button("Reset view").clicked() { reset = true; }
            egui::ComboBox::from_id_salt("graph-zoom-speed").selected_text(format!("{}× zoom", *speed))
                .show_ui(ui, |ui| for value in 1..=3 { ui.selectable_value(speed, value, format!("{value}×")); });
            let has_branches = lanes.iter().any(|lane| lane.exists && lane.feature.is_some());
            if ui.add_enabled(has_branches && protected.is_empty(), egui::Button::new("Reset all to main"))
                .on_hover_text("Finish tasks in review or pending push before resetting branch pointers.").clicked() {
                event = Some(GraphEvent::Confirm("Reset all Feature pointers".into(),
                    format!("Move local Feature branches in {} to the latest main commit? Task history is retained.", map.project.name),
                    Mutation::post(format!("/projects/{}/features/reset-to-main", map.project.id), json!({}), "Feature pointers reset")));
            }
        });
        ui.label(
            RichText::new(
                "Drag the canvas to pan · Scroll to zoom · Click HEAD + or … for branch actions",
            )
            .color(MUTED),
        );
        let canvas_height = ui.available_height().max(160.0);
        let (rect, response) = ui.allocate_exact_size(
            Vec2::new(ui.available_width().max(1.0), canvas_height),
            Sense::drag(),
        );
        let camera = self
            .cameras
            .entry((ui.ctx().viewport_id(), map.project.id))
            .or_default();
        if reset {
            *camera = Camera::default();
        }
        if response.dragged() {
            camera.pan += ui.input(|input| input.pointer.delta());
        }
        if let Some(cursor) = ui
            .input(|input| input.pointer.hover_pos())
            .filter(|point| rect.contains(*point))
        {
            let scroll = ui.input(|input| input.smooth_scroll_delta);
            let previous = camera.zoom;
            camera.zoom =
                (previous * (scroll.y * 0.0015 * f32::from(*speed)).exp()).clamp(0.32, 2.4);
            camera.pan =
                cursor - rect.min - (cursor - rect.min - camera.pan) * (camera.zoom / previous);
            camera.pan.x += scroll.x;
        }

        let painter = ui.painter().with_clip_rect(rect);
        painter.rect_filled(rect, 9.0, Color32::from_rgb(10, 15, 24));
        let chart = Rect::from_min_max(Pos2::new(rect.left() + 174.0, rect.top()), rect.max);
        let lines = painter.with_clip_rect(chart);
        let origin = chart.min + camera.pan;
        let zoom = camera.zoom;
        let position = |x: f32, y: f32| origin + Vec2::new(x, y) * zoom;
        let label_pos = |y: f32| Pos2::new(rect.left() + 10.0, position(0.0, y).y);
        let top = 52.0;
        let step = 112.0;
        let spacing = 78.0;
        let main_color = COLORS[0];
        let main_label = map.primary_branch.as_deref().unwrap_or("main");
        painter.text(
            label_pos(top),
            egui::Align2::LEFT_CENTER,
            main_label,
            egui::FontId::proportional(14.0),
            main_color,
        );

        let mut commits: Vec<_> = map.primary_commits.iter().collect();
        commits.sort_by(|left, right| left.committed_at.cmp(&right.committed_at));
        let mut commit_x = HashMap::new();
        let main_end = (commits.len().max(1) as f32 + 0.4) * step;
        lines.line_segment(
            [position(24.0, top), position(main_end, top)],
            Stroke::new(2.0, main_color),
        );
        for (index, commit) in commits.into_iter().enumerate() {
            let x = 42.0 + index as f32 * step;
            commit_x.insert(commit.sha.as_str(), x);
            let point = position(x, top);
            if chart.contains(point) {
                let hit = node(ui, &lines, point, ("commit", &commit.sha), main_color, zoom);
                hit.on_hover_text(format!(
                    "{}  {}\n{}",
                    commit.short_sha, commit.summary, commit.committed_at
                ));
                caption(&lines, point, &commit.short_sha, main_color, zoom);
            }
        }
        let mut reorder = None;
        for (index, lane) in lanes.iter().enumerate() {
            let y = top + (index + 1) as f32 * spacing;
            let color = if lane.exists {
                COLORS[(index + 1) % COLORS.len()]
            } else {
                Color32::from_gray(104)
            };
            let label_point = label_pos(y) + Vec2::new(32.0, 0.0);
            let branch_label = if lane.is_current {
                format!("● {}", lane.name)
            } else {
                lane.name.clone()
            };
            if rect.contains(label_point) {
                let label_rect =
                    Rect::from_min_size(label_point - Vec2::new(1.0, 12.0), Vec2::new(127.0, 24.0));
                let menu_rect = Rect::from_center_size(
                    label_pos(y) + Vec2::new(12.0, 0.0),
                    Vec2::new(24.0, 24.0),
                );
                let mut menu_ui = ui.new_child(
                    egui::UiBuilder::new()
                        .id_salt(("branch-actions", &lane.name))
                        .max_rect(menu_rect),
                );
                menu_ui.set_clip_rect(rect);
                let menu = menu_ui
                    .add_sized(menu_rect.size(), egui::Button::new("…"))
                    .on_hover_text(format!("Actions for {}", lane.name));
                egui::Popup::menu(&menu).show(|ui| {
                    lane_menu(
                        ui,
                        map,
                        &lanes,
                        lane,
                        index,
                        protected,
                        &mut event,
                        &mut reorder,
                    );
                });

                let label_painter = painter.with_clip_rect(label_rect);
                label_painter.text(
                    label_point,
                    egui::Align2::LEFT_CENTER,
                    &branch_label,
                    egui::FontId::proportional(13.0),
                    color,
                );
                let response = ui
                    .interact(
                        label_rect,
                        ui.scope_id().with(("branch", &lane.name)),
                        Sense::click_and_drag(),
                    )
                    .on_hover_text(format!(
                        "{}\nAhead {} · Behind {}\nDrag to reorder",
                        lane.name,
                        lane.ahead.map_or_else(|| "—".into(), |v| v.to_string()),
                        lane.behind.map_or_else(|| "—".into(), |v| v.to_string())
                    ));
                if response.drag_stopped() {
                    if let Some(pointer) = ui.input(|input| input.pointer.hover_pos()) {
                        let target = ((pointer.y - origin.y) / zoom - top) / spacing - 1.0;
                        let target = (target.round() as usize).min(lanes.len() - 1);
                        if target != index {
                            reorder = Some((index, target));
                        }
                    }
                }
                response.context_menu(|ui| {
                    lane_menu(
                        ui,
                        map,
                        &lanes,
                        lane,
                        index,
                        protected,
                        &mut event,
                        &mut reorder,
                    );
                });
            }

            let fork = lane
                .fork_commit
                .as_ref()
                .and_then(|commit| commit_x.get(commit.sha.as_str()))
                .copied()
                .unwrap_or(42.0);
            let branch_start = fork + 44.0;
            let fork_points = [
                position(fork, top),
                position(fork, y - 18.0),
                position(branch_start, y),
            ];
            lines.add(egui::Shape::line(
                fork_points.to_vec(),
                Stroke::new(1.5, color.gamma_multiply(0.64)),
            ));
            let mut next = branch_start + 42.0;
            let has_reset = lane
                .feature
                .as_ref()
                .is_some_and(|feature| feature.pointer_reset_task_id.is_some());
            let mut pointer = false;
            let mut nodes = Vec::with_capacity(lane.tasks.len() + 1);
            for task in &lane.tasks {
                if has_reset && !pointer && !task.is_before_pointer_reset {
                    nodes.push((next, None));
                    next += step;
                    pointer = true;
                }
                nodes.push((next, Some(task)));
                next += step;
            }
            if has_reset && !pointer {
                nodes.push((next, None));
                next += step;
            }
            let head = position(next, y);
            lines.line_segment([position(branch_start, y), head], Stroke::new(2.0, color));
            for (x, task) in nodes {
                let point = position(x, y);
                if !chart.contains(point) {
                    continue;
                }
                if let Some(task) = task {
                    let node_color = if task.is_before_pointer_reset {
                        Color32::from_gray(113)
                    } else {
                        status_color(&task.status)
                    };
                    let hit = node(
                        ui,
                        &lines,
                        point,
                        ("task", &lane.name, task.id),
                        node_color,
                        zoom,
                    )
                    .on_hover_text(format!(
                        "#{}  {}\n{}\n{}",
                        task.id,
                        task.title,
                        status_label(&task.status),
                        task.commit_summary.as_deref().unwrap_or("")
                    ));
                    if hit.clicked() {
                        event = Some(GraphEvent::Task(task.id));
                    }
                    caption(&lines, point, &format!("#{}", task.id), node_color, zoom);
                } else {
                    lines.circle_stroke(point, 7.0 * zoom, Stroke::new(2.0, color));
                    caption(&lines, point, "POINTER", color, zoom);
                }
            }
            if chart.contains(head) {
                let available = lane.feature.is_some() || managed_branch(lane);
                let label = if available { "HEAD +" } else { "HEAD" };
                let radius = (7.0 * zoom).max(3.0);
                let hit_rect = Rect::from_center_size(head, Vec2::splat((27.0 * zoom).max(17.0)))
                    .union(Rect::from_center_size(
                        head + Vec2::new(0.0, 20.0 * zoom),
                        Vec2::new(48.0 * zoom.max(0.7), 18.0 * zoom.max(0.7)),
                    ))
                    .intersect(chart);
                let hit = ui.interact(
                    hit_rect,
                    ui.scope_id().with(("head", &lane.name)),
                    if available {
                        Sense::click()
                    } else {
                        Sense::hover()
                    },
                );
                lines.circle(
                    head,
                    radius,
                    if hit.hovered() && available {
                        color
                    } else {
                        CARD
                    },
                    Stroke::new(2.0, color),
                );
                caption(&lines, head, label, color, zoom);
                if available {
                    egui::Popup::menu(&hit).show(|ui| {
                        lane_menu(
                            ui,
                            map,
                            &lanes,
                            lane,
                            index,
                            protected,
                            &mut event,
                            &mut reorder,
                        );
                    });
                }
            }
        }
        if let Some((from, to)) = reorder {
            let mut names: Vec<_> = lanes.iter().map(|lane| lane.name.clone()).collect();
            let moved = names.remove(from);
            names.insert(to, moved);
            event = Some(GraphEvent::Order(map.project.id, names));
        }
        let plus = label_pos(top + (lanes.len() + 1) as f32 * spacing);
        if rect.contains(plus) {
            let hit = ui.interact(
                Rect::from_min_size(plus - Vec2::new(0.0, 13.0), Vec2::new(150.0, 28.0)),
                ui.scope_id().with("graph-new-feature"),
                Sense::click(),
            );
            painter.text(
                plus,
                egui::Align2::LEFT_CENTER,
                "+ New feature",
                egui::FontId::proportional(14.0),
                if hit.hovered() {
                    Color32::WHITE
                } else {
                    main_color
                },
            );
            if hit.clicked() {
                event = Some(GraphEvent::CreateFeature(map.project.id));
            }
        }
        event
    }
}

fn node(
    ui: &egui::Ui,
    painter: &egui::Painter,
    point: Pos2,
    id: impl egui::AsIdSalt,
    color: Color32,
    zoom: f32,
) -> egui::Response {
    let response = ui.interact(
        Rect::from_center_size(point, Vec2::splat((27.0 * zoom).max(17.0))),
        ui.scope_id().with(id),
        Sense::click(),
    );
    painter.circle(
        point,
        (7.0 * zoom).max(3.0),
        if response.hovered() { color } else { CARD },
        Stroke::new(2.0, color),
    );
    response
}

fn caption(painter: &egui::Painter, point: Pos2, label: &str, color: Color32, zoom: f32) {
    painter.text(
        point + Vec2::new(0.0, 13.0 * zoom),
        egui::Align2::CENTER_TOP,
        label,
        egui::FontId::monospace((11.0 * zoom).max(8.0)),
        color,
    );
}

fn managed_branch(lane: &Lane) -> bool {
    lane.exists && (lane.name.starts_with("feature/") || lane.name.starts_with("agent/"))
}

fn lane_menu(
    ui: &mut egui::Ui,
    map: &BranchMap,
    lanes: &[&Lane],
    lane: &Lane,
    index: usize,
    protected: &HashSet<Option<Id>>,
    event: &mut Option<GraphEvent>,
    reorder: &mut Option<(usize, usize)>,
) {
    if let Some(feature) = &lane.feature {
        if ui.button("New task").clicked() {
            *event = Some(GraphEvent::CreateTask(feature.id));
            ui.close();
        }
        if !lane.tasks.is_empty() {
            ui.menu_button("Review node", |ui| {
                for task in lane.tasks.iter().rev() {
                    if ui.button(format!("#{} {}", task.id, task.title)).clicked() {
                        *event = Some(GraphEvent::Task(task.id));
                        ui.close();
                    }
                }
            });
        } else {
            ui.add_enabled(false, egui::Button::new("Review node"))
                .on_disabled_hover_text("This branch has no task checkpoints.");
        }
        if ui
            .add_enabled(
                lane.exists && !protected.contains(&Some(feature.id)),
                egui::Button::new("Reset to main"),
            )
            .clicked()
        {
            *event = Some(GraphEvent::Confirm(
                "Reset Feature pointer".into(),
                format!(
                    "Move {} to the latest main commit? Existing tasks are kept.",
                    feature.branch_name
                ),
                Mutation::post(
                    format!("/features/{}/reset-to-main", feature.id),
                    json!({}),
                    "Feature pointer reset",
                ),
            ));
            ui.close();
        }
        if ui
            .add_enabled(lane.exists, egui::Button::new("Delete local Git branch"))
            .clicked()
        {
            *event = Some(GraphEvent::Confirm(
                "Delete local Git branch".into(),
                format!(
                    "Delete the local Git ref {}? The Feature record and task history are kept.",
                    lane.name
                ),
                Mutation::delete(
                    format!("/features/{}/git-branch", feature.id),
                    "Local branch deleted",
                ),
            ));
            ui.close();
        }
        if ui.button("Delete Feature record and branch").clicked() {
            *event = Some(GraphEvent::Confirm("Delete Feature record".into(),
                format!("Delete {} and its local Git ref? Existing tasks are kept and detached from the Feature.", feature.name),
                Mutation::delete(format!("/features/{}", feature.id), "Feature deleted")));
            ui.close();
        }
    } else if managed_branch(lane) {
        if lane.name.starts_with("feature/") && ui.button("Use as Feature to add tasks").clicked() {
            *event = Some(GraphEvent::Confirm(
                "Register existing branch".into(),
                format!(
                    "Link {} to a Feature so tasks can be added on this branch?",
                    lane.name
                ),
                Mutation::post(
                    "/features",
                    json!({ "project_id": map.project.id, "name": lane.name, "branch_name": lane.name }),
                    "Feature registered",
                ),
            ));
            ui.close();
        }
        if ui.button("Delete unconfigured local branch").clicked() {
            *event = Some(GraphEvent::Confirm(
                "Delete unconfigured local branch".into(),
                format!("Delete the local Git ref {}?", lane.name),
                Mutation {
                    method: "DELETE",
                    path: format!("/projects/{}/unconfigured-branches", map.project.id),
                    body: Some(json!({"branch_name": lane.name})),
                    label: "Local branch deleted".into(),
                },
            ));
            ui.close();
        }
    }
    if ui
        .add_enabled(index > 0, egui::Button::new("Move up"))
        .clicked()
    {
        *reorder = Some((index, index - 1));
        ui.close();
    }
    if ui
        .add_enabled(index + 1 < lanes.len(), egui::Button::new("Move down"))
        .clicked()
    {
        *reorder = Some((index, index + 1));
        ui.close();
    }
}
