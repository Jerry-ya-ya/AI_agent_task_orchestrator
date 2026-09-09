import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Task } from '../domain/types.js';
import { ProcessRunner } from '../infra/process-runner.js';
import { CherryPickConflictError, GitService, slugifyTaskTitle } from './git-service.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(async (entry) => await rm(entry, { recursive: true, force: true })));
});

describe('GitService', () => {
  it('checkpoints a task branch, restores the source branch, and reuses it on retry', async () => {
    const { repository, runner } = await temporaryRepository();
    const service = new GitService(runner);
    const task = exampleTask();

    const prepared = await service.prepareBranch(task, repository);
    expect(prepared).toEqual({
      branchName: 'agent/101-login-api-rm-rf',
      workspacePath: await realRepositoryPath(runner, repository),
      originalBranch: 'main'
    });
    expect((await git(runner, repository, ['branch', '--show-current'])).trim()).toBe(prepared.branchName);

    await writeFile(path.join(repository, 'feature.txt'), 'agent result\n');
    await expect(service.completeBranch(prepared, task.id, 'feat: implement the login API.')).resolves.toBe(true);
    expect((await git(runner, repository, ['branch', '--show-current'])).trim()).toBe('main');
    await expect(readFile(path.join(repository, 'feature.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await git(runner, repository, ['show', `${prepared.branchName}:feature.txt`])).trim()).toBe('agent result');
    expect((await git(runner, repository, ['log', '-1', '--format=%s', prepared.branchName])).trim())
      .toBe('feat: implement the login API.');

    const reused = await service.prepareBranch(
      { ...task, branch_name: prepared.branchName, worktree_path: prepared.workspacePath },
      repository
    );
    expect(reused.branchName).toBe(prepared.branchName);
    expect((await readFile(path.join(repository, 'feature.txt'), 'utf8')).trim()).toBe('agent result');
    await expect(service.completeBranch(reused, task.id)).resolves.toBe(false);
    expect((await git(runner, repository, ['branch', '--show-current'])).trim()).toBe('main');
  });

  it('refuses to switch branches when the repository has user changes', async () => {
    const { repository, runner } = await temporaryRepository();
    await writeFile(path.join(repository, 'notes.txt'), 'uncommitted\n');

    await expect(new GitService(runner).prepareBranch(exampleTask(), repository)).rejects.toThrow(
      'Repository has uncommitted changes'
    );
    expect((await git(runner, repository, ['branch', '--show-current'])).trim()).toBe('main');
  });

  it('checks out an exact disposable Review branch and restores main when Review ends', async () => {
    const { repository, runner } = await temporaryRepository();
    const service = new GitService(runner);
    const task = exampleTask();
    const prepared = await service.prepareBranch(task, repository);
    await writeFile(path.join(repository, 'review-me.txt'), 'review snapshot\n');
    await service.completeBranch(prepared, task.id, 'feat: add the review snapshot.');
    const reviewTask = {
      ...task,
      status: 'IN_REVIEW' as const,
      branch_name: prepared.branchName,
      base_branch: 'main',
    };

    await expect(service.beginTaskReview(reviewTask, repository))
      .resolves.toBe(`agent/${task.id}-review`);
    expect((await git(runner, repository, ['branch', '--show-current'])).trim())
      .toBe(`agent/${task.id}-review`);
    expect((await readFile(path.join(repository, 'review-me.txt'), 'utf8')).trim()).toBe('review snapshot');

    await service.endTaskReview({ ...reviewTask, status: 'REVIEWING' }, repository);
    expect((await git(runner, repository, ['branch', '--show-current'])).trim()).toBe('main');
    expect(await gitExitCode(runner, repository, [
      'show-ref', '--verify', '--quiet', `refs/heads/agent/${task.id}-review`,
    ])).toBe(1);
  });

  it('runs from a clean managed branch and restores the branch the user was inspecting', async () => {
    const { repository, runner } = await temporaryRepository();
    const service = new GitService(runner);
    const firstTask = { ...exampleTask(), feature_id: 1, branch_name: 'feature/first', base_branch: 'main' };
    const secondTask = { ...exampleTask(), id: 102, feature_id: 2, branch_name: 'feature/second', base_branch: 'main' };

    const first = await service.prepareBranch(firstTask, repository);
    await service.completeBranch(first, firstTask.id);
    const second = await service.prepareBranch(secondTask, repository);
    await service.completeBranch(second, secondTask.id);
    await git(runner, repository, ['switch', firstTask.branch_name]);

    const prepared = await service.prepareBranch(secondTask, repository);
    expect(prepared.originalBranch).toBe(firstTask.branch_name);
    expect((await git(runner, repository, ['branch', '--show-current'])).trim()).toBe(secondTask.branch_name);

    await expect(service.completeBranch(prepared, secondTask.id)).resolves.toBe(false);
    expect((await git(runner, repository, ['branch', '--show-current'])).trim()).toBe(firstTask.branch_name);
  });

  it('requires main when creating every new Feature branch, regardless of stored legacy base data', async () => {
    const { repository, runner } = await temporaryRepository();
    const service = new GitService(runner);
    const existing = { ...exampleTask(), feature_id: 1, branch_name: 'feature/existing', base_branch: 'main' };
    const prepared = await service.prepareBranch(existing, repository);
    await service.completeBranch(prepared, existing.id);
    await git(runner, repository, ['switch', existing.branch_name]);

    const nested = {
      ...exampleTask(), id: 102, feature_id: 2, branch_name: 'feature/nested', base_branch: existing.branch_name,
    };
    await expect(service.prepareBranch(nested, repository)).rejects.toThrow(
      'Repository must be on main before creating feature/nested; it is on feature/existing.',
    );
    expect(await gitExitCode(runner, repository, ['show-ref', '--verify', '--quiet', 'refs/heads/feature/nested']))
      .toBe(1);
  });

  it('publishes an approved task branch to its base branch and origin', async () => {
    const { repository, runner } = await temporaryRepository();
    const remote = await mkdtemp(path.join(tmpdir(), 'orchestrator-remote-'));
    temporaryPaths.push(remote);
    await git(runner, remote, ['init', '--bare']);
    await git(runner, repository, ['remote', 'add', 'origin', remote]);

    const service = new GitService(runner);
    const task = exampleTask();
    const prepared = await service.prepareBranch(task, repository);
    await writeFile(path.join(repository, 'feature.txt'), 'ready to publish\n');
    await service.completeBranch(prepared, task.id, 'feat: add the publishable feature.');

    await expect(service.publishBranch(repository, prepared.branchName, 'main'))
      .resolves.toEqual({ baseBranch: 'main' });

    expect((await git(runner, repository, ['branch', '--show-current'])).trim()).toBe('main');
    expect((await readFile(path.join(repository, 'feature.txt'), 'utf8')).trim()).toBe('ready to publish');
    expect((await git(runner, repository, ['--git-dir', remote, 'show', 'main:feature.txt'])).trim())
      .toBe('ready to publish');

    await expect(service.publishBranch(repository, prepared.branchName, 'main'))
      .resolves.toEqual({ baseBranch: 'main' });

    await expect(service.removeTaskBranch(repository, prepared.branchName, 'main')).resolves.toBe(true);
    expect(await gitExitCode(runner, repository, [
      'show-ref', '--verify', '--quiet', `refs/heads/${prepared.branchName}`
    ])).toBe(1);
    await expect(service.removeTaskBranch(repository, prepared.branchName, 'main')).resolves.toBe(false);
  });

  it('cherry-picks only the selected task commit from a shared Feature branch and pushes main', async () => {
    const { repository, runner } = await temporaryRepository();
    const remote = await mkdtemp(path.join(tmpdir(), 'orchestrator-feature-remote-'));
    temporaryPaths.push(remote);
    await git(runner, remote, ['init', '--bare']);
    await git(runner, repository, ['remote', 'add', 'origin', remote]);
    const service = new GitService(runner);
    const firstTask = {
      ...exampleTask(),
      feature_id: 1,
      branch_name: 'feature/authentication',
      base_branch: 'main'
    };

    const firstRun = await service.prepareBranch(firstTask, repository);
    await writeFile(path.join(repository, 'feature.txt'), 'first task\n');
    await service.completeBranch(firstRun, firstTask.id, 'feat: start authentication.');

    await writeFile(path.join(repository, 'main-only.txt'), 'new main work\n');
    await git(runner, repository, ['add', 'main-only.txt']);
    await git(runner, repository, [
      '-c', 'user.name=Test User',
      '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'feat: advance main'
    ]);

    const secondRun = await service.prepareBranch({ ...firstTask, id: 102 }, repository);
    expect((await readFile(path.join(repository, 'feature.txt'), 'utf8')).trim()).toBe('first task');
    await writeFile(path.join(repository, 'second.txt'), 'second task\n');
    await service.completeBranch(secondRun, 102, 'feat: finish authentication.');
    await expect(service.publishFeatureTask(
      repository, 'feature/authentication', 'main', null, 'feat: finish authentication.',
    ))
      .resolves.toEqual({ baseBranch: 'main' });

    expect((await git(runner, repository, ['branch', '--show-current'])).trim()).toBe('main');
    expect(await gitExitCode(runner, repository, ['cat-file', '-e', 'main:feature.txt'])).toBe(128);
    expect((await git(runner, repository, ['show', 'main:second.txt'])).trim()).toBe('second task');
    expect((await git(runner, repository, [
      '--git-dir', remote, 'show', 'main:second.txt'
    ])).trim()).toBe('second task');
    expect(await gitExitCode(runner, repository, [
      '--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/feature/authentication'
    ])).toBe(1);
    expect((await git(runner, repository, ['show', 'main:main-only.txt'])).trim()).toBe('new main work');

    await expect(service.publishFeatureTask(
      repository, 'feature/authentication', 'main', null, 'feat: finish authentication.',
    )).resolves.toEqual({ baseBranch: 'main' });
  }, 20_000);

  it('refuses to remove an unmerged task branch', async () => {
    const { repository, runner } = await temporaryRepository();
    const service = new GitService(runner);
    const task = exampleTask();
    const prepared = await service.prepareBranch(task, repository);
    await writeFile(path.join(repository, 'unmerged.txt'), 'not published\n');
    await service.completeBranch(prepared, task.id, 'feat: add an unpublished change.');

    await expect(service.removeTaskBranch(repository, prepared.branchName, 'main'))
      .rejects.toThrow('is not fully merged');
    expect(await gitExitCode(runner, repository, [
      'show-ref', '--verify', '--quiet', `refs/heads/${prepared.branchName}`
    ])).toBe(0);

    await expect(service.removeTaskBranch(repository, prepared.branchName, 'main', true))
      .resolves.toBe(true);
    expect(await gitExitCode(runner, repository, [
      'show-ref', '--verify', '--quiet', `refs/heads/${prepared.branchName}`
    ])).toBe(1);
  });

  it('aborts a conflicting task cherry-pick on main and resolves it on a temporary branch', async () => {
    const { repository, runner } = await temporaryRepository();
    const remote = await mkdtemp(path.join(tmpdir(), 'orchestrator-conflict-remote-'));
    temporaryPaths.push(remote);
    await git(runner, remote, ['init', '--bare']);
    await git(runner, repository, ['remote', 'add', 'origin', remote]);
    const service = new GitService(runner);
    const task = { ...exampleTask(), branch_name: 'feature/conflict', base_branch: 'main' };

    const prepared = await service.prepareBranch(task, repository);
    await writeFile(path.join(repository, 'README.md'), 'feature version\n');
    await service.completeBranch(prepared, task.id, 'feat: change README on feature.');
    await writeFile(path.join(repository, 'README.md'), 'main version\n');
    await git(runner, repository, ['add', 'README.md']);
    await git(runner, repository, [
      '-c', 'user.name=Test User',
      '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'feat: change README on main'
    ]);

    await expect(service.publishFeatureTask(
      repository, 'feature/conflict', 'main', null, 'feat: change README on feature.',
    )).rejects.toBeInstanceOf(CherryPickConflictError);
    expect((await git(runner, repository, ['branch', '--show-current'])).trim()).toBe('main');
    expect((await readFile(path.join(repository, 'README.md'), 'utf8')).trim()).toBe('main version');
    expect(await gitExitCode(runner, repository, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'])).toBe(128);
    expect(await gitExitCode(runner, repository, [
      '--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/main'
    ])).toBe(1);

    const resolutionTask: Task = {
      ...task,
      commit_summary: 'feat: change README on feature.',
      agent_mode: 'cherry_pick_resolution',
    };
    const resolution = await service.prepareCherryPickResolution(resolutionTask, repository);
    expect(resolution.branchName).toBe(`agent/${task.id}-cherry-pick-resolution`);
    await expect(service.beginFeatureCherryPick(repository, resolution.sourceCommitSha)).resolves.toBe(false);
    await writeFile(path.join(repository, 'README.md'), 'resolved version\n');
    await expect(service.continueFeatureCherryPick(repository)).resolves.toBe(true);
    expect((await git(runner, repository, ['branch', '--show-current'])).trim()).toBe(resolution.branchName);
    expect((await readFile(path.join(repository, 'README.md'), 'utf8')).trim()).toBe('resolved version');
    const resolvedSha = await service.currentCommit(repository);
    await service.completeBranch(resolution, task.id);
    await expect(service.publishFeatureTask(
      repository, 'feature/conflict', 'main', resolvedSha, resolutionTask.commit_summary, task.id,
    )).resolves.toEqual({ baseBranch: 'main' });
    expect((await readFile(path.join(repository, 'README.md'), 'utf8')).trim()).toBe('resolved version');
    expect(await gitExitCode(runner, repository, [
      'show-ref', '--verify', '--quiet', `refs/heads/${resolution.branchName}`,
    ])).toBe(1);
  }, 20_000);

  it('turns unsafe or non-ASCII-only titles into safe deterministic slugs', () => {
    expect(slugifyTaskTitle('../../ Login API; rm -rf')).toBe('login-api-rm-rf');
    expect(slugifyTaskTitle('登入功能')).toBe('task');
  });
});

async function temporaryRepository(): Promise<{ repository: string; runner: ProcessRunner }> {
  const repository = await mkdtemp(path.join(tmpdir(), 'orchestrator-git-'));
  temporaryPaths.push(repository);
  const runner = new ProcessRunner();
  await git(runner, repository, ['init', '-b', 'main']);
  await writeFile(path.join(repository, 'README.md'), 'main\n');
  await git(runner, repository, ['add', 'README.md']);
  await git(runner, repository, [
    '-c', 'user.name=Test User',
    '-c', 'user.email=test@example.invalid',
    'commit', '-m', 'initial'
  ]);
  return { repository, runner };
}

async function realRepositoryPath(runner: ProcessRunner, repository: string): Promise<string> {
  return path.resolve((await git(runner, repository, ['rev-parse', '--show-toplevel'])).trim());
}

async function git(runner: ProcessRunner, cwd: string, args: readonly string[]): Promise<string> {
  const result = await runner.run({ command: 'git', args, cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

async function gitExitCode(runner: ProcessRunner, cwd: string, args: readonly string[]): Promise<number> {
  return (await runner.run({ command: 'git', args, cwd, timeoutMs: 10_000 })).exitCode;
}

function exampleTask(): Task {
  return {
    id: 101,
    project_id: 1,
    title: '../../ Login API; rm -rf',
    description: '',
    status: 'CLAIMED',
    priority: 'HIGH',
    model_effort: 'medium',
    agent_mode: 'implementation',
    retry_prompt: null,
    branch_name: null,
    worktree_path: null,
    base_branch: null,
    commit_summary: null,
    publish_commit_sha: null,
    source_task_id: null,
    is_rejected: false,
    is_paused: false,
    created_at: '2026-08-29T00:00:00.000Z',
    updated_at: '2026-08-29T00:00:00.000Z'
  };
}
