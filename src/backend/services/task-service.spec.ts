import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OrchestratorDatabase } from '../database/database.js';
import { ProjectRepository } from '../database/project-repository.js';
import { TaskRepository } from '../database/task-repository.js';
import { TaskRunRepository } from '../database/task-run-repository.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { Project, Task } from '../domain/types.js';
import { TaskService } from './task-service.js';

describe('TaskService state rules', () => {
  let database: OrchestratorDatabase;
  let projects: ProjectRepository;
  let tasks: TaskRepository;
  let runs: TaskRunRepository;
  let service: TaskService;
  let project: Project;

  beforeEach(() => {
    database = new OrchestratorDatabase(':memory:');
    projects = new ProjectRepository(database);
    runs = new TaskRunRepository(database);
    tasks = new TaskRepository(database, runs);
    service = new TaskService(tasks, projects, runs);
    project = projects.create({
      name: 'Example',
      repository_path: '/example',
      context: 'Project context'
    });
  });

  afterEach(() => {
    database.close();
  });

  it('creates trimmed TODO tasks and safely edits inactive tasks', () => {
    const task = service.create({
      project_id: project.id,
      title: '  Add search  ',
      description: '  Implement full-text search  '
    });

    expect(task).toMatchObject({
      title: 'Add search',
      description: 'Implement full-text search',
      status: 'TODO',
      priority: 'MEDIUM',
      branch_name: null,
      worktree_path: null
    });

    const updated = service.update(task.id, {
      title: '  Add indexed search  ',
      description: '  Updated scope  ',
      priority: 'HIGH'
    });
    expect(updated).toMatchObject({
      title: 'Add indexed search',
      description: 'Updated scope',
      priority: 'HIGH'
    });
    expect(() => service.update(task.id, { title: '   ' })).toThrow(ValidationError);
    expect(() => service.create({ project_id: 9999, title: 'Orphan' })).toThrow(ValidationError);
  });

  it.each(['CLAIMED', 'IN_PROGRESS', 'TESTING'] as const)(
    'rejects edits and deletion while a task is %s',
    (activeStatus) => {
      const task = createTask(`Task in ${activeStatus}`);
      expect(tasks.transition(task.id, 'TODO', activeStatus)).not.toBeNull();

      expect(() => service.update(task.id, { priority: 'URGENT' })).toThrow(ConflictError);
      expect(() => service.delete(task.id)).toThrow(ConflictError);
      expect(tasks.findById(task.id)?.status).toBe(activeStatus);
    }
  );

  it('does not move a task with prepared artifacts to another project', () => {
    const task = createTask('Prepared task');
    const otherProject = projects.create({
      name: 'Other',
      repository_path: '/other',
      context: ''
    });
    expect(tasks.transition(task.id, 'TODO', 'CLAIMED')).not.toBeNull();
    tasks.setArtifacts(task.id, 'agent/1-prepared-task', '/example/.worktrees/1-prepared-task');
    expect(tasks.transition(task.id, 'CLAIMED', 'FAILED')).not.toBeNull();

    expect(() => service.update(task.id, { project_id: otherProject.id })).toThrow(ConflictError);
    expect(tasks.findById(task.id)?.project_id).toBe(project.id);
  });

  it('retries only FAILED tasks and preserves their branch and worktree', () => {
    const failed = createTask('Retry me');
    expect(tasks.transition(failed.id, 'TODO', 'CLAIMED')).not.toBeNull();
    tasks.setArtifacts(failed.id, 'agent/1-retry-me', '/example/.worktrees/1-retry-me');
    expect(tasks.transition(failed.id, 'CLAIMED', 'FAILED')).not.toBeNull();

    const retried = service.retry(failed.id);
    expect(retried).toMatchObject({
      status: 'TODO',
      branch_name: 'agent/1-retry-me',
      worktree_path: '/example/.worktrees/1-retry-me'
    });
    expect(() => service.retry(failed.id)).toThrow(ConflictError);
  });

  it('approves only IN_REVIEW tasks and never auto-approves another status', () => {
    const review = createTask('Review me');
    const todo = createTask('Still queued');
    expect(tasks.transition(review.id, 'TODO', 'IN_REVIEW')).not.toBeNull();

    expect(service.approve(review.id).status).toBe('DONE');
    expect(() => service.approve(review.id)).toThrow(ConflictError);
    expect(() => service.approve(todo.id)).toThrow(ConflictError);
    expect(tasks.findById(todo.id)?.status).toBe('TODO');
  });

  it('deletes inactive tasks and reports missing task ids', () => {
    const task = createTask('Delete me');
    const run = runs.create(task.id);
    runs.finish(run.id, 1, 'Failed before deletion');

    service.delete(task.id);

    expect(tasks.findById(task.id)).toBeNull();
    expect(runs.listForTask(task.id)).toEqual([]);
    expect(() => service.get(task.id)).toThrow(NotFoundError);
    expect(() => service.delete(9999)).toThrow(NotFoundError);
  });

  function createTask(title: string): Task {
    return service.create({ project_id: project.id, title });
  }
});
