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
  });

  it('generates a stable fallback when normalized branch names collide', () => {
    const generated = createAvailableFeatureBranch('Account settings!', ['FEATURE/account-settings']);
    expect(generated).toMatch(/^feature\/account-settings-[a-f0-9]{8}$/u);
    expect(createAvailableFeatureBranch('Account settings!', ['FEATURE/account-settings'])).toBe(generated);
  });
});
