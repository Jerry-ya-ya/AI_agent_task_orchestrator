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

const ACTIVE_STATUSES: readonly TaskStatus[] = ['CLAIMED', 'IN_PROGRESS', 'TESTING'];

export class TaskService {
  public constructor(
    private readonly tasks: TaskRepository,
    private readonly projects: ProjectRepository,
    private readonly runs: TaskRunRepository
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
    if (ACTIVE_STATUSES.includes(existing.status)) {
      throw new ConflictError('An active task cannot be edited.');
    }
    if (input.title !== undefined && input.title.trim().length === 0) {
      throw new ValidationError('Task title cannot be empty.');
    }
    if (input.project_id !== undefined) {
      this.requireProject(input.project_id);
      if (existing.branch_name !== null && input.project_id !== existing.project_id) {
        throw new ConflictError('A task with an existing worktree cannot move to another project.');
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
    if (ACTIVE_STATUSES.includes(existing.status)) {
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

  public approve(id: number): Task {
    this.requireTask(id);
    const updated = this.tasks.transition(id, 'IN_REVIEW', 'DONE');
    if (updated === null) {
      throw new ConflictError('Only IN_REVIEW tasks can be approved.');
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
