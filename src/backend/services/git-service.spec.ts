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
  it('creates and idempotently reuses a task worktree without switching main', async () => {
    const repository = await mkdtemp(path.join(tmpdir(), 'orchestrator-git-'));
    temporaryPaths.push(repository);
    const runner = new ProcessRunner();
    await git(runner, repository, ['init', '-b', 'main']);
    await git(runner, repository, ['config', 'user.name', 'Test User']);
    await git(runner, repository, ['config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(repository, 'README.md'), 'main\n');
    await git(runner, repository, ['add', 'README.md']);
    await git(runner, repository, ['commit', '-m', 'initial']);
    const originalHead = (await git(runner, repository, ['rev-parse', 'HEAD'])).trim();
    const service = new GitService(runner);
    const task = exampleTask();

    const prepared = await service.prepareWorktree(task, repository);
    const reused = await service.prepareWorktree(
      { ...task, branch_name: prepared.branchName, worktree_path: prepared.worktreePath },
      repository
    );

    expect(prepared).toEqual(reused);
    expect(prepared.branchName).toBe('agent/101-login-api-rm-rf');
    expect((await git(runner, prepared.worktreePath, ['branch', '--show-current'])).trim()).toBe(
      prepared.branchName
    );
    expect((await git(runner, repository, ['branch', '--show-current'])).trim()).toBe('main');
    expect((await git(runner, repository, ['rev-parse', 'HEAD'])).trim()).toBe(originalHead);
    expect(await readFile(path.join(repository, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '/.worktrees/'
    );
  });

  it('turns unsafe or non-ASCII-only titles into safe deterministic slugs', () => {
    expect(slugifyTaskTitle('../../ Login API; rm -rf')).toBe('login-api-rm-rf');
    expect(slugifyTaskTitle('登入功能')).toBe('task');
  });
});

async function git(
  runner: ProcessRunner,
  cwd: string,
  args: readonly string[]
): Promise<string> {
  const result = await runner.run({ command: 'git', args, cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
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
    created_at: '2026-08-29T00:00:00.000Z',
    updated_at: '2026-08-29T00:00:00.000Z'
  };
}
