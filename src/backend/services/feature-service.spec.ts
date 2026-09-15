import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrchestratorDatabase } from '../database/database.js';
import { FeatureRepository } from '../database/feature-repository.js';
import { ProjectRepository } from '../database/project-repository.js';
import { TaskRepository } from '../database/task-repository.js';
import { TaskRunRepository } from '../database/task-run-repository.js';
import { ConflictError } from '../domain/errors.js';
import type { GitService } from './git-service.js';
import { createAvailableFeatureBranch, FeatureService } from './feature-service.js';

describe('FeatureService', () => {
  let database: OrchestratorDatabase;

  beforeEach(() => {
    database = new OrchestratorDatabase(':memory:');
  });

  afterEach(() => database.close());

  it('configures a shared branch and maps its ordered task history', async () => {
    const projects = new ProjectRepository(database);
    const features = new FeatureRepository(database);
    const runs = new TaskRunRepository(database);
    const tasks = new TaskRepository(database, runs);
    const project = projects.create({ name: 'Example', repository_path: '/example', context: '' });
    const inspectBranches = vi.fn(async () => ({ currentBranch: 'main', localBranches: ['main'] }));
    const service = new FeatureService(
      features,
      projects,
      tasks,
      { inspectBranches } as unknown as GitService,
    );

    const feature = await service.create({ project_id: project.id, name: '  Account Settings  ' });
    expect(feature).toMatchObject({
      name: 'Account Settings',
      branch_name: 'feature/account-settings',
      base_branch: 'main',
    });
    tasks.create({
      project_id: project.id,
      feature_id: feature.id,
      title: 'Profile form',
      description: '',
      priority: 'MEDIUM',
    });

    const [map] = await service.branchMap();
    expect(map?.branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'main', exists: true, tasks: [] }),
      expect.objectContaining({
        name: 'feature/account-settings',
        exists: false,
        feature: expect.objectContaining({ id: feature.id }),
        tasks: [expect.objectContaining({ title: 'Profile form', status: 'TODO' })],
      }),
    ]));
    await expect(service.create({ project_id: project.id, name: 'Account Settings' }))
      .rejects.toThrow(ConflictError);

    const firstChineseFeature = await service.create({ project_id: project.id, name: '成就系統' });
    const secondChineseFeature = await service.create({ project_id: project.id, name: '任務系統' });
    expect(firstChineseFeature.branch_name).toBe('feature/task');
    expect(secondChineseFeature.branch_name).toMatch(/^feature\/task-[a-f0-9]{8}$/u);
    expect(secondChineseFeature.branch_name).not.toBe(firstChineseFeature.branch_name);

    await service.reorderBranches(project.id, [
      secondChineseFeature.branch_name,
      feature.branch_name,
      firstChineseFeature.branch_name,
    ]);
    const [reorderedMap] = await service.branchMap();
    expect(reorderedMap?.branches
      .filter((branch) => !branch.is_primary)
      .sort((left, right) => (left.display_order ?? 999) - (right.display_order ?? 999))
      .map((branch) => branch.name))
      .toEqual([secondChineseFeature.branch_name, feature.branch_name, firstChineseFeature.branch_name]);
  });

  it('generates a stable fallback when normalized branch names collide', () => {
    const generated = createAvailableFeatureBranch('Account settings!', ['FEATURE/account-settings']);
    expect(generated).toMatch(/^feature\/account-settings-[a-f0-9]{8}$/u);
    expect(createAvailableFeatureBranch('Account settings!', ['FEATURE/account-settings'])).toBe(generated);
  });

  it('requires Feature configuration to start from a local main checkout', async () => {
    const projects = new ProjectRepository(database);
    const features = new FeatureRepository(database);
    const tasks = new TaskRepository(database, new TaskRunRepository(database));
    const project = projects.create({ name: 'Nested', repository_path: '/nested', context: '' });
    const inspectBranches = vi.fn(async () => ({
      currentBranch: 'feature/task', localBranches: ['main', 'feature/task'],
    }));
    const service = new FeatureService(features, projects, tasks, { inspectBranches } as unknown as GitService);

    await expect(service.create({ project_id: project.id, name: 'Superadmin logger' }))
      .rejects.toThrow('Repository must be on main before configuring a Feature; it is on feature/task.');
    expect(features.list(project.id)).toEqual([]);
  });

  it('resets a configured Feature branch through its owning Project repository', async () => {
    const projects = new ProjectRepository(database);
    const features = new FeatureRepository(database);
    const tasks = new TaskRepository(database, new TaskRunRepository(database));
    const project = projects.create({ name: 'Example', repository_path: '/example', context: '' });
    const feature = features.create({ project_id: project.id, name: 'Search' }, 'feature/search', 'main');
    const historicalTask = tasks.create({
      project_id: project.id, feature_id: feature.id, title: 'Historical commit', description: '', priority: 'MEDIUM',
    });
    database.connection.prepare('UPDATE tasks SET publish_commit_sha = ? WHERE id = ?')
      .run('abc123', historicalTask.id);
    const resetFeatureBranchToMain = vi.fn(async () => undefined);
    const resetFeatureBranchesToMain = vi.fn(async () => undefined);
    const inspectBranches = vi.fn(async () => ({
      currentBranch: 'main', localBranches: ['main', 'feature/search'],
    }));
    const service = new FeatureService(
      features,
      projects,
      tasks,
      { resetFeatureBranchToMain, resetFeatureBranchesToMain, inspectBranches } as unknown as GitService,
    );

    await expect(service.resetBranchToMain(feature.id)).resolves.toMatchObject({
      id: feature.id,
      pointer_reset_task_id: historicalTask.id,
    });
    expect(resetFeatureBranchToMain).toHaveBeenCalledWith('/example', 'feature/search');
    await expect(service.resetProjectBranchesToMain(project.id)).resolves.toEqual({ reset_count: 1 });
    expect(resetFeatureBranchesToMain).toHaveBeenCalledWith('/example', ['feature/search']);

    const reviewTask = tasks.create({
      project_id: project.id, feature_id: feature.id, title: 'Awaiting review', description: '', priority: 'MEDIUM',
    });
    expect(tasks.transition(reviewTask.id, 'TODO', 'IN_REVIEW')).not.toBeNull();
    resetFeatureBranchToMain.mockClear();
    resetFeatureBranchesToMain.mockClear();
    await expect(service.resetBranchToMain(feature.id)).rejects.toThrow(`#${reviewTask.id} (IN_REVIEW)`);
    await expect(service.resetProjectBranchesToMain(project.id)).rejects.toThrow(`#${reviewTask.id} (IN_REVIEW)`);
    expect(resetFeatureBranchToMain).not.toHaveBeenCalled();
    expect(resetFeatureBranchesToMain).not.toHaveBeenCalled();
    await expect(service.resetBranchToMain(999)).rejects.toThrow('Feature 999 was not found.');
  });

  it('deletes only the Git branch or removes the Feature while preserving task history', async () => {
    const projects = new ProjectRepository(database);
    const features = new FeatureRepository(database);
    const runs = new TaskRunRepository(database);
    const tasks = new TaskRepository(database, runs);
    const project = projects.create({ name: 'Cleanup', repository_path: '/cleanup', context: '' });
    const feature = features.create({ project_id: project.id, name: 'Search' }, 'feature/search', 'main');
    const task = tasks.create({
      project_id: project.id, feature_id: feature.id, title: 'Keep history', description: '', priority: 'MEDIUM',
    });
    const run = runs.create(task.id);
    features.saveBranchOrder(project.id, [feature.branch_name]);
    const removeFeatureBranch = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const service = new FeatureService(
      features, projects, tasks, { removeFeatureBranch } as unknown as GitService,
    );

    await expect(service.deleteGitBranch(feature.id)).resolves.toEqual({ git_branch_deleted: true });
    expect(features.findById(feature.id)).not.toBeNull();
    expect(tasks.findById(task.id)?.feature_id).toBe(feature.id);

    await expect(service.deleteFeature(feature.id)).resolves.toEqual({
      git_branch_deleted: false,
      database_branch_deleted: true,
      detached_task_count: 1,
    });
    expect(removeFeatureBranch).toHaveBeenNthCalledWith(1, '/cleanup', 'feature/search');
    expect(removeFeatureBranch).toHaveBeenNthCalledWith(2, '/cleanup', 'feature/search');
    expect(features.findById(feature.id)).toBeNull();
    expect(features.branchOrder(project.id).has(feature.branch_name)).toBe(false);
    expect(tasks.findById(task.id)).toMatchObject({ id: task.id, feature_id: null });
    expect(runs.findById(run.id)).toMatchObject({ id: run.id, task_id: task.id });
  });

  it('infers the reset boundary for branches already pointing at the latest main commit', async () => {
    const projects = new ProjectRepository(database);
    const features = new FeatureRepository(database);
    const tasks = new TaskRepository(database, new TaskRunRepository(database));
    const project = projects.create({ name: 'Legacy reset', repository_path: '/legacy-reset', context: '' });
    const feature = features.create({ project_id: project.id, name: 'Search' }, 'feature/search', 'main');
    const historicalTask = tasks.create({
      project_id: project.id, feature_id: feature.id, title: 'Old commit', description: '', priority: 'MEDIUM',
    });
    database.connection.prepare('UPDATE tasks SET publish_commit_sha = ? WHERE id = ?')
      .run('old-feature-sha', historicalTask.id);
    const mainCommit = {
      sha: 'main-tip', shortSha: 'main-tip', summary: 'Latest main', committedAt: '2026-09-15T00:00:00.000Z',
    };
    const inspectBranches = vi.fn(async () => ({
      currentBranch: 'main',
      localBranches: ['main', feature.branch_name],
      primaryBranch: 'main',
      primaryCommits: [mainCommit],
      branchRelations: {
        [feature.branch_name]: { forkCommit: mainCommit, ahead: 0, behind: 0 },
      },
    }));
    const service = new FeatureService(
      features, projects, tasks, { inspectBranches } as unknown as GitService,
    );

    const [projectMap] = await service.branchMap();

    expect(projectMap?.branches.find((branch) => branch.name === feature.branch_name)?.tasks[0])
      .toMatchObject({ id: historicalTask.id, is_before_pointer_reset: true });
    expect(features.findById(feature.id)?.pointer_reset_task_id).toBe(historicalTask.id);
  });
});
