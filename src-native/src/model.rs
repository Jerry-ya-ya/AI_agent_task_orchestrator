use serde::Deserialize;

pub type Id = u64;

#[derive(Clone, Deserialize)]
pub struct Project {
    pub id: Id,
    pub name: String,
    pub repository_path: String,
    pub context: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct Feature {
    pub id: Id,
    pub project_id: Id,
    pub name: String,
    pub branch_name: String,
    pub pointer_reset_task_id: Option<Id>,
}

#[derive(Clone, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub url: String,
}

#[derive(Clone, Deserialize)]
pub struct Task {
    pub id: Id,
    pub project_id: Id,
    pub feature_id: Option<Id>,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub model_id: String,
    pub model_effort: String,
    pub agent_mode: String,
    pub retry_prompt: Option<String>,
    pub branch_name: Option<String>,
    pub worktree_path: Option<String>,
    pub base_branch: Option<String>,
    pub commit_summary: Option<String>,
    pub publish_commit_sha: Option<String>,
    pub source_task_id: Option<Id>,
    pub is_rejected: bool,
    pub is_paused: bool,
    pub created_at: String,
    pub updated_at: String,
    pub latest_run: Option<Run>,
}

#[derive(Clone, Deserialize)]
pub struct Detail {
    #[serde(flatten)]
    pub task: Task,
    pub project: Project,
    pub runs: Vec<Run>,
}

#[derive(Clone, Deserialize)]
pub struct Run {
    pub id: Id,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub exit_code: Option<i64>,
    pub result_summary: String,
    pub stdout: String,
    pub stderr: String,
    pub file_diff: String,
    pub code_diff: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worker {
    pub running: bool,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub auto_paused: bool,
    #[serde(default)]
    pub quota_loop_enabled: bool,
    pub quota_waiting_until: Option<i64>,
    pub busy: bool,
    pub active_task_id: Option<Id>,
    pub agent_available: bool,
    pub message: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub available: bool,
    pub plan_type: Option<String>,
    pub primary: Option<UsageWindow>,
    pub secondary: Option<UsageWindow>,
    pub reset_credits: Option<f64>,
    pub checked_at: String,
    pub message: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub remaining_percent: f32,
    pub window_duration_mins: Option<u32>,
    pub resets_at: Option<i64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<Effort>,
}

#[derive(Clone, Deserialize)]
pub struct Effort {
    pub id: String,
    pub description: String,
}

#[derive(Clone, Deserialize)]
pub struct BranchMap {
    pub project: Project,
    pub current_branch: Option<String>,
    pub primary_branch: Option<String>,
    pub primary_commits: Vec<Commit>,
    pub branches: Vec<Lane>,
}

#[derive(Clone, Deserialize)]
pub struct Lane {
    pub name: String,
    pub exists: bool,
    pub is_current: bool,
    pub is_primary: bool,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub fork_commit: Option<Commit>,
    pub feature: Option<Feature>,
    pub tasks: Vec<BranchTask>,
}

#[derive(Clone, Deserialize)]
pub struct Commit {
    pub sha: String,
    pub short_sha: String,
    pub summary: String,
    pub committed_at: String,
}

#[derive(Clone, Deserialize)]
pub struct BranchTask {
    pub id: Id,
    pub title: String,
    pub status: String,
    pub commit_summary: Option<String>,
    pub is_before_pointer_reset: bool,
}

pub const STATUSES: &[(&str, &str)] = &[
    ("TODO", "Todo"),
    ("IN_PROGRESS", "In progress"),
    ("TESTING", "Testing"),
    ("IN_REVIEW", "In review"),
    ("REVIEWING", "Reviewing"),
    ("PENDING_PUSH", "Pending push"),
    ("CHERRY_PICK_CONFLICT", "Cherry-pick conflict"),
    ("PENDING_BRANCH_REMOVAL", "Branch cleanup"),
    ("DONE", "Done"),
    ("REJECTED", "Rejected"),
    ("FAILED", "Failed"),
];

pub fn status_label(status: &str) -> &str {
    STATUSES
        .iter()
        .find(|(id, _)| *id == status)
        .map_or(status, |(_, label)| label)
}

pub fn is_archived(task: &Task) -> bool {
    matches!(task.status.as_str(), "DONE" | "REJECTED" | "FAILED")
}

pub fn protects_pointer(task: &Task) -> bool {
    matches!(
        task.status.as_str(),
        "IN_REVIEW" | "REVIEWING" | "PENDING_PUSH"
    )
}

pub fn fallback_models() -> Vec<Model> {
    [
        ("gpt-6.1-sol", "GPT-6.1-Sol", "low"),
        ("gpt-6-astra", "GPT-6-Astra", "low"),
        ("gpt-6-sol", "GPT-6-Sol", "medium"),
        ("gpt-6-luna", "GPT-6-Luna", "medium"),
        ("gpt-5.6-sol", "GPT-5.6-Sol", "low"),
        ("gpt-5.6-terra", "GPT-5.6-Terra", "medium"),
        ("gpt-5.6-luna", "GPT-5.6-Luna", "medium"),
    ]
    .into_iter()
    .map(|(id, name, effort)| Model {
        id: id.into(),
        display_name: name.into(),
        description: String::new(),
        is_default: id == "gpt-6.1-sol",
        default_reasoning_effort: effort.into(),
        supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"]
            .into_iter()
            .filter(|value| id != "gpt-6-luna" || *value != "ultra")
            .map(|value| Effort {
                id: value.into(),
                description: String::new(),
            })
            .collect(),
    })
    .collect()
}
