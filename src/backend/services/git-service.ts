import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { AppError, ConflictError, ValidationError } from '../domain/errors.js';
import type { ProcessResult, Task } from '../domain/types.js';
import { ProcessRunner, type ProcessRunnerLike } from '../infra/process-runner.js';

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MANAGED_BRANCH_PATTERN = /^(?:agent|feature)\//u;

export interface PreparedBranch {
  branchName: string;
  workspacePath: string;
  originalBranch: string;
}

export interface PublishedBranch {
  baseBranch: string;
}

export interface BranchSnapshot {
  currentBranch: string;
  localBranches: string[];
  primaryBranch: string;
  primaryCommits: BranchCommit[];
  branchRelations: Record<string, BranchRelation>;
}

export interface BranchCommit {
  sha: string;
  shortSha: string;
  summary: string;
  committedAt: string;
}

export interface BranchRelation {
  forkCommit: BranchCommit;
  ahead: number;
  behind: number;
}

export class GitCommandError extends AppError {
  public constructor(message: string, public readonly result: ProcessResult) {
    super(message, 409, 'GIT_ERROR');
  }
}

export class GitService {
  public constructor(private readonly processRunner: ProcessRunnerLike = new ProcessRunner()) {}

  public async validateRepository(repositoryPath: string, signal?: AbortSignal): Promise<string> {
    if (repositoryPath.trim().length === 0 || repositoryPath.includes('\0')) {
      throw new ValidationError('Repository path is required.');
    }

    const requestedPath = path.resolve(repositoryPath);
    let canonicalPath: string;
    try {
      const metadata = await stat(requestedPath);
      if (!metadata.isDirectory()) {
        throw new ValidationError('Repository path must be a directory.');
      }
      canonicalPath = await realpath(requestedPath);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(`Repository path does not exist or cannot be read: ${requestedPath}`);
    }

    const insideResult = await this.runGit(canonicalPath, ['rev-parse', '--is-inside-work-tree'], signal, true);
    if (insideResult.exitCode !== 0 || insideResult.stdout.trim() !== 'true') {
      throw new ValidationError(`Path is not a Git working tree: ${canonicalPath}`);
    }

    const rootResult = await this.runGit(canonicalPath, ['rev-parse', '--show-toplevel'], signal, true);
    if (rootResult.exitCode !== 0) {
      throw new ValidationError(`Unable to find the Git repository root: ${formatFailure(rootResult)}`);
    }

    try {
      return await realpath(path.resolve(rootResult.stdout.trim()));
    } catch {
      throw new ValidationError('Git returned a repository root that cannot be read.');
    }
  }

  /** Checks out a deterministic task branch. Retries reuse an existing branch. */
  public async prepareBranch(
    task: Task,
    repositoryPath: string,
    signal?: AbortSignal
  ): Promise<PreparedBranch> {
    const repositoryRoot = await this.validateRepository(repositoryPath, signal);
    const branchName = deriveBranchName(task);
    await this.requireCleanCheckout(repositoryRoot, signal);

    const originalBranch = await this.currentBranch(repositoryRoot, signal);
    if (MANAGED_BRANCH_PATTERN.test(originalBranch)) {
      throw new ConflictError(
        `Repository is already on agent branch ${originalBranch}. Check out its base branch before running the Worker.`
      );
    }

    const branchExists = await this.localBranchExists(repositoryRoot, branchName, signal);
    if (!branchExists && task.base_branch !== null && originalBranch !== task.base_branch) {
      throw new ConflictError(
        `Repository must be on feature base branch ${task.base_branch} before creating ${branchName}; it is on ${originalBranch}.`
      );
    }
    const switched = await this.runGit(
      repositoryRoot,
      branchExists ? ['switch', branchName] : ['switch', '-c', branchName],
      signal,
      true
    );
    if (switched.exitCode !== 0) {
      throw new GitCommandError(`Unable to check out task branch ${branchName}: ${formatFailure(switched)}`, switched);
    }

    if (await this.currentBranch(repositoryRoot, signal) !== branchName) {
      throw new ConflictError(`Git did not check out the expected task branch ${branchName}.`);
    }

    return { branchName, workspacePath: repositoryRoot, originalBranch };
  }

  /** Checkpoints task changes locally and restores the branch active before the task. */
  public async completeBranch(
    prepared: PreparedBranch,
    taskId: number,
    commitSummary?: string
  ): Promise<boolean> {
    const currentBranch = await this.currentBranch(prepared.workspacePath);
    if (currentBranch !== prepared.branchName) {
      throw new ConflictError(
        `Cannot finalize task branch ${prepared.branchName}; repository is on ${currentBranch}.`
      );
    }

    const statusResult = await this.runGit(
      prepared.workspacePath,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      undefined,
      false
    );
    const hasChanges = statusResult.stdout.trim().length > 0;

    if (hasChanges) {
      const message = commitSummary === undefined
        ? `chore(agent): checkpoint task #${taskId}`
        : requireCanonicalCommitSummary(commitSummary);
      await this.runGit(prepared.workspacePath, ['add', '--all'], undefined, false);
      const commit = await this.runGit(
        prepared.workspacePath,
        [
          '-c', 'user.name=AI Agent Task Orchestrator',
          '-c', 'user.email=agent@localhost',
          'commit', '-m', message
        ],
        undefined,
        true
      );
      if (commit.exitCode !== 0) {
        throw new GitCommandError(
          `Unable to checkpoint task branch ${prepared.branchName}: ${formatFailure(commit)}`,
          commit
        );
      }
    }

    const restored = await this.runGit(
      prepared.workspacePath,
      ['switch', prepared.originalBranch],
      undefined,
      true
    );
    if (restored.exitCode !== 0) {
      throw new GitCommandError(
        `Task branch was saved, but Git could not restore ${prepared.originalBranch}: ${formatFailure(restored)}`,
        restored
      );
    }
    return hasChanges;
  }

  /** Merges an approved task branch into its base branch and pushes that branch to origin. */
  public async publishBranch(
    repositoryPath: string,
    taskBranch: string,
    storedBaseBranch: string | null
  ): Promise<PublishedBranch> {
    const repositoryRoot = await this.validateRepository(repositoryPath);
    await this.requireCleanCheckout(repositoryRoot);
    const current = await this.currentBranch(repositoryRoot);
    const baseBranch = storedBaseBranch ?? current;

    if (MANAGED_BRANCH_PATTERN.test(baseBranch) || current !== baseBranch) {
      throw new ConflictError(
        `Repository must be on the task base branch ${baseBranch} before publishing; it is on ${current}.`
      );
    }
    if (!MANAGED_BRANCH_PATTERN.test(taskBranch) || !await this.localBranchExists(repositoryRoot, taskBranch)) {
      throw new ConflictError(`Task branch is missing or is not managed by the orchestrator: ${taskBranch}`);
    }

    const alreadyMerged = await this.runGit(
      repositoryRoot,
      ['merge-base', '--is-ancestor', taskBranch, baseBranch],
      undefined,
      true
    );
    if (alreadyMerged.exitCode !== 0 && alreadyMerged.exitCode !== 1) {
      throw new GitCommandError(
        `Unable to compare ${taskBranch} with ${baseBranch}: ${formatFailure(alreadyMerged)}`,
        alreadyMerged
      );
    }

    if (alreadyMerged.exitCode === 1) {
      const fastForward = await this.runGit(
        repositoryRoot,
        ['merge', '--ff-only', taskBranch],
        undefined,
        true
      );
      if (fastForward.exitCode !== 0) {
        const merged = await this.runGit(
          repositoryRoot,
          [
            '-c', 'user.name=AI Agent Task Orchestrator',
            '-c', 'user.email=agent@localhost',
            'merge', '--no-ff', '--no-edit', taskBranch
          ],
          undefined,
          true
        );
        if (merged.exitCode !== 0) {
          await this.runGit(repositoryRoot, ['merge', '--abort'], undefined, true);
          throw new GitCommandError(
            `Unable to merge ${taskBranch} into ${baseBranch}: ${formatFailure(merged)}`,
            merged
          );
        }
      }
    }

    const pushed = await this.runGit(
      repositoryRoot,
      ['push', 'origin', baseBranch],
      undefined,
      true
    );
    if (pushed.exitCode !== 0) {
      throw new GitCommandError(
        `Task branch was merged locally, but ${baseBranch} could not be pushed to origin: ${formatFailure(pushed)}`,
        pushed
      );
    }

    return { baseBranch };
  }

  /** Pushes a shared feature branch without merging it into the base branch. */
  public async pushFeatureBranch(repositoryPath: string, featureBranch: string): Promise<void> {
    const repositoryRoot = await this.validateRepository(repositoryPath);
    await this.requireCleanCheckout(repositoryRoot);
    if (!/^feature\//u.test(featureBranch) || !await this.localBranchExists(repositoryRoot, featureBranch)) {
      throw new ConflictError(`Feature branch is missing or unmanaged: ${featureBranch}`);
    }
    const pushed = await this.runGit(
      repositoryRoot,
      ['push', '--set-upstream', 'origin', featureBranch],
      undefined,
      true,
    );
    if (pushed.exitCode !== 0) {
      throw new GitCommandError(`Unable to push feature branch ${featureBranch}: ${formatFailure(pushed)}`, pushed);
    }
  }

  public async inspectBranches(repositoryPath: string): Promise<BranchSnapshot> {
    const repositoryRoot = await this.validateRepository(repositoryPath);
    const currentBranch = await this.currentBranch(repositoryRoot);
    const branches = await this.runGit(
      repositoryRoot,
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      undefined,
      true,
    );
    if (branches.exitCode !== 0) {
      throw new GitCommandError(`Unable to list repository branches: ${formatFailure(branches)}`, branches);
    }
    const localBranches = branches.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    const primaryBranch = localBranches.includes('main')
      ? 'main'
      : localBranches.includes('master') ? 'master' : currentBranch;
    if (localBranches.length === 0) {
      return {
        currentBranch,
        localBranches,
        primaryBranch,
        primaryCommits: [],
        branchRelations: {},
      };
    }
    const primaryLog = await this.runGit(
      repositoryRoot,
      ['log', primaryBranch, '--max-count=12', '--format=%H%x1f%h%x1f%s%x1f%cI'],
      undefined,
      true,
    );
    if (primaryLog.exitCode !== 0) {
      throw new GitCommandError(`Unable to inspect ${primaryBranch} history: ${formatFailure(primaryLog)}`, primaryLog);
    }
    const primaryCommits = parseBranchCommits(primaryLog.stdout).reverse();
    const branchRelations: Record<string, BranchRelation> = {};
    await Promise.all(localBranches.filter((branch) => branch !== primaryBranch).map(async (branch) => {
      const mergeBase = await this.runGit(repositoryRoot, ['merge-base', primaryBranch, branch], undefined, true);
      const counts = await this.runGit(
        repositoryRoot,
        ['rev-list', '--left-right', '--count', `${primaryBranch}...${branch}`],
        undefined,
        true,
      );
      if (mergeBase.exitCode !== 0 || counts.exitCode !== 0) return;
      const forkLog = await this.runGit(
        repositoryRoot,
        ['show', '-s', '--format=%H%x1f%h%x1f%s%x1f%cI', mergeBase.stdout.trim()],
        undefined,
        true,
      );
      const forkCommit = parseBranchCommits(forkLog.stdout)[0];
      const [behindText, aheadText] = counts.stdout.trim().split(/\s+/u);
      if (forkLog.exitCode === 0 && forkCommit !== undefined) {
        branchRelations[branch] = {
          forkCommit,
          ahead: Number.parseInt(aheadText ?? '0', 10),
          behind: Number.parseInt(behindText ?? '0', 10),
        };
      }
    }));
    return { currentBranch, localBranches, primaryBranch, primaryCommits, branchRelations };
  }

  /** Removes a task branch after merge verification, or force-removes explicitly rejected work. */
  public async removeTaskBranch(
    repositoryPath: string,
    taskBranch: string,
    baseBranch: string | null,
    allowUnmerged = false
  ): Promise<boolean> {
    const repositoryRoot = await this.validateRepository(repositoryPath);
    await this.requireCleanCheckout(repositoryRoot);
    const current = await this.currentBranch(repositoryRoot);
    const expectedBase = baseBranch ?? current;

    if (MANAGED_BRANCH_PATTERN.test(expectedBase) || current !== expectedBase) {
      throw new ConflictError(
        `Repository must be on the task base branch ${expectedBase} before removing ${taskBranch}; it is on ${current}.`
      );
    }
    if (!MANAGED_BRANCH_PATTERN.test(taskBranch)) {
      throw new ConflictError(`Task branch is not managed by the orchestrator: ${taskBranch}`);
    }
    if (!await this.localBranchExists(repositoryRoot, taskBranch)) {
      return false;
    }

    if (!allowUnmerged) {
      const merged = await this.runGit(
        repositoryRoot,
        ['merge-base', '--is-ancestor', taskBranch, expectedBase],
        undefined,
        true
      );
      if (merged.exitCode !== 0) {
        if (merged.exitCode === 1) {
          throw new ConflictError(
            `Task branch ${taskBranch} is not fully merged into ${expectedBase} and cannot be removed.`
          );
        }
        throw new GitCommandError(
          `Unable to verify whether ${taskBranch} is merged into ${expectedBase}: ${formatFailure(merged)}`,
          merged
        );
      }
    }

    const removed = await this.runGit(
      repositoryRoot,
      allowUnmerged
        ? ['branch', '--delete', '--force', taskBranch]
        : ['branch', '--delete', taskBranch],
      undefined,
      true
    );
    if (removed.exitCode !== 0) {
      throw new GitCommandError(
        `Unable to remove task branch ${taskBranch}: ${formatFailure(removed)}`,
        removed
      );
    }
    return true;
  }

  private async requireCleanCheckout(repositoryRoot: string, signal?: AbortSignal): Promise<void> {
    const result = await this.runGit(
      repositoryRoot,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      signal,
      false
    );
    if (result.stdout.trim().length > 0) {
      throw new ConflictError(
        'Repository has uncommitted changes. Commit, stash, or discard them before the Worker switches branches.'
      );
    }
  }

  private async currentBranch(repositoryRoot: string, signal?: AbortSignal): Promise<string> {
    const result = await this.runGit(
      repositoryRoot,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      signal,
      true
    );
    const branch = result.stdout.trim();
    if (result.exitCode !== 0 || branch.length === 0) {
      throw new ConflictError('Repository must be on a named branch; detached HEAD is not supported.');
    }
    return branch;
  }

  private async localBranchExists(
    repositoryRoot: string,
    branchName: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    const result = await this.runGit(
      repositoryRoot,
      ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
      signal,
      true
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitCommandError(`Unable to inspect branch ${branchName}: ${formatFailure(result)}`, result);
  }

  private async runGit(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
    allowFailure: boolean
  ): Promise<ProcessResult> {
    const result = await this.processRunner.run({
      command: 'git',
      args,
      cwd,
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_LIMIT_BYTES,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    if (!allowFailure && result.exitCode !== 0) {
      throw new GitCommandError(`Git command failed: ${formatFailure(result)}`, result);
    }
    return result;
  }
}

function parseBranchCommits(output: string): BranchCommit[] {
  return output.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    const [sha, shortSha, summary, committedAt] = line.split('\x1f');
    return sha !== undefined && shortSha !== undefined && summary !== undefined && committedAt !== undefined
      ? [{ sha, shortSha, summary, committedAt }]
      : [];
  });
}

export function requireCanonicalCommitSummary(summary: string): string {
  const canonical = summary.trim();
  if (
    canonical.length === 0 ||
    canonical.length > 240 ||
    /[\r\n]/u.test(canonical) ||
    !canonical.endsWith('.')
  ) {
    throw new ValidationError(
      'Codex must return one canonical commit-message summary of at most 240 characters ending with a period.'
    );
  }
  return canonical;
}

export function slugifyTaskTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
    .replace(/-+$/gu, '');
  return slug.length > 0 ? slug : 'task';
}

function deriveBranchName(task: Task): string {
  if (!Number.isSafeInteger(task.id) || task.id <= 0) {
    throw new ValidationError('Task must have a positive integer id before preparing a branch.');
  }
  const branchName = task.branch_name ?? `agent/${task.id}-${slugifyTaskTitle(task.title)}`;
  if (/^feature\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(branchName)) {
    return branchName;
  }
  const branchOwnerId = task.source_task_id ?? task.id;
  const branchPattern = new RegExp(
    `^agent/${branchOwnerId}-([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$`,
    'u'
  );
  if (!branchPattern.test(branchName)) {
    throw new ValidationError(`Task branch is not a safe orchestrator branch: ${branchName}`);
  }
  return branchName;
}

function formatFailure(result: ProcessResult): string {
  if (result.timedOut) return 'operation timed out';
  if (result.aborted) return 'operation was cancelled';
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail.length > 0 ? detail : `git exited with code ${result.exitCode}`;
}
