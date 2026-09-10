import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrchestratorDatabase } from '../database/database.js';
import { FeatureRepository } from '../database/feature-repository.js';
import { ProjectRepository } from '../database/project-repository.js';
import { TaskRepository } from '../database/task-repository.js';
import { TaskRunRepository } from '../database/task-run-repository.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { Project, Task } from '../domain/types.js';
import { CherryPickConflictError, type GitService } from './git-service.js';
import { TaskService } from './task-service.js';

describe('TaskService state rules', () => {
  let database: OrchestratorDatabase;
  let projects: ProjectRepository;
  let tasks: TaskRepository;
  let runs: TaskRunRepository;
  let features: FeatureRepository;
  let service: TaskService;
  let project: Project;
  let publishBranch: ReturnType<typeof vi.fn>;
  let publishFeatureTask: ReturnType<typeof vi.fn>;
  let removeTaskBranch: ReturnType<typeof vi.fn>;
  let beginTaskReview: ReturnType<typeof vi.fn>;
  let endTaskReview: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    database = new OrchestratorDatabase(':memory:');
    projects = new ProjectRepository(database);
    runs = new TaskRunRepository(database);
    tasks = new TaskRepository(database, runs);
    features = new FeatureRepository(database);
    publishBranch = vi.fn(async () => ({ baseBranch: 'main' }));
    publishFeatureTask = vi.fn(async () => ({ baseBranch: 'main' }));
    removeTaskBranch = vi.fn(async () => true);
    beginTaskReview = vi.fn(async (task: Task) => `agent/${task.id}-review`);
    endTaskReview = vi.fn(async () => undefined);
    const git = {
      publishBranch, publishFeatureTask, removeTaskBranch, beginTaskReview, endTaskReview,
    } as unknown as GitService;
    service = new TaskService(tasks, projects, runs, git, features);
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

  it.each(['CLAIMED', 'IN_PROGRESS', 'TESTING', 'REVIEWING', 'PENDING_PUSH', 'PENDING_BRANCH_REMOVAL'] as const)(
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

  it('creates a new linked task for retries while preserving the Feature branch and history', async () => {
    const failed = createTask('Retry me');
    expect(tasks.transition(failed.id, 'TODO', 'CLAIMED')).not.toBeNull();
    tasks.setArtifacts(failed.id, 'agent/1-retry-me', '/example/repository', 'main');
    expect(tasks.transition(failed.id, 'CLAIMED', 'FAILED')).not.toBeNull();

    const retried = await service.retry(failed.id, {
      prompt: 'Fix the failing implementation and rerun verification.',
      model_effort: 'high'
    });
    expect(retried).toMatchObject({
      status: 'TODO',
      model_effort: 'high',
      retry_prompt: 'Fix the failing implementation and rerun verification.',
      branch_name: 'agent/1-retry-me',
      worktree_path: '/example/repository',
      source_task_id: failed.id,
    });
    expect(retried.id).not.toBe(failed.id);
    expect(tasks.findById(failed.id)).toMatchObject({ status: 'REJECTED', is_rejected: true });

    expect(await service.retry(retried.id, { prompt: '   ' })).toMatchObject({
      status: 'TODO',
      model_effort: 'high',
      retry_prompt: null,
      branch_name: 'agent/1-retry-me',
      worktree_path: '/example/repository',
      source_task_id: retried.id,
    });
    const queued = service.create({
      project_id: project.id,
      title: 'Not failed',
      model_effort: 'low'
    });
    expect(service.pause(queued.id).is_paused).toBe(true);
    expect(await service.retry(queued.id, {
      prompt: 'Try this task now.',
      model_effort: 'xhigh'
    })).toMatchObject({
      status: 'TODO', model_effort: 'xhigh', retry_prompt: 'Try this task now.', is_paused: false
    });

    for (const status of ['IN_REVIEW', 'PENDING_PUSH', 'PENDING_BRANCH_REMOVAL', 'DONE', 'REJECTED'] as const) {
      const task = createTask(`Retry ${status}`);
      expect(tasks.transition(task.id, 'TODO', status)).not.toBeNull();
      const retry = await service.retry(task.id, { prompt: `Retry from ${status}.` });
      expect(retry).toMatchObject({
        status: 'TODO', retry_prompt: `Retry from ${status}.`, is_rejected: false,
        source_task_id: task.id,
      });
      expect(retry.id).not.toBe(task.id);
      expect(tasks.findById(task.id)).toMatchObject({ status: 'REJECTED', is_rejected: true });
    }
  });

  it.each(['CLAIMED', 'IN_PROGRESS', 'TESTING'] as const)(
    'requires a running %s task to stop before retry or rejection',
    async (status) => {
      const task = createTask(`Running ${status}`);
      expect(tasks.transition(task.id, 'TODO', status)).not.toBeNull();
      await expect(service.retry(task.id, { prompt: 'Restart after cancellation.' })).rejects.toThrow(ConflictError);
      await expect(service.reject(task.id)).rejects.toThrow(ConflictError);
    }
  );

  it('rejects tasks from every inactive state and only queues cleanup when a branch exists', async () => {
    const queued = createTask('Reject queued task');
    await expect(service.reject(queued.id)).resolves.toMatchObject({
      status: 'REJECTED', is_rejected: true
    });

    const prepared = createTask('Reject prepared task');
    expect(tasks.transition(prepared.id, 'TODO', 'CLAIMED')).not.toBeNull();
    tasks.setArtifacts(prepared.id, `agent/${prepared.id}-reject-prepared-task`, '/example/repository', 'main');
    expect(tasks.transition(prepared.id, 'CLAIMED', 'FAILED')).not.toBeNull();
    await expect(service.reject(prepared.id)).resolves.toMatchObject({
      status: 'PENDING_BRANCH_REMOVAL', is_rejected: true
    });
  });

  it('checks out one selected task for Review, supports exit, and only approves REVIEWING tasks', async () => {
    const review = createTask('Review me');
    const todo = createTask('Still queued');
    expect(tasks.transition(review.id, 'TODO', 'IN_REVIEW')).not.toBeNull();

    await expect(service.startReview(review.id)).resolves.toMatchObject({ status: 'REVIEWING' });
    expect(beginTaskReview).toHaveBeenCalledWith(expect.objectContaining({ id: review.id }), '/example');
    const secondReview = createTask('Review later');
    expect(tasks.transition(secondReview.id, 'TODO', 'IN_REVIEW')).not.toBeNull();
    await expect(service.startReview(secondReview.id)).rejects.toThrow('already being reviewed');
    await expect(service.exitReview(review.id)).resolves.toMatchObject({ status: 'IN_REVIEW' });
    expect(endTaskReview).toHaveBeenCalledWith(expect.objectContaining({ id: review.id }), '/example');
    await service.startReview(review.id);
    await expect(service.approve(review.id)).resolves.toMatchObject({ status: 'PENDING_PUSH' });
    await expect(service.approve(review.id)).rejects.toThrow(ConflictError);
    await expect(service.approve(todo.id)).rejects.toThrow(ConflictError);
    expect(tasks.findById(todo.id)?.status).toBe('TODO');
  });

  it('restores the base checkout before retrying or rejecting a REVIEWING task', async () => {
    const retried = createTask('Retry active Review');
    expect(tasks.transition(retried.id, 'TODO', 'REVIEWING')).not.toBeNull();
    await expect(service.retry(retried.id, { prompt: 'Rework this.' }))
      .resolves.toMatchObject({ status: 'TODO' });
    expect(endTaskReview).toHaveBeenCalledWith(expect.objectContaining({ id: retried.id }), '/example');

    const rejected = createTask('Reject active Review');
    expect(tasks.transition(rejected.id, 'TODO', 'REVIEWING')).not.toBeNull();
    await expect(service.reject(rejected.id)).resolves.toMatchObject({ status: 'REJECTED' });
    expect(endTaskReview).toHaveBeenCalledWith(expect.objectContaining({ id: rejected.id }), '/example');
  });

  it('creates a revision linked to its reviewed source and marks the previous version rejected', () => {
    const review = createTask('Revise me');
    expect(tasks.transition(review.id, 'TODO', 'CLAIMED')).not.toBeNull();
    tasks.setArtifacts(review.id, `agent/${review.id}-revise-me`, '/example/repository', 'main');
    expect(tasks.transition(review.id, 'CLAIMED', 'IN_REVIEW')).not.toBeNull();

    const revision = service.retryReview(review.id, '  Fix the empty state.  ');

    expect(revision).toMatchObject({
      status: 'TODO',
      description: 'Fix the empty state.',
      source_task_id: review.id,
      branch_name: `agent/${review.id}-revise-me`
    });
    expect(tasks.findById(review.id)?.status).toBe('REJECTED');
    expect(() => service.retryReview(review.id, 'Again')).toThrow(ConflictError);
  });

  it('moves rejected work to branch removal and finishes it as rejected after cleanup', async () => {
    const review = createTask('Reject me');
    expect(tasks.transition(review.id, 'TODO', 'CLAIMED')).not.toBeNull();
    tasks.setArtifacts(review.id, `agent/${review.id}-reject-me`, '/example/repository', 'main');
    expect(tasks.transition(review.id, 'CLAIMED', 'IN_REVIEW')).not.toBeNull();

    await expect(service.reject(review.id)).resolves.toMatchObject({
      status: 'PENDING_BRANCH_REMOVAL', is_rejected: true
    });
    expect(removeTaskBranch).not.toHaveBeenCalled();
    await expect(service.removeBranch(review.id)).resolves.toMatchObject({ status: 'REJECTED' });
    expect(removeTaskBranch).toHaveBeenCalledWith(
      '/example', `agent/${review.id}-reject-me`, 'main', true
    );
  });

  it('publishes approved tasks, then requires approval before removing the branch and marking DONE', async () => {
    const review = createTask('Publish me');
    expect(tasks.transition(review.id, 'TODO', 'CLAIMED')).not.toBeNull();
    tasks.setArtifacts(review.id, `agent/${review.id}-publish-me`, '/example/repository', 'main');
    expect(tasks.transition(review.id, 'CLAIMED', 'IN_REVIEW')).not.toBeNull();
    await service.startReview(review.id);
    await service.approve(review.id);

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
      'main',
      false
    );
    await expect(service.removeBranch(review.id)).rejects.toThrow(ConflictError);
  });

  it('keeps a task PENDING_PUSH when Git publishing fails', async () => {
    const review = createTask('Retry publishing');
    expect(tasks.transition(review.id, 'TODO', 'CLAIMED')).not.toBeNull();
    tasks.setArtifacts(review.id, `agent/${review.id}-retry-publishing`, '/example/repository', 'main');
    expect(tasks.transition(review.id, 'CLAIMED', 'IN_REVIEW')).not.toBeNull();
    await service.startReview(review.id);
    await service.approve(review.id);
    publishBranch.mockRejectedValueOnce(new Error('origin rejected the push'));

    await expect(service.push(review.id)).rejects.toThrow('origin rejected the push');
    expect(tasks.findById(review.id)?.status).toBe('PENDING_PUSH');
  });

  it('publishes a reviewed feature task on its shared branch without merging or cleanup', async () => {
    const feature = features.create({ project_id: project.id, name: 'Search' }, 'feature/search', 'main');
    const task = service.create({ project_id: project.id, feature_id: feature.id, title: 'Index documents' });
    expect(task).toMatchObject({
      feature_id: feature.id,
      branch_name: 'feature/search',
      base_branch: 'main'
    });
    expect(tasks.transition(task.id, 'TODO', 'IN_REVIEW')).not.toBeNull();
    await service.startReview(task.id);
    await service.approve(task.id);

    await expect(service.push(task.id)).resolves.toMatchObject({ status: 'DONE' });
    expect(publishFeatureTask).toHaveBeenCalledWith('/example', 'feature/search', 'main', null, null, task.id);
    expect(publishBranch).not.toHaveBeenCalled();
    await expect(service.removeBranch(task.id)).rejects.toThrow(ConflictError);
  });

  it('records a Feature cherry-pick conflict and queues Codex resolution with the selected strength', async () => {
    const feature = features.create({ project_id: project.id, name: 'Conflicted' }, 'feature/conflicted', 'main');
    const task = service.create({ project_id: project.id, feature_id: feature.id, title: 'Resolve overlap' });
    expect(tasks.transition(task.id, 'TODO', 'IN_REVIEW')).not.toBeNull();
    await service.startReview(task.id);
    await service.approve(task.id);
    publishFeatureTask.mockRejectedValueOnce(new CherryPickConflictError(
      'Cherry-pick conflict detected in src/app.ts.',
      { exitCode: 1, stdout: '', stderr: 'CONFLICT', timedOut: false, aborted: false },
      ['src/app.ts'],
    ));

    await expect(service.push(task.id)).rejects.toBeInstanceOf(CherryPickConflictError);
    expect(tasks.findById(task.id)?.status).toBe('CHERRY_PICK_CONFLICT');
    expect(service.resolveCherryPickConflict(task.id, 'xhigh')).toMatchObject({
      status: 'TODO', model_effort: 'xhigh', agent_mode: 'cherry_pick_resolution', branch_name: 'feature/conflicted',
    });
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
