export const TASK_STATUSES = [
  'TODO',
  'CLAIMED',
  'IN_PROGRESS',
  'TESTING',
  'IN_REVIEW',
  'REVIEWING',
  'PENDING_PUSH',
  'CHERRY_PICK_CONFLICT',
  'PENDING_BRANCH_REMOVAL',
  'DONE',
  'REJECTED',
  'FAILED',
] as const;

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export const DEFAULT_MODEL_ID = 'gpt-6.1-sol';
export const MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ModelId = string;
export type ModelEffort = string;
export type AgentMode = 'implementation' | 'cherry_pick_resolution';

export interface AgentModelEffort {
  id: ModelEffort;
  description: string;
}

export interface AgentModel {
  id: ModelId;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: ModelEffort;
  supportedReasoningEfforts: AgentModelEffort[];
}

const STANDARD_EFFORTS: AgentModelEffort[] = MODEL_EFFORTS.map((id) => ({ id, description: '' }));
const LUNA_EFFORTS = STANDARD_EFFORTS.filter((effort) => effort.id !== 'ultra');
export const FALLBACK_AGENT_MODELS: AgentModel[] = [
  { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: STANDARD_EFFORTS },
  { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: STANDARD_EFFORTS },
  { id: 'gpt-6-sol', displayName: 'GPT-6-Sol', description: 'Previous generation workhorse model.', isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: STANDARD_EFFORTS },
  { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.', isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: LUNA_EFFORTS },
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'Older generation workhorse model.', isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: STANDARD_EFFORTS },
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', description: 'Older balanced model for straightforward work.', isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: STANDARD_EFFORTS },
  { id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', description: 'Older fast and efficient model.', isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: LUNA_EFFORTS },
];

export interface StatusColumn {
  status: TaskStatus;
  label: string;
  hint: string;
}

export interface Project {
  id: number;
  name: string;
  repository_path: string;
  context: string | null;
  created_at: string;
  updated_at: string;
}

export interface Feature {
  id: number;
  project_id: number;
  name: string;
  branch_name: string;
  base_branch: string;
  pointer_reset_task_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface FrontendConnection {
  id: string;
  name: string;
  url: string;
  created_at: string;
  updated_at: string;
}

export interface FrontendConnectionDraft {
  name: string;
  url: string;
}

export interface BranchTaskHistory {
  id: number;
  title: string;
  status: TaskStatus;
  commit_summary: string | null;
  is_before_pointer_reset: boolean;
  created_at: string;
  updated_at: string;
}

export interface BranchCommit {
  sha: string;
  short_sha: string;
  summary: string;
  committed_at: string;
}

export interface BranchLane {
  name: string;
  exists: boolean;
  is_current: boolean;
  is_primary: boolean;
  ahead: number | null;
  behind: number | null;
  fork_commit: BranchCommit | null;
  display_order?: number | null;
  feature: Feature | null;
  tasks: BranchTaskHistory[];
}

export interface ProjectBranchMap {
  project: Project;
  current_branch: string | null;
  primary_branch: string | null;
  primary_commits: BranchCommit[];
  branches: BranchLane[];
}

export interface TaskRun {
  id: number;
  task_id: number;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  result_summary: string;
  file_diff: string;
  code_diff: string;
}

export interface Task {
  id: number;
  project_id: number;
  feature_id?: number | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  model_id: ModelId;
  model_effort: ModelEffort;
  agent_mode: AgentMode;
  retry_prompt: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  base_branch: string | null;
  commit_summary: string | null;
  publish_commit_sha: string | null;
  source_task_id: number | null;
  is_rejected: boolean;
  is_paused: boolean;
  created_at: string;
  updated_at: string;
  latest_run: TaskRun | null;
}

export interface TaskDetail extends Task {
  project: Project;
  runs: TaskRun[];
}

export interface WorkerStatus {
  running: boolean;
  paused?: boolean;
  autoPaused?: boolean;
  quotaLoopEnabled?: boolean;
  quotaWaitingUntil?: number | null;
  busy: boolean;
  activeTaskId: number | null;
  agentAvailable: boolean;
  message: string;
}

export interface HealthResponse {
  ok: boolean;
  worker: WorkerStatus;
}

export interface AgentUsageWindow {
  remainingPercent: number;
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AgentUsage {
  available: boolean;
  planType: string | null;
  primary: AgentUsageWindow | null;
  secondary: AgentUsageWindow | null;
  resetCredits: number | null;
  checkedAt: string;
  message: string;
}

export interface CreateProjectInput {
  name: string;
  repository_path: string;
  context?: string;
}

export interface SaveTaskInput {
  project_id: number;
  feature_id: number;
  title: string;
  description: string;
  priority: TaskPriority;
  model_id: ModelId;
  model_effort: ModelEffort;
}

export interface ProjectDraft {
  name: string;
  repository_path: string;
  context: string;
}

export interface TaskDraft {
  project_id: number | null;
  feature_id: number | null;
  title: string;
  description: string;
  priority: TaskPriority;
  model_id: ModelId;
  model_effort: ModelEffort;
}

export interface FeatureDraft {
  project_id: number | null;
  name: string;
}

export interface RetryReviewInput {
  prompt: string;
}
