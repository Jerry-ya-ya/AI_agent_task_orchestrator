import type {
  ClaimedTask,
  CreateTaskInput,
  Project,
  Task,
  TaskListItem,
  TaskPriority,
  TaskRun,
  TaskStatus,
  UpdateTaskInput
} from '../domain/types.js';
import { type Clock, OrchestratorDatabase, systemClock } from './database.js';
import { TaskRunRepository } from './task-run-repository.js';

interface StoredTask extends Omit<Task, 'is_paused' | 'is_rejected'> {
  is_paused: number;
  is_rejected: number;
}

interface TaskListRow extends StoredTask {
  project_name: string;
  run_id: number | null;
  run_task_id: number | null;
  run_started_at: string | null;
  run_finished_at: string | null;
  run_exit_code: number | null;
  run_stdout: string | null;
  run_stderr: string | null;
  run_result_summary: string | null;
}

export interface TaskFilters {
  projectId?: number;
  status?: TaskStatus;
}

export class TaskRepository {
  public constructor(
    private readonly database: OrchestratorDatabase,
    private readonly runs: TaskRunRepository,
    private readonly clock: Clock = systemClock
  ) {}

  public list(filters: TaskFilters = {}): TaskListItem[] {
    const conditions: string[] = [];
    const parameters: Array<number | string> = [];
    if (filters.projectId !== undefined) {
      conditions.push('t.project_id = ?');
      parameters.push(filters.projectId);
    }
    if (filters.status !== undefined) {
      conditions.push('t.status = ?');
      parameters.push(filters.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.database.connection.prepare(`
      SELECT
        t.*,
        p.name AS project_name,
        r.id AS run_id,
        r.task_id AS run_task_id,
        r.started_at AS run_started_at,
        r.finished_at AS run_finished_at,
        r.exit_code AS run_exit_code,
        r.stdout AS run_stdout,
        r.stderr AS run_stderr,
        r.result_summary AS run_result_summary
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      LEFT JOIN task_runs r ON r.id = (
        SELECT tr.id FROM task_runs tr
        WHERE tr.task_id = t.id
        ORDER BY tr.started_at DESC, tr.id DESC
        LIMIT 1
      )
      ${where}
      ORDER BY
        CASE t.priority
          WHEN 'URGENT' THEN 4
          WHEN 'HIGH' THEN 3
          WHEN 'MEDIUM' THEN 2
          ELSE 1
        END DESC,
        t.created_at ASC,
        t.id ASC
    `).all(...parameters) as unknown as TaskListRow[];

    return rows.map((row) => this.mapListRow(row));
  }

  public findById(id: number): Task | null {
    const row = this.database.connection.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row === undefined ? null : this.mapStoredTask(row as unknown as StoredTask);
  }

  public findListItemById(id: number): TaskListItem | null {
    const task = this.list().find((item) => item.id === id);
    return task ?? null;
  }

  public create(input: Required<CreateTaskInput>): Task {
    const now = this.clock();
    const result = this.database.connection.prepare(`
      INSERT INTO tasks (
        project_id, title, description, status, priority,
        branch_name, worktree_path, base_branch, commit_summary,
        source_task_id, is_rejected, is_paused, created_at, updated_at
      ) VALUES (?, ?, ?, 'TODO', ?, NULL, NULL, NULL, NULL, NULL, 0, 0, ?, ?)
    `).run(input.project_id, input.title, input.description, input.priority, now, now);
    return this.findById(Number(result.lastInsertRowid)) as Task;
  }

  public createReviewRetry(source: Task, prompt: string): Task {
    return this.database.transaction(() => {
      const now = this.clock();
      const result = this.database.connection.prepare(`
        INSERT INTO tasks (
          project_id, title, description, status, priority,
          branch_name, worktree_path, base_branch, commit_summary,
          source_task_id, is_rejected, is_paused, created_at, updated_at
        ) VALUES (?, ?, ?, 'TODO', ?, ?, ?, ?, NULL, ?, 0, 0, ?, ?)
      `).run(
        source.project_id, source.title, prompt, source.priority,
        source.branch_name, source.worktree_path, source.base_branch, source.id, now, now
      );
      this.database.connection.prepare(`
        UPDATE tasks SET status = 'REJECTED', updated_at = ?
        WHERE id = ? AND status = 'IN_REVIEW'
      `).run(now, source.id);
      return this.findById(Number(result.lastInsertRowid)) as Task;
    });
  }

  public rejectForBranchRemoval(id: number): Task | null {
    const result = this.database.connection.prepare(`
      UPDATE tasks SET status = 'PENDING_BRANCH_REMOVAL', is_rejected = 1, updated_at = ?
      WHERE id = ? AND status = 'IN_REVIEW'
    `).run(this.clock(), id);
    return result.changes > 0 ? this.findById(id) : null;
  }

  public update(id: number, input: UpdateTaskInput): Task | null {
    const fields: string[] = [];
    const parameters: Array<number | string> = [];
    if (input.project_id !== undefined) {
      fields.push('project_id = ?');
      parameters.push(input.project_id);
    }
    if (input.title !== undefined) {
      fields.push('title = ?');
      parameters.push(input.title);
    }
    if (input.description !== undefined) {
      fields.push('description = ?');
      parameters.push(input.description);
    }
    if (input.priority !== undefined) {
      fields.push('priority = ?');
      parameters.push(input.priority);
    }
    if (fields.length === 0) {
      return this.findById(id);
    }
    fields.push('updated_at = ?');
    parameters.push(this.clock(), id);
    this.database.connection
      .prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`)
      .run(...parameters);
    return this.findById(id);
  }

  public delete(id: number): boolean {
    const result = this.database.connection.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  public claimNext(): ClaimedTask | null {
    return this.database.transaction(() => {
      const now = this.clock();
      const row = this.database.connection.prepare(`
        UPDATE tasks
        SET status = 'CLAIMED', updated_at = ?
        WHERE id = (
          SELECT id FROM tasks
          WHERE status = 'TODO' AND is_paused = 0
          ORDER BY
            CASE priority
              WHEN 'URGENT' THEN 4
              WHEN 'HIGH' THEN 3
              WHEN 'MEDIUM' THEN 2
              ELSE 1
            END DESC,
            created_at ASC,
            id ASC
          LIMIT 1
        )
        AND status = 'TODO' AND is_paused = 0
        RETURNING *
      `).get(now) as unknown as StoredTask | undefined;

      if (row === undefined) {
        return null;
      }

      const project = this.database.connection
        .prepare('SELECT * FROM projects WHERE id = ?')
        .get(row.project_id) as unknown as Project;
      const run = this.runs.create(row.id);
      return { ...this.mapStoredTask(row), project, run_id: run.id };
    });
  }

  public setPaused(id: number, paused: boolean): Task | null {
    const result = this.database.connection.prepare(`
      UPDATE tasks SET is_paused = ?, updated_at = ?
      WHERE id = ? AND status = 'TODO' AND is_paused = ?
    `).run(paused ? 1 : 0, this.clock(), id, paused ? 0 : 1);
    return result.changes > 0 ? this.findById(id) : null;
  }

  public setArtifacts(
    id: number,
    branchName: string,
    worktreePath: string,
    baseBranch: string
  ): Task | null {
    this.database.connection.prepare(`
      UPDATE tasks
      SET branch_name = ?, worktree_path = ?, base_branch = ?, updated_at = ?
      WHERE id = ? AND status = 'CLAIMED'
    `).run(branchName, worktreePath, baseBranch, this.clock(), id);
    return this.findById(id);
  }

  public setCommitSummary(id: number, commitSummary: string): Task | null {
    const result = this.database.connection.prepare(`
      UPDATE tasks SET commit_summary = ?, updated_at = ?
      WHERE id = ? AND status = 'TESTING'
    `).run(commitSummary, this.clock(), id);
    return result.changes > 0 ? this.findById(id) : null;
  }

  public setBaseBranch(id: number, baseBranch: string): Task | null {
    const result = this.database.connection.prepare(`
      UPDATE tasks SET base_branch = ?, updated_at = ?
      WHERE id = ? AND status = 'PENDING_PUSH'
    `).run(baseBranch, this.clock(), id);
    return result.changes > 0 ? this.findById(id) : null;
  }

  public transition(
    id: number,
    from: TaskStatus | readonly TaskStatus[],
    to: TaskStatus
  ): Task | null {
    const fromStatuses = Array.isArray(from) ? from : [from];
    const placeholders = fromStatuses.map(() => '?').join(', ');
    const result = this.database.connection.prepare(`
      UPDATE tasks SET status = ?, updated_at = ?
      WHERE id = ? AND status IN (${placeholders})
    `).run(to, this.clock(), id, ...fromStatuses);
    return result.changes > 0 ? this.findById(id) : null;
  }

  public recoverInterrupted(): number {
    return this.database.transaction(() => {
      const now = this.clock();
      const activeRows = this.database.connection.prepare(`
        SELECT id FROM tasks
        WHERE status IN ('CLAIMED', 'IN_PROGRESS', 'TESTING')
      `).all() as unknown as Array<{ id: number }>;
      if (activeRows.length === 0) {
        return 0;
      }
      const taskIds = activeRows.map((row) => row.id);
      const placeholders = taskIds.map(() => '?').join(', ');
      const taskResult = this.database.connection.prepare(`
        UPDATE tasks
        SET status = 'FAILED', updated_at = ?
        WHERE id IN (${placeholders})
      `).run(now, ...taskIds);
      this.database.connection.prepare(`
        UPDATE task_runs
        SET finished_at = ?, exit_code = 130,
            stderr = stderr || ?,
            result_summary = 'Application stopped before the task pipeline completed.'
        WHERE finished_at IS NULL
          AND task_id IN (${placeholders})
      `).run(
        now,
        '\n[orchestrator] Interrupted during application shutdown or restart.\n',
        ...taskIds
      );
      return Number(taskResult.changes);
    });
  }

  private mapListRow(row: TaskListRow): TaskListItem {
    const {
      run_id,
      run_task_id,
      run_started_at,
      run_finished_at,
      run_exit_code,
      run_stdout,
      run_stderr,
      run_result_summary,
      ...task
    } = row;

    const latestRun: TaskRun | null = run_id === null ? null : {
      id: run_id,
      task_id: run_task_id as number,
      started_at: run_started_at as string,
      finished_at: run_finished_at,
      exit_code: run_exit_code,
      stdout: run_stdout ?? '',
      stderr: run_stderr ?? '',
      result_summary: run_result_summary ?? ''
    };

    return {
      ...task,
      is_paused: task.is_paused === 1,
      is_rejected: task.is_rejected === 1,
      latest_run: latestRun
    };
  }

  private mapStoredTask(task: StoredTask): Task {
    return { ...task, is_paused: task.is_paused === 1, is_rejected: task.is_rejected === 1 };
  }
}
