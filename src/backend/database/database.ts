import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    repository_path TEXT NOT NULL UNIQUE,
    context TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'TODO'
      CHECK (status IN ('TODO','CLAIMED','IN_PROGRESS','TESTING','IN_REVIEW','PENDING_PUSH','PENDING_BRANCH_REMOVAL','DONE','FAILED')),
    priority TEXT NOT NULL DEFAULT 'MEDIUM'
      CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
    model_effort TEXT NOT NULL DEFAULT 'medium'
      CHECK (model_effort IN ('low','medium','high','xhigh')),
    branch_name TEXT,
    worktree_path TEXT,
    base_branch TEXT,
    commit_summary TEXT,
    is_paused INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    exit_code INTEGER,
    stdout TEXT NOT NULL DEFAULT '',
    stderr TEXT NOT NULL DEFAULT '',
    result_summary TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_claim
    ON tasks(status, priority, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_task_runs_task_started
    ON task_runs(task_id, started_at DESC, id DESC);
`;

export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();

export class OrchestratorDatabase {
  public readonly connection: DatabaseSync;
  public readonly path: string;
  private closed = false;

  public constructor(databasePath: string) {
    this.path = databasePath === ':memory:' ? databasePath : resolve(databasePath);
    if (this.path !== ':memory:') {
      mkdirSync(dirname(this.path), { recursive: true });
    }

    this.connection = new DatabaseSync(this.path);
    this.connection.exec('PRAGMA foreign_keys = ON;');
    this.connection.exec('PRAGMA busy_timeout = 5000;');
    if (this.path !== ':memory:') {
      this.connection.exec('PRAGMA journal_mode = WAL;');
      this.connection.exec('PRAGMA synchronous = NORMAL;');
    }
    this.migrate();
  }

  public migrate(): void {
    this.assertOpen();
    this.connection.exec(SCHEMA);
    const taskColumns = this.connection.prepare('PRAGMA table_info(tasks)').all();
    if (!taskColumns.some((column) => column['name'] === 'is_paused')) {
      this.connection.exec(`
        ALTER TABLE tasks
        ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0, 1));
      `);
    }
    if (!taskColumns.some((column) => column['name'] === 'base_branch')) {
      this.connection.exec('ALTER TABLE tasks ADD COLUMN base_branch TEXT;');
    }
    if (!taskColumns.some((column) => column['name'] === 'commit_summary')) {
      this.connection.exec('ALTER TABLE tasks ADD COLUMN commit_summary TEXT;');
    }
    if (!taskColumns.some((column) => column['name'] === 'model_effort')) {
      this.connection.exec(`
        ALTER TABLE tasks ADD COLUMN model_effort TEXT NOT NULL DEFAULT 'medium'
          CHECK (model_effort IN ('low','medium','high','xhigh'));
      `);
    }

    const taskDefinition = this.connection.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'
    `).get() as { sql?: string } | undefined;
    const hadPendingPush = taskDefinition?.sql?.includes('PENDING_PUSH') ?? false;
    if (!taskDefinition?.sql?.includes('PENDING_BRANCH_REMOVAL')) {
      this.rebuildTasksForPublishing(hadPendingPush);
    }

    this.connection.exec(`
      UPDATE tasks
      SET commit_summary = (
        SELECT tr.result_summary
        FROM task_runs tr
        WHERE tr.task_id = tasks.id AND TRIM(tr.result_summary) <> ''
        ORDER BY tr.started_at DESC, tr.id DESC
        LIMIT 1
      )
      WHERE status IN ('PENDING_PUSH', 'PENDING_BRANCH_REMOVAL') AND commit_summary IS NULL;
    `);
    this.connection.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_claimable
        ON tasks(status, is_paused, priority, created_at, id);
    `);
  }

  private rebuildTasksForPublishing(hadPendingPush: boolean): void {
    const migratedDoneStatus = hadPendingPush ? 'PENDING_BRANCH_REMOVAL' : 'PENDING_PUSH';
    this.connection.exec('PRAGMA foreign_keys = OFF;');
    try {
      this.connection.exec(`
        BEGIN IMMEDIATE;
        DROP INDEX IF EXISTS idx_tasks_claim;
        DROP INDEX IF EXISTS idx_tasks_claimable;
        DROP INDEX IF EXISTS idx_task_runs_task_started;
        ALTER TABLE task_runs RENAME TO task_runs_before_publishing;
        ALTER TABLE tasks RENAME TO tasks_before_publishing;

        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'TODO'
            CHECK (status IN ('TODO','CLAIMED','IN_PROGRESS','TESTING','IN_REVIEW','PENDING_PUSH','PENDING_BRANCH_REMOVAL','DONE','FAILED')),
          priority TEXT NOT NULL DEFAULT 'MEDIUM'
            CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
          model_effort TEXT NOT NULL DEFAULT 'medium'
            CHECK (model_effort IN ('low','medium','high','xhigh')),
          branch_name TEXT,
          worktree_path TEXT,
          base_branch TEXT,
          commit_summary TEXT,
          is_paused INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO tasks (
          id, project_id, title, description, status, priority, model_effort,
          branch_name, worktree_path, base_branch, commit_summary,
          is_paused, created_at, updated_at
        )
        SELECT
          id, project_id, title, description,
          CASE
            WHEN status = 'DONE' AND branch_name IS NOT NULL THEN '${migratedDoneStatus}'
            ELSE status
          END,
          priority, 'medium', branch_name, worktree_path, base_branch, commit_summary,
          is_paused, created_at, updated_at
        FROM tasks_before_publishing;

        CREATE TABLE task_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          exit_code INTEGER,
          stdout TEXT NOT NULL DEFAULT '',
          stderr TEXT NOT NULL DEFAULT '',
          result_summary TEXT NOT NULL DEFAULT ''
        );

        INSERT INTO task_runs (
          id, task_id, started_at, finished_at, exit_code, stdout, stderr, result_summary
        )
        SELECT id, task_id, started_at, finished_at, exit_code, stdout, stderr, result_summary
        FROM task_runs_before_publishing;

        DROP TABLE task_runs_before_publishing;
        DROP TABLE tasks_before_publishing;
        COMMIT;
      `);
    } catch (error) {
      try {
        this.connection.exec('ROLLBACK;');
      } catch {
        // The original migration error is more useful than a secondary rollback error.
      }
      throw error;
    } finally {
      this.connection.exec('PRAGMA foreign_keys = ON;');
    }

    this.connection.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_claim
        ON tasks(status, priority, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_task_runs_task_started
        ON task_runs(task_id, started_at DESC, id DESC);
    `);
  }

  public transaction<T>(operation: () => T): T {
    this.assertOpen();
    this.connection.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.connection.exec('COMMIT;');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK;');
      throw error;
    }
  }

  public close(): void {
    if (!this.closed) {
      this.connection.close();
      this.closed = true;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Database is already closed.');
    }
  }
}
