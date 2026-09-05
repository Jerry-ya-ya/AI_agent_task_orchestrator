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
    const branchName = `feature/${slugifyTaskTitle(name)}`;
    if (this.features.list(project.id).some((feature) => feature.branch_name === branchName)) {
      throw new ConflictError(`Feature branch ${branchName} is already configured for this project.`);
    }
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
