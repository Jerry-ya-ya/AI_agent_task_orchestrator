import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { OrchestratorDatabase } from './database.js';
import { ProjectRepository } from './project-repository.js';
import { TaskRepository } from './task-repository.js';
import { TaskRunRepository } from './task-run-repository.js';

describe('OrchestratorDatabase schema', () => {
  let database: OrchestratorDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it('creates the required tables and enforces task status and priority values', () => {
    database = new OrchestratorDatabase(':memory:');

    const tables = database.connection
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('projects', 'tasks', 'task_runs')
        ORDER BY name
      `)
      .all()
      .map((row) => String(row['name']));

    expect(tables).toEqual(['projects', 'task_runs', 'tasks']);

    database.connection.prepare(`
      INSERT INTO projects (name, repository_path, context, created_at, updated_at)
      VALUES ('Example', '/example', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();

    const insertTask = database.connection.prepare(`
      INSERT INTO tasks (
        project_id, title, description, status, priority,
        branch_name, worktree_path, created_at, updated_at
      ) VALUES (1, 'Task', '', ?, ?, NULL, NULL, ?, ?)
    `);

    expect(() => insertTask.run(
      'NOT_A_STATUS',
      'MEDIUM',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    )).toThrow(/CHECK constraint failed/u);
    expect(() => insertTask.run(
      'TODO',
      'NOT_A_PRIORITY',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    )).toThrow(/CHECK constraint failed/u);
    expect(() => insertTask.run(
      'PENDING_PUSH',
      'MEDIUM',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    )).not.toThrow();
    expect(() => insertTask.run(
      'PENDING_BRANCH_REMOVAL',
      'MEDIUM',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    )).not.toThrow();
  });

  it('enforces foreign keys and cascades task runs when a task is removed', () => {
    database = new OrchestratorDatabase(':memory:');
    const projects = new ProjectRepository(database);
    const runs = new TaskRunRepository(database);
    const tasks = new TaskRepository(database, runs);
    const project = projects.create({
      name: 'Example',
      repository_path: '/example',
      context: ''
    });
    const task = tasks.create({
      project_id: project.id,
      title: 'Task',
      description: '',
      priority: 'MEDIUM'
    });
    runs.create(task.id);

    expect(() => database?.connection.prepare(`
      INSERT INTO tasks (
        project_id, title, description, status, priority,
        branch_name, worktree_path, created_at, updated_at
      ) VALUES (9999, 'Orphan', '', 'TODO', 'MEDIUM', NULL, NULL, ?, ?)
    `).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'))
      .toThrow(/FOREIGN KEY constraint failed/u);

    expect(tasks.delete(task.id)).toBe(true);
    expect(runs.listForTask(task.id)).toEqual([]);
  });

  it('migrates earlier databases and restores unpushed DONE branches to PENDING_PUSH', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'orchestrator-migrate-'));
    const databasePath = path.join(temporaryRoot, 'legacy.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, repository_path TEXT NOT NULL,
        context TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('TODO','IN_REVIEW','DONE','FAILED')),
        priority TEXT NOT NULL,
        branch_name TEXT, worktree_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task_runs (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT, exit_code INTEGER, stdout TEXT NOT NULL DEFAULT '',
        stderr TEXT NOT NULL DEFAULT '', result_summary TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO projects VALUES (
        1, 'Legacy', '/legacy', '', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z'
      );
      INSERT INTO tasks VALUES (
        7, 1, 'Legacy task', '', 'DONE', 'HIGH', 'agent/7-legacy-task', '/legacy',
        '2026-08-30T00:00:00.000Z', '2026-08-30T01:00:00.000Z'
      );
      INSERT INTO task_runs VALUES (
        4, 7, '2026-08-30T00:10:00.000Z', '2026-08-30T00:20:00.000Z', 0, '', '',
        'feat: finish the legacy task.'
      );
    `);
    legacy.close();

    database = new OrchestratorDatabase(databasePath);
    const columns = database.connection.prepare('PRAGMA table_info(tasks)').all();

    expect(columns.some((column) => column['name'] === 'is_paused')).toBe(true);
    expect(columns.some((column) => column['name'] === 'base_branch')).toBe(true);
    expect(columns.some((column) => column['name'] === 'commit_summary')).toBe(true);
    expect(columns.some((column) => column['name'] === 'model_effort')).toBe(true);
    expect(database.connection.prepare('SELECT status, commit_summary, model_effort FROM tasks WHERE id = 7').get())
      .toMatchObject({
        status: 'PENDING_PUSH',
        commit_summary: 'feat: finish the legacy task.',
        model_effort: 'medium'
      });
    database.close();
    database = undefined;
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('moves published DONE tasks from the prior schema into branch cleanup', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'orchestrator-cleanup-migrate-'));
    const databasePath = path.join(temporaryRoot, 'publishing.sqlite');
    const previous = new DatabaseSync(databasePath);
    previous.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, repository_path TEXT NOT NULL UNIQUE,
        context TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('TODO','CLAIMED','IN_PROGRESS','TESTING','IN_REVIEW','PENDING_PUSH','DONE','FAILED')),
        priority TEXT NOT NULL, model_effort TEXT NOT NULL DEFAULT 'medium',
        branch_name TEXT, worktree_path TEXT, base_branch TEXT,
        commit_summary TEXT, is_paused INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task_runs (
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT, exit_code INTEGER, stdout TEXT NOT NULL DEFAULT '',
        stderr TEXT NOT NULL DEFAULT '', result_summary TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO projects VALUES (
        1, 'Published', '/published', '', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
      INSERT INTO tasks VALUES (
        9, 1, 'Published task', '', 'DONE', 'MEDIUM', 'xhigh', 'agent/9-published-task', '/published',
        'main', 'feat: publish the task.', 0,
        '2026-09-01T00:00:00.000Z', '2026-09-01T01:00:00.000Z'
      );
    `);
    previous.close();

    database = new OrchestratorDatabase(databasePath);
    expect(database.connection.prepare('SELECT status, model_effort FROM tasks WHERE id = 9').get())
      .toMatchObject({ status: 'PENDING_BRANCH_REMOVAL', model_effort: 'xhigh' });
    database.close();
    database = undefined;
    await rm(temporaryRoot, { recursive: true, force: true });
  });
});

describe('TaskRepository.claimNext', () => {
  const databases: OrchestratorDatabase[] = [];
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    for (const database of databases.reverse()) {
      database.close();
    }
    databases.length = 0;
    if (temporaryRoot !== undefined) {
      await rm(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = undefined;
    }
  });

  it('claims highest priority first and conditionally prevents a second connection claiming it', async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), 'orchestrator-claim-'));
    const databasePath = path.join(temporaryRoot, 'orchestrator.sqlite');
    const firstDatabase = new OrchestratorDatabase(databasePath);
    const secondDatabase = new OrchestratorDatabase(databasePath);
    databases.push(firstDatabase, secondDatabase);

    const clock = (): string => '2026-01-01T00:00:00.000Z';
    const projects = new ProjectRepository(firstDatabase, clock);
    const firstRuns = new TaskRunRepository(firstDatabase, clock);
    const secondRuns = new TaskRunRepository(secondDatabase, clock);
    const firstTasks = new TaskRepository(firstDatabase, firstRuns, clock);
    const secondTasks = new TaskRepository(secondDatabase, secondRuns, clock);
    const project = projects.create({
      name: 'Example',
      repository_path: temporaryRoot,
      context: ''
    });

    const low = firstTasks.create({
      project_id: project.id,
      title: 'Low',
      description: '',
      priority: 'LOW'
    });
    const urgentFirst = firstTasks.create({
      project_id: project.id,
      title: 'Urgent first',
      description: '',
      priority: 'URGENT'
    });
    const urgentSecond = firstTasks.create({
      project_id: project.id,
      title: 'Urgent second',
      description: '',
      priority: 'URGENT'
    });
    firstTasks.setPaused(urgentFirst.id, true);

    const firstClaim = firstTasks.claimNext();
    expect(firstClaim?.id).toBe(urgentSecond.id);
    firstTasks.setPaused(urgentFirst.id, false);
    const secondClaim = secondTasks.claimNext();
    const thirdClaim = firstTasks.claimNext();
    const noFourthClaim = secondTasks.claimNext();

    expect(secondClaim?.id).toBe(urgentFirst.id);
    expect(thirdClaim?.id).toBe(low.id);
    expect(noFourthClaim).toBeNull();
    expect(new Set([firstClaim?.id, secondClaim?.id, thirdClaim?.id]).size).toBe(3);
    expect(firstTasks.list().every((task) => task.status === 'CLAIMED')).toBe(true);
    expect(firstRuns.listForTask(urgentFirst.id)).toHaveLength(1);
    expect(secondRuns.listForTask(urgentSecond.id)).toHaveLength(1);
  });
});
