import { appendFile, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { ConflictError, ValidationError } from '../domain/errors.js';
import type { ProcessResult, Task } from '../domain/types.js';
import { ProcessRunner, type ProcessRunnerLike } from '../infra/process-runner.js';

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const LOCAL_WORKTREE_EXCLUDE = '/.worktrees/';

export interface PreparedWorktree {
  branchName: string;
  worktreePath: string;
}

export class GitCommandError extends Error {
  public constructor(
    message: string,
    public readonly result: ProcessResult
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

export class GitService {
  public constructor(private readonly processRunner: ProcessRunnerLike = new ProcessRunner()) {}

  /** Resolves a user-selected directory to the canonical root of a non-bare Git worktree. */
  public async validateRepository(
    repositoryPath: string,
    signal?: AbortSignal
  ): Promise<string> {
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

    const insideResult = await this.runGit(
      canonicalPath,
      ['rev-parse', '--is-inside-work-tree'],
      signal,
      true
    );
    if (insideResult.exitCode !== 0 || insideResult.stdout.trim() !== 'true') {
      throw new ValidationError(`Path is not a Git working tree: ${canonicalPath}`);
    }

    const rootResult = await this.runGit(
      canonicalPath,
      ['rev-parse', '--show-toplevel'],
      signal,
      true
    );
    if (rootResult.exitCode !== 0) {
      throw new ValidationError(`Unable to find the Git repository root: ${formatFailure(rootResult)}`);
    }

    try {
      return await realpath(path.resolve(rootResult.stdout.trim()));
    } catch {
      throw new ValidationError('Git returned a repository root that cannot be read.');
    }
  }

  /**
   * Creates a task branch and linked worktree without checking out or modifying
   * the repository's current branch. A retry reuses only an exact, safe match.
   */
  public async prepareWorktree(
    task: Task,
    repositoryPath: string,
    signal?: AbortSignal
  ): Promise<PreparedWorktree> {
    const repositoryRoot = await this.validateRepository(repositoryPath, signal);
    const identifiers = deriveIdentifiers(task, repositoryRoot);

    await this.ensureLocalWorktreesAreExcluded(repositoryRoot, signal);
    await ensureSafeWorktreeContainer(path.dirname(identifiers.worktreePath));

    if (await pathExists(identifiers.worktreePath)) {
      await this.validateExistingWorktree(
        repositoryRoot,
        identifiers.worktreePath,
        identifiers.branchName,
        signal
      );
      return identifiers;
    }

    const registrations = await this.listWorktrees(repositoryRoot, signal);
    const registeredBranch = registrations.find(
      (entry) => entry.branchName === identifiers.branchName
    );
    if (registeredBranch !== undefined) {
      throw new ConflictError(
        `Branch ${identifiers.branchName} is already checked out at ${registeredBranch.worktreePath}.`
      );
    }

    const registeredPath = registrations.find((entry) =>
      samePath(entry.worktreePath, identifiers.worktreePath)
    );
    if (registeredPath !== undefined) {
      throw new ConflictError(
        `Git still has ${identifiers.worktreePath} registered for ${registeredPath.branchName ?? 'a detached HEAD'}.`
      );
    }

    const branchExists = await this.localBranchExists(
      repositoryRoot,
      identifiers.branchName,
      signal
    );
    const args = branchExists
      ? ['worktree', 'add', identifiers.worktreePath, identifiers.branchName]
      : [
          'worktree',
          'add',
          '-b',
          identifiers.branchName,
          identifiers.worktreePath,
          'HEAD'
        ];

    const result = await this.runGit(repositoryRoot, args, signal, true);
    if (result.exitCode !== 0) {
      throw new GitCommandError(
        `Unable to create worktree for ${identifiers.branchName}: ${formatFailure(result)}`,
        result
      );
    }

    await this.validateExistingWorktree(
      repositoryRoot,
      identifiers.worktreePath,
      identifiers.branchName,
      signal
    );
    return identifiers;
  }

  /** Alias retained for composition code that uses the longer operation name. */
  public async prepareTaskWorktree(
    task: Task,
    repositoryPath: string,
    signal?: AbortSignal
  ): Promise<PreparedWorktree> {
    return await this.prepareWorktree(task, repositoryPath, signal);
  }

  private async validateExistingWorktree(
    repositoryRoot: string,
    worktreePath: string,
    branchName: string,
    signal?: AbortSignal
  ): Promise<void> {
    const metadata = await lstat(worktreePath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ConflictError(`Expected worktree path is not a real directory: ${worktreePath}`);
    }

    const canonicalWorktree = await realpath(worktreePath);
    const topLevel = await this.runGit(
      canonicalWorktree,
      ['rev-parse', '--show-toplevel'],
      signal,
      true
    );
    if (topLevel.exitCode !== 0) {
      throw new ConflictError(`Existing path is not a Git worktree: ${worktreePath}`);
    }

    let canonicalTopLevel: string;
    try {
      canonicalTopLevel = await realpath(path.resolve(topLevel.stdout.trim()));
    } catch {
      throw new ConflictError(`Existing worktree root cannot be resolved: ${worktreePath}`);
    }
    if (!samePath(canonicalTopLevel, canonicalWorktree)) {
      throw new ConflictError(`Existing path is nested inside a different Git worktree: ${worktreePath}`);
    }

    const branch = await this.runGit(
      canonicalWorktree,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      signal,
      true
    );
    if (branch.exitCode !== 0 || branch.stdout.trim() !== branchName) {
      throw new ConflictError(
        `Existing worktree is not on the expected branch ${branchName}: ${worktreePath}`
      );
    }

    const [sourceCommonDir, worktreeCommonDir] = await Promise.all([
      this.getCommonGitDirectory(repositoryRoot, signal),
      this.getCommonGitDirectory(canonicalWorktree, signal)
    ]);
    if (!samePath(sourceCommonDir, worktreeCommonDir)) {
      throw new ConflictError(`Existing worktree belongs to a different Git repository: ${worktreePath}`);
    }
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
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    throw new GitCommandError(`Unable to inspect branch ${branchName}: ${formatFailure(result)}`, result);
  }

  private async listWorktrees(
    repositoryRoot: string,
    signal?: AbortSignal
  ): Promise<WorktreeRegistration[]> {
    const result = await this.runGit(
      repositoryRoot,
      ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain', '-z'],
      signal,
      true
    );
    if (result.exitCode !== 0) {
      throw new GitCommandError(`Unable to list Git worktrees: ${formatFailure(result)}`, result);
    }

    return parseWorktreeList(result.stdout);
  }

  private async ensureLocalWorktreesAreExcluded(
    repositoryRoot: string,
    signal?: AbortSignal
  ): Promise<void> {
    const commonDirectory = await this.getCommonGitDirectory(repositoryRoot, signal);
    const infoDirectory = path.join(commonDirectory, 'info');
    const excludePath = path.join(infoDirectory, 'exclude');
    await mkdir(infoDirectory, { recursive: true });

    let existing = '';
    try {
      existing = await readFile(excludePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }

    const hasEntry = existing
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .includes(LOCAL_WORKTREE_EXCLUDE);
    if (hasEntry) {
      return;
    }

    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await appendFile(excludePath, `${prefix}${LOCAL_WORKTREE_EXCLUDE}\n`, 'utf8');
  }

  private async getCommonGitDirectory(
    repositoryRoot: string,
    signal?: AbortSignal
  ): Promise<string> {
    const result = await this.runGit(
      repositoryRoot,
      ['rev-parse', '--git-common-dir'],
      signal,
      true
    );
    if (result.exitCode !== 0) {
      throw new GitCommandError(`Unable to locate Git metadata: ${formatFailure(result)}`, result);
    }

    const rawPath = result.stdout.trim();
    const resolvedPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(repositoryRoot, rawPath);
    try {
      return await realpath(resolvedPath);
    } catch {
      throw new ValidationError('Git common directory cannot be read.');
    }
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
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      }
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

function deriveIdentifiers(task: Task, repositoryRoot: string): PreparedWorktree {
  if (!Number.isSafeInteger(task.id) || task.id <= 0) {
    throw new ValidationError('Task must have a positive integer id before preparing a worktree.');
  }

  const defaultBranchName = `agent/${task.id}-${slugifyTaskTitle(task.title)}`;
  const branchName = task.branch_name ?? defaultBranchName;
  const branchPattern = new RegExp(`^agent/${task.id}-([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$`, 'u');
  const match = branchPattern.exec(branchName);
  if (match === null) {
    throw new ValidationError(`Task branch is not a safe orchestrator branch: ${branchName}`);
  }

  const suffix = `${task.id}-${match[1]}`;
  const expectedPath = path.resolve(repositoryRoot, '.worktrees', suffix);
  ensureDescendant(repositoryRoot, expectedPath);

  if (task.worktree_path !== null && !samePath(path.resolve(task.worktree_path), expectedPath)) {
    throw new ValidationError('Task worktree path does not match its safe branch identifier.');
  }

  return { branchName, worktreePath: expectedPath };
}

function ensureDescendant(parentPath: string, candidatePath: string): void {
  const relative = path.relative(parentPath, candidatePath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ValidationError('Task worktree path must remain inside the repository.');
  }
}

async function ensureSafeWorktreeContainer(containerPath: string): Promise<void> {
  try {
    const metadata = await lstat(containerPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ValidationError(`Worktree container must be a real directory: ${containerPath}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
    await mkdir(containerPath, { recursive: false });
  }
}

interface WorktreeRegistration {
  worktreePath: string;
  branchName: string | null;
}

function parseWorktreeList(output: string): WorktreeRegistration[] {
  const registrations: WorktreeRegistration[] = [];
  const blocks = output.includes('\0')
    ? output.split('\0\0')
    : output.trim().split(/\r?\n\r?\n/u);
  for (const block of blocks) {
    if (block.trim().length === 0) {
      continue;
    }
    const lines = block.split(output.includes('\0') ? '\0' : /\r?\n/u);
    const worktreeLine = lines.find((line) => line.startsWith('worktree '));
    if (worktreeLine === undefined) {
      continue;
    }
    const branchLine = lines.find((line) => line.startsWith('branch refs/heads/'));
    registrations.push({
      worktreePath: path.resolve(worktreeLine.slice('worktree '.length)),
      branchName: branchLine?.slice('branch refs/heads/'.length) ?? null
    });
  }
  return registrations;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await lstat(candidatePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function samePath(first: string, second: string): boolean {
  const normalizedFirst = path.normalize(first);
  const normalizedSecond = path.normalize(second);
  return process.platform === 'win32'
    ? normalizedFirst.toLowerCase() === normalizedSecond.toLowerCase()
    : normalizedFirst === normalizedSecond;
}

function formatFailure(result: ProcessResult): string {
  if (result.timedOut) {
    return 'operation timed out';
  }
  if (result.aborted) {
    return 'operation was cancelled';
  }
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail.length > 0 ? detail : `git exited with code ${result.exitCode}`;
}
