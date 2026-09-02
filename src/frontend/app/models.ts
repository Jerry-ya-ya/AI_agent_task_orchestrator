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
  'FAILED',
] as const;

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface Project {
  id: number;
  name: string;
  repository_path: string;
  context: string | null;
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

export interface Task {
  id: number;
  project_id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  branch_name: string | null;
  worktree_path: string | null;
  base_branch: string | null;
  commit_summary: string | null;
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
  title: string;
  description: string;
  priority: TaskPriority;
}

export interface ProjectDraft {
  name: string;
  repository_path: string;
  context: string;
}

export interface TaskDraft {
  project_id: number | null;
  title: string;
  description: string;
  priority: TaskPriority;
}

export interface RetryReviewInput {
  prompt: string;
}
