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
  startingCommitSha: string;
}

export interface PreparedCherryPick extends PreparedBranch {
  sourceCommitSha: string;
}

export interface PublishedBranch {
  baseBranch: string;
}

export interface RunDiff {
  fileDiff: string;
  codeDiff: string;
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
  public constructor(message: string, public readonly result: ProcessResult, code = 'GIT_ERROR') {
    super(message, 409, code);
  }
}

export class CherryPickConflictError extends GitCommandError {
  public constructor(
    message: string,
    result: ProcessResult,
    public readonly conflictedFiles: readonly string[],
  ) {
    super(message, result, 'CHERRY_PICK_CONFLICT');
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
    const branchExists = await this.localBranchExists(repositoryRoot, branchName, signal);
    const requiredBase = task.feature_id === null || task.feature_id === undefined
      ? task.base_branch
      : 'main';
    if (!branchExists && requiredBase !== null && originalBranch !== requiredBase) {
      throw new ConflictError(
        `Repository must be on ${requiredBase} before creating ${branchName}; it is on ${originalBranch}.`
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

    const startingCommitSha = await this.currentCommit(repositoryRoot, signal);
    return { branchName, workspacePath: repositoryRoot, originalBranch, startingCommitSha };
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

  /** Captures an immutable, read-only snapshot of files and code changed by one task run. */
  public async captureRunDiff(prepared: PreparedBranch): Promise<RunDiff> {
    const range = `${prepared.startingCommitSha}..${prepared.branchName}`;
    const [fileResult, codeResult] = await Promise.all([
      this.runGit(
        prepared.workspacePath,
        ['-c', 'core.quotePath=false', 'diff', '--numstat', '--no-renames', range],
        undefined,
        false,
      ),
      this.runGit(
        prepared.workspacePath,
        ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-renames', range],
        undefined,
        false,
      ),
    ]);
    return {
      fileDiff: fileResult.stdout,
      codeDiff: codeResult.stdout,
    };
  }

  /** Creates a disposable main-based branch for Codex-assisted cherry-pick resolution. */
  public async prepareCherryPickResolution(
    task: Task,
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<PreparedCherryPick> {
    if (task.branch_name === null || !/^feature\//u.test(task.branch_name)) {
      throw new ConflictError('Cherry-pick resolution requires a managed Feature branch.');
    }
    const repositoryRoot = await this.validateRepository(repositoryPath, signal);
    await this.requireCleanCheckout(repositoryRoot, signal);
    const originalBranch = await this.currentBranch(repositoryRoot, signal);
    const baseBranch = task.base_branch ?? 'main';
    if (originalBranch !== baseBranch) {
      throw new ConflictError(
        `Repository must be on ${baseBranch} before resolving a cherry-pick conflict; it is on ${originalBranch}.`,
      );
    }
    const sourceCommitSha = await this.resolveTaskCommit(
      repositoryRoot,
      task.branch_name,
      task.publish_commit_sha,
      task.commit_summary,
      signal,
    );
    const branchName = `agent/${task.id}-cherry-pick-resolution`;
    if (await this.localBranchExists(repositoryRoot, branchName, signal)) {
      const removed = await this.runGit(repositoryRoot, ['branch', '--delete', '--force', branchName], signal, true);
      if (removed.exitCode !== 0) {
        throw new GitCommandError(`Unable to reset temporary branch ${branchName}: ${formatFailure(removed)}`, removed);
      }
    }
    const created = await this.runGit(repositoryRoot, ['switch', '-c', branchName, baseBranch], signal, true);
    if (created.exitCode !== 0) {
      throw new GitCommandError(`Unable to create temporary branch ${branchName}: ${formatFailure(created)}`, created);
    }
    const startingCommitSha = await this.currentCommit(repositoryRoot, signal);
    return { branchName, workspacePath: repositoryRoot, originalBranch, startingCommitSha, sourceCommitSha };
  }

  /** Starts a controlled single-commit cherry-pick, leaving conflicts available for the agent. */
  public async beginFeatureCherryPick(
    workspacePath: string,
    sourceCommitSha: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const picked = await this.runGit(workspacePath, ['cherry-pick', sourceCommitSha], signal, true);
    if (picked.exitCode === 0) return true;
    if ((await this.conflictFiles(workspacePath, signal)).length > 0) return false;
    throw new GitCommandError(`Unable to start task cherry-pick: ${formatFailure(picked)}`, picked);
  }

  /** Stages files resolved by the agent and completes the selected commit cherry-pick. */
  public async continueFeatureCherryPick(workspacePath: string, signal?: AbortSignal): Promise<boolean> {
    const markerCheck = await this.runGit(workspacePath, ['diff', '--check'], signal, true);
    if (markerCheck.exitCode !== 0) {
      throw new GitCommandError(
        `Conflict markers remain in the agent's cherry-pick resolution: ${formatFailure(markerCheck)}`,
        markerCheck,
      );
    }
    const staged = await this.runGit(workspacePath, ['add', '--all'], signal, true);
    if (staged.exitCode !== 0) {
      throw new GitCommandError(`Unable to stage resolved cherry-pick files: ${formatFailure(staged)}`, staged);
    }
    const continued = await this.runGit(
      workspacePath,
      ['-c', 'core.editor=true', 'cherry-pick', '--continue'],
      signal,
      true,
    );
    if (continued.exitCode === 0) return true;
    if ((await this.conflictFiles(workspacePath, signal)).length > 0) return false;
    throw new GitCommandError(`Unable to continue the task cherry-pick: ${formatFailure(continued)}`, continued);
  }

  public async abortFeatureCherryPick(workspacePath: string): Promise<void> {
    const aborted = await this.runGit(workspacePath, ['cherry-pick', '--abort'], undefined, true);
    if (aborted.exitCode !== 0) {
      throw new GitCommandError(`Unable to abort the task cherry-pick safely: ${formatFailure(aborted)}`, aborted);
    }
  }

  public async currentCommit(workspacePath: string, signal?: AbortSignal): Promise<string> {
    return await this.commitAtRef(workspacePath, 'HEAD', signal);
  }

  public async commitAtRef(workspacePath: string, ref: string, signal?: AbortSignal): Promise<string> {
    const result = await this.runGit(workspacePath, ['rev-parse', `${ref}^{commit}`], signal, true);
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      throw new GitCommandError(`Unable to read commit ${ref}: ${formatFailure(result)}`, result);
    }
    return result.stdout.trim();
  }

  /** Checks out an exact task snapshot on a disposable branch for human review. */
  public async beginTaskReview(task: Task, repositoryPath: string): Promise<string> {
    if (task.branch_name === null || !MANAGED_BRANCH_PATTERN.test(task.branch_name)) {
      throw new ConflictError('The task has no managed Git branch to review.');
    }
    const repositoryRoot = await this.validateRepository(repositoryPath);
    await this.requireCleanCheckout(repositoryRoot);
    const baseBranch = task.base_branch ?? 'main';
    const current = await this.currentBranch(repositoryRoot);
    if (current !== baseBranch) {
      throw new ConflictError(
        `Repository must be on ${baseBranch} before starting Review; it is on ${current}.`,
      );
    }
    const targetCommit = task.feature_id === null || task.feature_id === undefined
      ? await this.commitAtRef(repositoryRoot, task.branch_name)
      : await this.resolveTaskCommit(
          repositoryRoot,
          task.branch_name,
          task.publish_commit_sha,
          task.commit_summary,
        );
    const reviewBranch = `agent/${task.id}-review`;
    if (await this.localBranchExists(repositoryRoot, reviewBranch)) {
      const removed = await this.runGit(repositoryRoot, ['branch', '--delete', '--force', reviewBranch], undefined, true);
      if (removed.exitCode !== 0) {
        throw new GitCommandError(`Unable to reset Review branch ${reviewBranch}: ${formatFailure(removed)}`, removed);
      }
    }
    const switched = await this.runGit(repositoryRoot, ['switch', '-c', reviewBranch, targetCommit], undefined, true);
    if (switched.exitCode !== 0) {
      throw new GitCommandError(`Unable to check out Review branch ${reviewBranch}: ${formatFailure(switched)}`, switched);
    }
    return reviewBranch;
  }

  /** Restores the base branch and removes the disposable human Review branch. */
  public async endTaskReview(task: Task, repositoryPath: string): Promise<void> {
    const repositoryRoot = await this.validateRepository(repositoryPath);
    await this.requireCleanCheckout(repositoryRoot);
    const reviewBranch = `agent/${task.id}-review`;
    const current = await this.currentBranch(repositoryRoot);
    if (current !== reviewBranch) {
      throw new ConflictError(`Repository must be on ${reviewBranch} to finish Review; it is on ${current}.`);
    }
    const baseBranch = task.base_branch ?? 'main';
    const restored = await this.runGit(repositoryRoot, ['switch', baseBranch], undefined, true);
    if (restored.exitCode !== 0) {
      throw new GitCommandError(`Unable to restore ${baseBranch} after Review: ${formatFailure(restored)}`, restored);
    }
    const removed = await this.runGit(repositoryRoot, ['branch', '--delete', '--force', reviewBranch], undefined, true);
    if (removed.exitCode !== 0) {
      throw new GitCommandError(`Unable to remove Review branch ${reviewBranch}: ${formatFailure(removed)}`, removed);
    }
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

  /** Cherry-picks only the selected Feature task commit onto main, then pushes main. */
  public async publishFeatureTask(
    repositoryPath: string,
    featureBranch: string,
    baseBranch: string,
    publishCommitSha: string | null,
    commitSummary: string | null,
    taskId?: number,
  ): Promise<PublishedBranch> {
    const repositoryRoot = await this.validateRepository(repositoryPath);
    await this.requireCleanCheckout(repositoryRoot);
    const currentBranch = await this.currentBranch(repositoryRoot);
    if (currentBranch !== baseBranch) {
      throw new ConflictError(
        `Repository must be on ${baseBranch} before publishing ${featureBranch}; it is on ${currentBranch}.`
      );
    }
    if (!/^feature\//u.test(featureBranch) || !await this.localBranchExists(repositoryRoot, featureBranch)) {
      throw new ConflictError(`Feature branch is missing or unmanaged: ${featureBranch}`);
    }

    const sourceCommitSha = await this.resolveTaskCommit(
      repositoryRoot,
      featureBranch,
      publishCommitSha,
      commitSummary,
    );
    const alreadyPublished = await this.runGit(
      repositoryRoot,
      ['merge-base', '--is-ancestor', sourceCommitSha, baseBranch],
      undefined,
      true,
    );
    if (alreadyPublished.exitCode !== 0 && alreadyPublished.exitCode !== 1) {
      throw new GitCommandError(`Unable to compare the task commit with ${baseBranch}: ${formatFailure(alreadyPublished)}`, alreadyPublished);
    }

    let patchAlreadyPublished = alreadyPublished.exitCode === 0;
    if (!patchAlreadyPublished) {
      const equivalent = await this.runGit(
        repositoryRoot,
        ['cherry', baseBranch, sourceCommitSha],
        undefined,
        true,
      );
      if (equivalent.exitCode !== 0) {
        throw new GitCommandError(`Unable to compare the task patch with ${baseBranch}: ${formatFailure(equivalent)}`, equivalent);
      }
      patchAlreadyPublished = equivalent.stdout.split(/\r?\n/u)
        .some((line) => line.trim() === `- ${sourceCommitSha}`);
    }

    if (!patchAlreadyPublished) {
      const picked = await this.runGit(repositoryRoot, ['cherry-pick', sourceCommitSha], undefined, true);
      if (picked.exitCode !== 0) {
        const conflictedFiles = await this.conflictFiles(repositoryRoot);
        const aborted = await this.runGit(repositoryRoot, ['cherry-pick', '--abort'], undefined, true);
        if (aborted.exitCode !== 0) {
          throw new GitCommandError(`Cherry-pick failed and could not be aborted safely: ${formatFailure(aborted)}`, aborted);
        }
        if (conflictedFiles.length > 0) {
          throw new CherryPickConflictError(
            `Cherry-pick conflict detected in ${conflictedFiles.join(', ')} while publishing the selected task from ${featureBranch}.`,
            picked,
            conflictedFiles,
          );
        }
        throw new GitCommandError(`Unable to cherry-pick the selected task commit: ${formatFailure(picked)}`, picked);
      }
    }

    const pushed = await this.runGit(repositoryRoot, ['push', 'origin', baseBranch], undefined, true);
    if (pushed.exitCode !== 0) {
      throw new GitCommandError(
        `${baseBranch} contains the selected task commit locally, but could not be pushed to origin: ${formatFailure(pushed)}`,
        pushed,
      );
    }
    if (taskId !== undefined) {
      const resolutionBranch = `agent/${taskId}-cherry-pick-resolution`;
      if (await this.localBranchExists(repositoryRoot, resolutionBranch)) {
        const removed = await this.runGit(
          repositoryRoot,
          ['branch', '--delete', '--force', resolutionBranch],
          undefined,
          true,
        );
        if (removed.exitCode !== 0) {
          throw new GitCommandError(
            `${baseBranch} was pushed, but temporary branch ${resolutionBranch} could not be removed: ${formatFailure(removed)}`,
            removed,
          );
        }
      }
    }
    return { baseBranch };
  }

  private async resolveTaskCommit(
    repositoryRoot: string,
    featureBranch: string,
    publishCommitSha: string | null,
    commitSummary: string | null,
    signal?: AbortSignal,
  ): Promise<string> {
    if (publishCommitSha !== null) {
      const exists = await this.runGit(repositoryRoot, ['cat-file', '-e', `${publishCommitSha}^{commit}`], signal, true);
      if (exists.exitCode !== 0) {
        throw new ConflictError(`The prepared publish commit ${publishCommitSha} no longer exists.`);
      }
      return publishCommitSha;
    }
    const canonicalSummary = commitSummary?.trim() ?? '';
    if (canonicalSummary.length === 0) {
      throw new ConflictError('The task has no canonical commit summary, so its Feature commit cannot be selected safely.');
    }
    const log = await this.runGit(repositoryRoot, ['log', featureBranch, '--format=%H%x1f%s'], signal, true);
    if (log.exitCode !== 0) {
      throw new GitCommandError(`Unable to inspect Feature history: ${formatFailure(log)}`, log);
    }
    const matches = log.stdout.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
      const separator = line.indexOf('\x1f');
      return separator > 0 && line.slice(separator + 1) === canonicalSummary
        ? [line.slice(0, separator)]
        : [];
    });
    if (matches.length === 0) {
      throw new ConflictError(`No commit on ${featureBranch} exactly matches this task's canonical summary.`);
    }
    if (matches.length > 1) {
      throw new ConflictError(`Multiple commits on ${featureBranch} match this task's canonical summary; publishing is ambiguous.`);
    }
    return matches[0] as string;
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

  private async conflictFiles(repositoryPath: string, signal?: AbortSignal): Promise<string[]> {
    const conflicts = await this.runGit(
      repositoryPath,
      ['diff', '--name-only', '--diff-filter=U'],
      signal,
      true,
    );
    return conflicts.exitCode === 0
      ? conflicts.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)
      : [];
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
