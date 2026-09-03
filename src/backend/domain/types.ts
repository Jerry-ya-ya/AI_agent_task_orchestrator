export const TASK_STATUSES = [
  'TODO',
  'CLAIMED',
  'IN_PROGRESS',
  'TESTING',
  'IN_REVIEW',
  'PENDING_PUSH',
  'PENDING_BRANCH_REMOVAL',
  'DONE',
  'REJECTED',
  'FAILED'
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const MODEL_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

export interface Project {
  id: number;
  name: string;
  repository_path: string;
  context: string;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: number;
  project_id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  model_effort: ModelEffort;
  retry_prompt: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  base_branch: string | null;
  commit_summary: string | null;
  source_task_id: number | null;
  is_rejected: boolean;
  is_paused: boolean;
  created_at: string;
  updated_at: string;
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
}

export interface TaskListItem extends Task {
  project_name: string;
  latest_run: TaskRun | null;
}

export interface TaskDetails extends TaskListItem {
  project: Project;
  runs: TaskRun[];
}

export interface ClaimedTask extends Task {
  project: Project;
  run_id: number;
}

export interface CreateProjectInput {
  name: string;
  repository_path: string;
  context?: string;
}

export interface CreateTaskInput {
  project_id: number;
  title: string;
  description?: string;
  priority?: TaskPriority;
  model_effort?: ModelEffort;
}

export interface UpdateTaskInput {
  project_id?: number;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  model_effort?: ModelEffort;
}

export interface RetryTaskInput {
  prompt: string;
  model_effort?: ModelEffort;
}

export interface RetryReviewInput {
  prompt: string;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface AgentExecutionResult extends ProcessResult {
  summary: string;
}

export interface TestExecutionResult extends ProcessResult {
  executed: boolean;
  verificationKind: 'test' | 'build' | 'none';
  summary: string;
  commandDescription: string;
}

export interface AgentAvailability {
  available: boolean;
  message: string;
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

export interface WorkerStatus {
  running: boolean;
  busy: boolean;
  activeTaskId: number | null;
  agentAvailable: boolean;
  message: string;
}
