import { createHash } from 'node:crypto';

import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { BranchCommit, BranchLane, CreateFeatureInput, Feature, ProjectBranchMap } from '../domain/types.js';
import { FeatureRepository } from '../database/feature-repository.js';
import { ProjectRepository } from '../database/project-repository.js';
import { TaskRepository } from '../database/task-repository.js';
import { GitService, slugifyTaskTitle } from './git-service.js';

const POINTER_RESET_BLOCKING_STATUSES = new Set(['IN_REVIEW', 'REVIEWING', 'PENDING_PUSH']);

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
    if (snapshot.currentBranch !== 'main') {
      throw new ConflictError(
        `Repository must be on main before configuring a Feature; it is on ${snapshot.currentBranch}.`,
      );
    }
    const configuredFeatures = this.features.list(project.id);
    if (configuredFeatures.some((feature) => feature.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new ConflictError(`Feature ${name} is already configured for this project.`);
    }
    const branchName = createAvailableFeatureBranch(
      name,
      [...snapshot.localBranches, ...configuredFeatures.map((feature) => feature.branch_name)],
    );
    return this.features.create({ project_id: project.id, name }, branchName, 'main');
  }

  public async reorderBranches(projectId: number, branchNames: readonly string[]): Promise<void> {
    const project = this.projects.findById(projectId);
    if (project === null) throw new NotFoundError(`Project ${projectId} was not found.`);
    const snapshot = await this.git.inspectBranches(project.repository_path);
    const primaryBranch = snapshot.primaryBranch ?? snapshot.currentBranch;
    const available = new Set([
      ...snapshot.localBranches,
      ...this.features.list(projectId).map((feature) => feature.branch_name),
    ].filter((name) => name !== primaryBranch));
    const requested = new Set(branchNames);
    if (requested.size !== branchNames.length || requested.size !== available.size
      || [...requested].some((name) => !available.has(name))) {
      throw new ValidationError('Branch order must contain every non-primary branch exactly once.');
    }
    this.features.saveBranchOrder(projectId, branchNames);
  }

  public async resetBranchToMain(featureId: number): Promise<Feature> {
    const feature = this.features.findById(featureId);
    if (feature === null) throw new NotFoundError(`Feature ${featureId} was not found.`);
    const project = this.projects.findById(feature.project_id);
    if (project === null) throw new NotFoundError(`Project ${feature.project_id} was not found.`);
    this.assertBranchesCanReset([feature]);
    await this.git.resetFeatureBranchToMain(project.repository_path, feature.branch_name);
    this.features.markPointerReset([feature.id]);
    return this.features.findById(feature.id) as Feature;
  }

  public async resetProjectBranchesToMain(projectId: number): Promise<{ reset_count: number }> {
    const project = this.projects.findById(projectId);
    if (project === null) throw new NotFoundError(`Project ${projectId} was not found.`);
    const features = this.features.list(projectId);
    const snapshot = await this.git.inspectBranches(project.repository_path);
    const localBranches = new Set(snapshot.localBranches);
    const resettableFeatures = features.filter((feature) => localBranches.has(feature.branch_name));
    this.assertBranchesCanReset(resettableFeatures);
    await this.git.resetFeatureBranchesToMain(
      project.repository_path,
      resettableFeatures.map((feature) => feature.branch_name),
    );
    this.features.markPointerReset(resettableFeatures.map((feature) => feature.id));
    return { reset_count: resettableFeatures.length };
  }

  public async branchMap(): Promise<ProjectBranchMap[]> {
    const allTasks = this.tasks.list();
    const allFeatures = this.features.list();
    return Promise.all(this.projects.list().map(async (project) => {
      let currentBranch: string | null = null;
      let primaryBranch: string | null = null;
      let primaryCommits: BranchCommit[] = [];
      let localBranches: string[] = [];
      let branchRelations: Awaited<ReturnType<GitService['inspectBranches']>>['branchRelations'] = {};
      try {
        const snapshot = await this.git.inspectBranches(project.repository_path);
        currentBranch = snapshot.currentBranch;
        primaryBranch = snapshot.primaryBranch ?? snapshot.currentBranch;
        primaryCommits = (snapshot.primaryCommits ?? []).map(toDomainCommit);
        localBranches = snapshot.localBranches;
        branchRelations = snapshot.branchRelations ?? {};
      } catch {
        // A missing repository is represented by monochrome lanes instead of failing the whole map.
      }
      const projectFeatures = allFeatures.filter((feature) => feature.project_id === project.id);
      const latestMainCommit = primaryCommits.at(-1)?.sha;
      const inferredResetFeatureIds: number[] = [];
      projectFeatures.forEach((feature) => {
        if (feature.pointer_reset_task_id !== null) return;
        const relation = branchRelations[feature.branch_name];
        if (relation?.ahead !== 0 || relation.behind !== 0 || relation.forkCommit.sha !== latestMainCommit) return;
        const latestCommittedTaskId = allTasks
          .filter((task) => task.feature_id === feature.id && task.publish_commit_sha !== null)
          .reduce((latestId, task) => Math.max(latestId, task.id), 0);
        if (latestCommittedTaskId === 0) return;
        feature.pointer_reset_task_id = latestCommittedTaskId;
        inferredResetFeatureIds.push(feature.id);
      });
      this.features.markPointerReset(inferredResetFeatureIds);
      const displayOrder = this.features.branchOrder(project.id);
      const names = new Set([...localBranches, ...projectFeatures.map((feature) => feature.branch_name)]);
      const branches: BranchLane[] = [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
        const feature = projectFeatures.find((item) => item.branch_name === name) ?? null;
        return {
          name,
          exists: localBranches.includes(name),
          is_current: name === currentBranch,
          is_primary: name === primaryBranch,
          ahead: branchRelations[name]?.ahead ?? null,
          behind: branchRelations[name]?.behind ?? null,
          fork_commit: branchRelations[name] === undefined
            ? null
            : toDomainCommit(branchRelations[name].forkCommit),
          display_order: displayOrder.get(name) ?? null,
          feature,
          tasks: feature === null ? [] : allTasks
            .filter((task) => task.feature_id === feature.id)
            .sort((a, b) => a.id - b.id)
            .map((task) => ({
              id: task.id,
              title: task.title,
              status: task.status,
              commit_summary: task.commit_summary,
              is_before_pointer_reset: feature.pointer_reset_task_id !== null
                && task.id <= feature.pointer_reset_task_id
                && task.publish_commit_sha !== null,
              created_at: task.created_at,
              updated_at: task.updated_at,
            })),
        };
      });
      return {
        project,
        current_branch: currentBranch,
        primary_branch: primaryBranch,
        primary_commits: primaryCommits,
        branches,
      };
    }));
  }

  private assertBranchesCanReset(features: readonly Feature[]): void {
    const featureIds = new Set(features.map((feature) => feature.id));
    const blockers = this.tasks.list().filter((task) =>
      task.feature_id !== null && task.feature_id !== undefined && featureIds.has(task.feature_id)
      && POINTER_RESET_BLOCKING_STATUSES.has(task.status),
    );
    if (blockers.length === 0) return;
    const details = blockers.map((task) => `#${task.id} (${task.status})`).join(', ');
    throw new ConflictError(
      `Feature branch pointers cannot be reset while Review or pending-push tasks exist: ${details}.`,
    );
  }
}

function toDomainCommit(commit: {
  sha: string;
  shortSha: string;
  summary: string;
  committedAt: string;
}): BranchCommit {
  return {
    sha: commit.sha,
    short_sha: commit.shortSha,
    summary: commit.summary,
    committed_at: commit.committedAt,
  };
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
