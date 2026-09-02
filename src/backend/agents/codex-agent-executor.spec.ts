import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProcessResult, Task } from '../domain/types.js';
import type { ProcessRunOptions, ProcessRunnerLike } from '../infra/process-runner.js';
import {
  CodexAgentExecutor,
  buildCodexPrompt,
  normalizeWindowsVerificationShellFailure,
  summarizeCodexResult
} from './codex-agent-executor.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(async (entry) => await rm(entry, { recursive: true, force: true })));
});

describe('CodexAgentExecutor', () => {
  it('uses the exact noninteractive safe argv and sends the prompt on stdin', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'orchestrator-codex-'));
    temporaryPaths.push(workspace);
    const runner = new RecordingRunner(successResult());
    const executor = new CodexAgentExecutor(runner, { command: 'codex' });
    const task = exampleTask();

    await executor.execute(task, workspace);

    expect(runner.lastOptions?.command).toBe('codex');
    expect(runner.lastOptions?.cwd).toBe(path.resolve(workspace));
    expect(runner.lastOptions?.args).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      '--cd',
      path.resolve(workspace),
      '--config',
      'model_reasoning_effort="medium"',
      'exec',
      '--ephemeral',
      '--json',
      '--color',
      'never',
      '-'
    ]);
    expect(runner.lastOptions?.stdin).toBe(buildCodexPrompt(task));
    expect(runner.lastOptions?.stdin).toContain(
      'use the `write-worklog` skill before finishing.\n' +
      'Return the canonical summary produced by the skill so the orchestrator can use it as the Git commit message.'
    );
    expect(runner.lastOptions?.timeoutMs).toBe(1_800_000);
  });

  it('extracts the final agent message from JSONL', () => {
    const result = successResult(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Implemented the feature.' }
        })
      ].join('\n')
    );

    expect(summarizeCodexResult(result)).toBe('Implemented the feature.');
  });

  it('accepts a completed file change when only Microsoft Store pwsh verification is denied', () => {
    const result: ProcessResult = {
      exitCode: 1,
      stdout: [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'file_change', status: 'completed', changes: [{ path: 'hello.txt' }] }
        }),
        JSON.stringify({ type: 'turn.completed' })
      ].join('\n'),
      stderr: 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.5.0_x64__8wekyb3d8bbwe\\pwsh.exe: CreateProcessAsUserW failed: 5 (Access denied)',
      timedOut: false,
      aborted: false
    };

    expect(normalizeWindowsVerificationShellFailure(result).exitCode).toBe(0);
  });

  it('does not hide a failed Codex turn even after a completed file change', () => {
    const result: ProcessResult = {
      exitCode: 1,
      stdout: [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'file_change', status: 'completed', changes: [{ path: 'hello.txt' }] }
        }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'Agent failed.' } })
      ].join('\n'),
      stderr: 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.5.0_x64__8wekyb3d8bbwe\\pwsh.exe: CreateProcessAsUserW failed: 5 (Access denied)',
      timedOut: false,
      aborted: false
    };

    expect(normalizeWindowsVerificationShellFailure(result).exitCode).toBe(1);
  });

  it('checks CLI authentication without running an agent', async () => {
    const runner = new RecordingRunner(successResult('Logged in using ChatGPT'));
    const executor = new CodexAgentExecutor(runner, { command: 'codex' });

    await expect(executor.checkAvailability()).resolves.toEqual({
      available: true,
      message: 'Logged in using ChatGPT'
    });
    expect(runner.lastOptions?.args).toEqual(['login', 'status']);
  });

  it('resolves the CLI path again after an in-place Codex update', async () => {
    const runner = new RecordingRunner(successResult('Logged in using ChatGPT'));
    const commands = ['C:\\Codex\\old\\codex.exe', 'C:\\Codex\\new\\codex.exe'];
    const executor = new CodexAgentExecutor(runner, {
      commandResolver: async () => commands.shift() ?? 'codex'
    });

    await executor.checkAvailability();
    expect(runner.lastOptions?.command).toBe('C:\\Codex\\old\\codex.exe');

    await executor.checkAvailability();
    expect(runner.lastOptions?.command).toBe('C:\\Codex\\new\\codex.exe');
  });
});

class RecordingRunner implements ProcessRunnerLike {
  public lastOptions: ProcessRunOptions | undefined;

  public constructor(private readonly result: ProcessResult) {}

  public async run(options: ProcessRunOptions): Promise<ProcessResult> {
    this.lastOptions = options;
    return this.result;
  }
}

function successResult(stdout = ''): ProcessResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    timedOut: false,
    aborted: false
  };
}

function exampleTask(): Task {
  return {
    id: 101,
    project_id: 1,
    title: 'Add login API',
    description: 'Create the endpoint and tests.',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    model_effort: 'medium',
    branch_name: 'agent/101-add-login-api',
    worktree_path: null,
    base_branch: 'main',
    commit_summary: null,
    is_paused: false,
    created_at: '2026-08-29T00:00:00.000Z',
    updated_at: '2026-08-29T00:00:00.000Z'
  };
}
