import type { Project, Task, TaskRun, TaskStatus } from './models';

const PRIORITY_WEIGHT = { LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 4 } as const;

export function tasksForStatus(tasks: readonly Task[], status: TaskStatus): Task[] {
  return tasks
    .filter((task) => task.status === status)
    .sort((left, right) => {
      const priorityDifference = PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority];
      return priorityDifference || left.created_at.localeCompare(right.created_at);
    });
}

export function completedTaskHistory(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((task) => task.status === 'DONE' || task.status === 'REJECTED' || task.status === 'FAILED')
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id - left.id);
}

export function projectName(projects: readonly Project[], projectId: number): string {
  return projects.find((project) => project.id === projectId)?.name ?? 'Unknown project';
}

export function latestTaskResult(task: Task): string {
  if (task.status === 'TODO' && task.is_paused) {
    return 'Paused — the worker will skip this task.';
  }
  const summary = task.latest_run?.result_summary?.trim();
  if (summary) return summary;
  if (task.status === 'CLAIMED' || task.status === 'IN_PROGRESS' || task.status === 'TESTING') {
    return 'Worker is processing this task.';
  }
  return 'No execution result yet.';
}

export function statusLabel(columns: readonly { status: TaskStatus; label: string }[], status: TaskStatus): string {
  return columns.find((column) => column.status === status)?.label ?? status;
}

export function trackTask(_index: number, task: Task): number {
  return task.id;
}

export function trackRun(_index: number, run: TaskRun): number {
  return run.id;
}
