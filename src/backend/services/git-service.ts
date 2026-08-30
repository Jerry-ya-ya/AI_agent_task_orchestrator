import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { ConflictError, ValidationError } from '../domain/errors.js';
import type { ProcessResult, Task } from '../domain/types.js';
import { ProcessRunner, type ProcessRunnerLike } from '../infra/process-runner.js';

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const AGENT_BRANCH_PATTERN = /^agent\//u;

export interface PreparedBranch {
  branchName: string;
  workspacePath: string;
  originalBranch: string;
}

export class GitCommandError extends Error {
  public constructor(message: string, public readonly result: ProcessResult) {
    super(message);
    this.name = 'GitCommandError';
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
    if (AGENT_BRANCH_PATTERN.test(originalBranch)) {
      throw new ConflictError(
        `Repository is already on agent branch ${originalBranch}. Check out its base branch before running the Worker.`
      );
    }

    const branchExists = await this.localBranchExists(repositoryRoot, branchName, signal);
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
  public async completeBranch(prepared: PreparedBranch, taskId: number): Promise<boolean> {
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
      await this.runGit(prepared.workspacePath, ['add', '--all'], undefined, false);
      const commit = await this.runGit(
        prepared.workspacePath,
        [
          '-c', 'user.name=AI Agent Task Orchestrator',
          '-c', 'user.email=agent@localhost',
          'commit', '-m', `chore(agent): checkpoint task #${taskId}`
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
  const branchPattern = new RegExp(
    `^agent/${task.id}-([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$`,
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
