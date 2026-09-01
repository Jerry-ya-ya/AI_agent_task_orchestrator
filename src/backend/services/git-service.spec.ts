import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Task } from '../domain/types.js';
import { ProcessRunner } from '../infra/process-runner.js';
import { GitService, slugifyTaskTitle } from './git-service.js';

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
  });

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

function exampleTask(): Task {
  return {
    id: 101,
    project_id: 1,
    title: '../../ Login API; rm -rf',
    description: '',
    status: 'CLAIMED',
    priority: 'HIGH',
    branch_name: null,
    worktree_path: null,
    base_branch: null,
    commit_summary: null,
    is_paused: false,
    created_at: '2026-08-29T00:00:00.000Z',
    updated_at: '2026-08-29T00:00:00.000Z'
  };
}
