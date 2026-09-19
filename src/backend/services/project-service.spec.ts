import { describe, expect, it, vi } from 'vitest';

import type { Project } from '../domain/types.js';
import { ProjectRepository } from '../database/project-repository.js';
import { GitService } from './git-service.js';
import { ProjectService } from './project-service.js';

describe('ProjectService', () => {
  it('inspects repository history and local branches when connecting a project', async () => {
    const project: Project = {
      id: 1,
      name: 'Existing repository',
      repository_path: 'C:/Repositories/existing',
      context: '',
      created_at: '2026-09-19T00:00:00.000Z',
      updated_at: '2026-09-19T00:00:00.000Z',
    };
    const projects = {
      findByRepositoryPath: vi.fn(() => null),
      create: vi.fn(() => project),
    };
    const validateRepository = vi.fn(async () => project.repository_path);
    const inspectBranches = vi.fn(async () => ({
      currentBranch: 'main',
      localBranches: ['feature/existing', 'main'],
      primaryBranch: 'main',
      primaryCommits: [],
      branchRelations: {},
    }));
    const service = new ProjectService(
      projects as unknown as ProjectRepository,
      { validateRepository, inspectBranches } as unknown as GitService,
    );

    await expect(service.create({
      name: ' Existing repository ', repository_path: ' C:/Repositories/existing ',
    })).resolves.toBe(project);

    expect(validateRepository).toHaveBeenCalledWith('C:/Repositories/existing');
    expect(inspectBranches).toHaveBeenCalledWith(project.repository_path);
    expect(projects.create).toHaveBeenCalledWith({
      name: 'Existing repository', repository_path: project.repository_path, context: '',
    });
  });
});
