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
      CHECK (status IN ('TODO','CLAIMED','IN_PROGRESS','TESTING','IN_REVIEW','DONE','FAILED')),
    priority TEXT NOT NULL DEFAULT 'MEDIUM'
      CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
    branch_name TEXT,
    worktree_path TEXT,
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
    this.connection.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_claimable
        ON tasks(status, is_paused, priority, created_at, id);
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
