import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type {
  CreateTaskInput,
  Task,
  TaskDetails,
  TaskListItem,
  TaskRun,
  TaskStatus,
  UpdateTaskInput
} from '../domain/types.js';
import { ProjectRepository } from '../database/project-repository.js';
import { type TaskFilters, TaskRepository } from '../database/task-repository.js';
import { TaskRunRepository } from '../database/task-run-repository.js';
import { GitService } from './git-service.js';

const LOCKED_STATUSES: readonly TaskStatus[] = [
  'CLAIMED',
  'IN_PROGRESS',
  'TESTING',
  'PENDING_PUSH',
  'PENDING_BRANCH_REMOVAL'
];

export class TaskService {
  public constructor(
    private readonly tasks: TaskRepository,
    private readonly projects: ProjectRepository,
    private readonly runs: TaskRunRepository,
    private readonly git: GitService
  ) {}

  public list(filters: TaskFilters = {}): TaskListItem[] {
    return this.tasks.list(filters);
  }

  public get(id: number): TaskDetails {
    const item = this.tasks.findListItemById(id);
    if (item === null) {
      throw new NotFoundError(`Task ${id} was not found.`);
    }
    const project = this.projects.findById(item.project_id);
    if (project === null) {
      throw new NotFoundError(`Project ${item.project_id} was not found.`);
    }
    return { ...item, project, runs: this.runs.listForTask(id) };
  }

  public runsForTask(id: number): TaskRun[] {
    this.requireTask(id);
    return this.runs.listForTask(id);
  }

  public create(input: CreateTaskInput): Task {
    this.requireProject(input.project_id);
    const title = input.title.trim();
    if (title.length === 0) {
      throw new ValidationError('Task title is required.');
    }
    return this.tasks.create({
      project_id: input.project_id,
      title,
      description: input.description?.trim() ?? '',
      priority: input.priority ?? 'MEDIUM'
    });
  }

  public update(id: number, input: UpdateTaskInput): Task {
    const existing = this.requireTask(id);
    if (LOCKED_STATUSES.includes(existing.status)) {
      throw new ConflictError('An active task cannot be edited.');
    }
    if (input.title !== undefined && input.title.trim().length === 0) {
      throw new ValidationError('Task title cannot be empty.');
    }
    if (input.project_id !== undefined) {
      this.requireProject(input.project_id);
      if (existing.branch_name !== null && input.project_id !== existing.project_id) {
        throw new ConflictError('A task with an existing Git branch cannot move to another project.');
      }
    }
    const updated = this.tasks.update(id, {
      ...input,
      title: input.title?.trim(),
      description: input.description?.trim()
    });
    if (updated === null) {
      throw new NotFoundError(`Task ${id} was not found.`);
    }
    return updated;
  }

  public delete(id: number): void {
    const existing = this.requireTask(id);
    if (LOCKED_STATUSES.includes(existing.status)) {
      throw new ConflictError('An active task cannot be deleted.');
    }
    this.tasks.delete(id);
  }

  public retry(id: number): Task {
    this.requireTask(id);
    const updated = this.tasks.transition(id, 'FAILED', 'TODO');
    if (updated === null) {
      throw new ConflictError('Only FAILED tasks can be retried.');
    }
    return updated;
  }

  public retryReview(id: number, prompt: string): Task {
    const task = this.requireTask(id);
    if (task.status !== 'IN_REVIEW') {
      throw new ConflictError('Only IN_REVIEW tasks can be revised.');
    }
    const revisionPrompt = prompt.trim();
    if (revisionPrompt.length === 0) {
      throw new ValidationError('A revision prompt is required.');
    }
    return this.tasks.createReviewRetry(task, revisionPrompt);
  }

  public async reject(id: number): Promise<Task> {
    const task = this.requireTask(id);
    if (task.status !== 'IN_REVIEW') {
      throw new ConflictError('Only IN_REVIEW tasks can be rejected.');
    }
    const updated = this.tasks.rejectForBranchRemoval(id);
    if (updated === null) {
      throw new ConflictError('Task state changed while rejection was being queued.');
    }
    return updated;
  }

  public approve(id: number): Task {
    this.requireTask(id);
    const updated = this.tasks.transition(id, 'IN_REVIEW', 'PENDING_PUSH');
    if (updated === null) {
      throw new ConflictError('Only IN_REVIEW tasks can be approved.');
    }
    return updated;
  }

  public async push(id: number): Promise<Task> {
    const task = this.requireTask(id);
    if (task.status !== 'PENDING_PUSH') {
      throw new ConflictError('Only PENDING_PUSH tasks can be pushed.');
    }
    if (task.branch_name === null) {
      throw new ConflictError('The task has no Git branch to publish.');
    }
    const project = this.projects.findById(task.project_id);
    if (project === null) {
      throw new NotFoundError(`Project ${task.project_id} was not found.`);
    }

    const published = await this.git.publishBranch(
      project.repository_path,
      task.branch_name,
      task.base_branch
    );
    if (task.base_branch === null) {
      this.tasks.setBaseBranch(id, published.baseBranch);
    }
    const updated = this.tasks.transition(id, 'PENDING_PUSH', 'PENDING_BRANCH_REMOVAL');
    if (updated === null) {
      throw new ConflictError('Task state changed while its branch was being pushed.');
    }
    return updated;
  }

  public async removeBranch(id: number): Promise<Task> {
    const task = this.requireTask(id);
    if (task.status !== 'PENDING_BRANCH_REMOVAL') {
      throw new ConflictError('Only PENDING_BRANCH_REMOVAL tasks can remove their task branch.');
    }
    if (task.branch_name === null) {
      throw new ConflictError('The task has no Git branch to remove.');
    }
    const project = this.projects.findById(task.project_id);
    if (project === null) {
      throw new NotFoundError(`Project ${task.project_id} was not found.`);
    }

    await this.git.removeTaskBranch(
      project.repository_path,
      task.branch_name,
      task.base_branch
    );
    const updated = this.tasks.transition(
      id,
      'PENDING_BRANCH_REMOVAL',
      task.is_rejected ? 'REJECTED' : 'DONE'
    );
    if (updated === null) {
      throw new ConflictError('Task state changed while its branch was being removed.');
    }
    return updated;
  }

  public pause(id: number): Task {
    this.requireTask(id);
    const updated = this.tasks.setPaused(id, true);
    if (updated === null) {
      throw new ConflictError('Only an active TODO task can be paused.');
    }
    return updated;
  }

  public resume(id: number): Task {
    this.requireTask(id);
    const updated = this.tasks.setPaused(id, false);
    if (updated === null) {
      throw new ConflictError('Only a paused TODO task can be resumed.');
    }
    return updated;
  }

  private requireTask(id: number): Task {
    const task = this.tasks.findById(id);
    if (task === null) {
      throw new NotFoundError(`Task ${id} was not found.`);
    }
    return task;
  }

  private requireProject(id: number): void {
    if (this.projects.findById(id) === null) {
      throw new ValidationError(`Project ${id} does not exist.`);
    }
  }
}
