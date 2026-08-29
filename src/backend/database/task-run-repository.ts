import type { TaskRun } from '../domain/types.js';
import { type Clock, OrchestratorDatabase, systemClock } from './database.js';

export class TaskRunRepository {
  public constructor(
    private readonly database: OrchestratorDatabase,
    private readonly clock: Clock = systemClock
  ) {}

  public create(taskId: number): TaskRun {
    const result = this.database.connection
      .prepare(`
        INSERT INTO task_runs (task_id, started_at, stdout, stderr, result_summary)
        VALUES (?, ?, '', '', '')
      `)
      .run(taskId, this.clock());
    return this.findById(Number(result.lastInsertRowid)) as TaskRun;
  }

  public findById(id: number): TaskRun | null {
    const row = this.database.connection
      .prepare('SELECT * FROM task_runs WHERE id = ?')
      .get(id);
    return (row as unknown as TaskRun | undefined) ?? null;
  }

  public listForTask(taskId: number): TaskRun[] {
    return this.database.connection
      .prepare(`
        SELECT * FROM task_runs
        WHERE task_id = ?
        ORDER BY started_at DESC, id DESC
      `)
      .all(taskId) as unknown as TaskRun[];
  }

  public appendOutput(runId: number, stdout: string, stderr: string): void {
    this.database.connection
      .prepare(`
        UPDATE task_runs
        SET stdout = stdout || ?, stderr = stderr || ?
        WHERE id = ? AND finished_at IS NULL
      `)
      .run(stdout, stderr, runId);
  }

  public finish(runId: number, exitCode: number, resultSummary: string): void {
    this.database.connection
      .prepare(`
        UPDATE task_runs
        SET finished_at = ?, exit_code = ?, result_summary = ?
        WHERE id = ? AND finished_at IS NULL
      `)
      .run(this.clock(), exitCode, resultSummary, runId);
  }
}
