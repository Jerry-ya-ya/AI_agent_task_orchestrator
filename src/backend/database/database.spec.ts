import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

    const firstClaim = firstTasks.claimNext();
    const secondClaim = secondTasks.claimNext();
    const thirdClaim = firstTasks.claimNext();
    const noFourthClaim = secondTasks.claimNext();

    expect(firstClaim?.id).toBe(urgentFirst.id);
    expect(secondClaim?.id).toBe(urgentSecond.id);
    expect(thirdClaim?.id).toBe(low.id);
    expect(noFourthClaim).toBeNull();
    expect(new Set([firstClaim?.id, secondClaim?.id, thirdClaim?.id]).size).toBe(3);
    expect(firstTasks.list().every((task) => task.status === 'CLAIMED')).toBe(true);
    expect(firstRuns.listForTask(urgentFirst.id)).toHaveLength(1);
    expect(secondRuns.listForTask(urgentSecond.id)).toHaveLength(1);
  });
});
