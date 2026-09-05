import { createHash } from 'node:crypto';

import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { BranchLane, CreateFeatureInput, Feature, ProjectBranchMap } from '../domain/types.js';
import { FeatureRepository } from '../database/feature-repository.js';
import { ProjectRepository } from '../database/project-repository.js';
import { TaskRepository } from '../database/task-repository.js';
import { GitService, slugifyTaskTitle } from './git-service.js';

export class FeatureService {
  public constructor(
    private readonly features: FeatureRepository,
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly git: GitService,
  ) {}

  public list(projectId?: number): Feature[] {
    return this.features.list(projectId);
  }

  public async create(input: CreateFeatureInput): Promise<Feature> {
    const project = this.projects.findById(input.project_id);
    if (project === null) throw new NotFoundError(`Project ${input.project_id} was not found.`);
    const name = input.name.trim();
    if (name.length === 0) throw new ValidationError('Feature name is required.');
    const snapshot = await this.git.inspectBranches(project.repository_path);
    const configuredFeatures = this.features.list(project.id);
    if (configuredFeatures.some((feature) => feature.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new ConflictError(`Feature ${name} is already configured for this project.`);
    }
    const branchName = createAvailableFeatureBranch(
      name,
      [...snapshot.localBranches, ...configuredFeatures.map((feature) => feature.branch_name)],
    );
    return this.features.create({ project_id: project.id, name }, branchName, snapshot.currentBranch);
  }

  public async branchMap(): Promise<ProjectBranchMap[]> {
    const allTasks = this.tasks.list();
    const allFeatures = this.features.list();
    return Promise.all(this.projects.list().map(async (project) => {
      let currentBranch: string | null = null;
      let localBranches: string[] = [];
      try {
        const snapshot = await this.git.inspectBranches(project.repository_path);
        currentBranch = snapshot.currentBranch;
        localBranches = snapshot.localBranches;
      } catch {
        // A missing repository is represented by monochrome lanes instead of failing the whole map.
      }
      const projectFeatures = allFeatures.filter((feature) => feature.project_id === project.id);
      const names = new Set([...localBranches, ...projectFeatures.map((feature) => feature.branch_name)]);
      const branches: BranchLane[] = [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
        const feature = projectFeatures.find((item) => item.branch_name === name) ?? null;
        return {
          name,
          exists: localBranches.includes(name),
          is_current: name === currentBranch,
          feature,
          tasks: feature === null ? [] : allTasks
            .filter((task) => task.feature_id === feature.id)
            .sort((a, b) => a.id - b.id)
            .map((task) => ({
              id: task.id,
              title: task.title,
              status: task.status,
              commit_summary: task.commit_summary,
              created_at: task.created_at,
              updated_at: task.updated_at,
            })),
        };
      });
      return { project, current_branch: currentBranch, branches };
    }));
  }
}

export function createAvailableFeatureBranch(name: string, reservedBranches: readonly string[]): string {
  const reserved = new Set(reservedBranches.map((branch) => branch.toLocaleLowerCase()));
  const baseSlug = slugifyTaskTitle(name);
  const baseBranch = `feature/${baseSlug}`;
  if (!reserved.has(baseBranch.toLocaleLowerCase())) return baseBranch;

  const digest = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 8);
  const stem = baseSlug.slice(0, 53).replace(/-+$/u, '') || 'task';
  const hashedBranch = `feature/${stem}-${digest}`;
  if (!reserved.has(hashedBranch.toLocaleLowerCase())) return hashedBranch;

  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const numberedStem = stem.slice(0, 49).replace(/-+$/u, '') || 'task';
    const candidate = `feature/${numberedStem}-${digest}-${suffix}`;
    if (!reserved.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new ConflictError('No unique Feature branch name could be generated for this project.');
}
