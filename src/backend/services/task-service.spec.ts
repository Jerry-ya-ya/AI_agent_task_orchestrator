import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrchestratorDatabase } from '../database/database.js';
import { ProjectRepository } from '../database/project-repository.js';
import { TaskRepository } from '../database/task-repository.js';
import { TaskRunRepository } from '../database/task-run-repository.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { Project, Task } from '../domain/types.js';
import type { GitService } from './git-service.js';
import { TaskService } from './task-service.js';

describe('TaskService state rules', () => {
  let database: OrchestratorDatabase;
  let projects: ProjectRepository;
  let tasks: TaskRepository;
  let runs: TaskRunRepository;
  let service: TaskService;
  let project: Project;
  let publishBranch: ReturnType<typeof vi.fn>;
  let removeTaskBranch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    database = new OrchestratorDatabase(':memory:');
    projects = new ProjectRepository(database);
    runs = new TaskRunRepository(database);
    tasks = new TaskRepository(database, runs);
    publishBranch = vi.fn(async () => ({ baseBranch: 'main' }));
    removeTaskBranch = vi.fn(async () => true);
    const git = { publishBranch, removeTaskBranch } as unknown as GitService;
    service = new TaskService(tasks, projects, runs, git);
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
      model_effort: 'medium',
      branch_name: null,
      worktree_path: null,
      base_branch: null,
      commit_summary: null,
      is_paused: false
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

  it.each(['CLAIMED', 'IN_PROGRESS', 'TESTING', 'PENDING_PUSH', 'PENDING_BRANCH_REMOVAL'] as const)(
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
    tasks.setArtifacts(task.id, 'agent/1-prepared-task', '/example/repository', 'main');
    expect(tasks.transition(task.id, 'CLAIMED', 'FAILED')).not.toBeNull();

    expect(() => service.update(task.id, { project_id: otherProject.id })).toThrow(ConflictError);
    expect(tasks.findById(task.id)?.project_id).toBe(project.id);
  });

  it('retries only FAILED tasks and preserves their branch and workspace', () => {
    const failed = createTask('Retry me');
    expect(tasks.transition(failed.id, 'TODO', 'CLAIMED')).not.toBeNull();
    tasks.setArtifacts(failed.id, 'agent/1-retry-me', '/example/repository', 'main');
    expect(tasks.transition(failed.id, 'CLAIMED', 'FAILED')).not.toBeNull();

    const retried = service.retry(failed.id, { model_effort: 'high' });
    expect(retried).toMatchObject({
      status: 'TODO',
      model_effort: 'high',
      branch_name: 'agent/1-retry-me',
      worktree_path: '/example/repository'
    });
    expect(() => service.retry(failed.id)).toThrow(ConflictError);
    expect(tasks.findById(failed.id)?.model_effort).toBe('high');

    const queued = service.create({
      project_id: project.id,
      title: 'Not failed',
      model_effort: 'low'
    });
    expect(() => service.retry(queued.id, { model_effort: 'xhigh' })).toThrow(ConflictError);
    expect(tasks.findById(queued.id)?.model_effort).toBe('low');
  });

  it('approves only IN_REVIEW tasks into PENDING_PUSH', () => {
    const review = createTask('Review me');
    const todo = createTask('Still queued');
    expect(tasks.transition(review.id, 'TODO', 'IN_REVIEW')).not.toBeNull();

    expect(service.approve(review.id).status).toBe('PENDING_PUSH');
    expect(() => service.approve(review.id)).toThrow(ConflictError);
    expect(() => service.approve(todo.id)).toThrow(ConflictError);
    expect(tasks.findById(todo.id)?.status).toBe('TODO');
  });

  it('publishes approved tasks, then requires approval before removing the branch and marking DONE', async () => {
    const review = createTask('Publish me');
    expect(tasks.transition(review.id, 'TODO', 'CLAIMED')).not.toBeNull();
    tasks.setArtifacts(review.id, `agent/${review.id}-publish-me`, '/example/repository', 'main');
    expect(tasks.transition(review.id, 'CLAIMED', 'IN_REVIEW')).not.toBeNull();
    service.approve(review.id);

    await expect(service.push(review.id)).resolves.toMatchObject({ status: 'PENDING_BRANCH_REMOVAL' });
    expect(publishBranch).toHaveBeenCalledWith(
      '/example',
      `agent/${review.id}-publish-me`,
      'main'
    );
    await expect(service.push(review.id)).rejects.toThrow(ConflictError);

    await expect(service.removeBranch(review.id)).resolves.toMatchObject({ status: 'DONE' });
    expect(removeTaskBranch).toHaveBeenCalledWith(
      '/example',
      `agent/${review.id}-publish-me`,
      'main'
    );
    await expect(service.removeBranch(review.id)).rejects.toThrow(ConflictError);
  });

  it('keeps a task PENDING_PUSH when Git publishing fails', async () => {
    const review = createTask('Retry publishing');
    expect(tasks.transition(review.id, 'TODO', 'CLAIMED')).not.toBeNull();
    tasks.setArtifacts(review.id, `agent/${review.id}-retry-publishing`, '/example/repository', 'main');
    expect(tasks.transition(review.id, 'CLAIMED', 'IN_REVIEW')).not.toBeNull();
    service.approve(review.id);
    publishBranch.mockRejectedValueOnce(new Error('origin rejected the push'));

    await expect(service.push(review.id)).rejects.toThrow('origin rejected the push');
    expect(tasks.findById(review.id)?.status).toBe('PENDING_PUSH');
  });

  it('keeps a task pending branch removal when Git cleanup fails', async () => {
    const review = createTask('Retry cleanup');
    expect(tasks.transition(review.id, 'TODO', 'CLAIMED')).not.toBeNull();
    tasks.setArtifacts(review.id, `agent/${review.id}-retry-cleanup`, '/example/repository', 'main');
    expect(tasks.transition(review.id, 'CLAIMED', 'PENDING_BRANCH_REMOVAL')).not.toBeNull();
    removeTaskBranch.mockRejectedValueOnce(new Error('branch is not merged'));

    await expect(service.removeBranch(review.id)).rejects.toThrow('branch is not merged');
    expect(tasks.findById(review.id)?.status).toBe('PENDING_BRANCH_REMOVAL');
  });

  it('pauses and resumes only TODO tasks', () => {
    const task = createTask('Hold this task');

    expect(service.pause(task.id).is_paused).toBe(true);
    expect(tasks.claimNext()).toBeNull();
    expect(() => service.pause(task.id)).toThrow(ConflictError);
    expect(service.resume(task.id).is_paused).toBe(false);
    expect(tasks.claimNext()?.id).toBe(task.id);
    expect(() => service.resume(task.id)).toThrow(ConflictError);
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
