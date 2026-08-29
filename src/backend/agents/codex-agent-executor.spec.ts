import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProcessResult, Task } from '../domain/types.js';
import type { ProcessRunOptions, ProcessRunnerLike } from '../infra/process-runner.js';
import {
  CodexAgentExecutor,
  buildCodexPrompt,
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
    const executor = new CodexAgentExecutor(runner);
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
      'exec',
      '--ephemeral',
      '--json',
      '--color',
      'never',
      '-'
    ]);
    expect(runner.lastOptions?.stdin).toBe(buildCodexPrompt(task));
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

  it('checks CLI authentication without running an agent', async () => {
    const runner = new RecordingRunner(successResult('Logged in using ChatGPT'));
    const executor = new CodexAgentExecutor(runner);

    await expect(executor.checkAvailability()).resolves.toEqual({
      available: true,
      message: 'Logged in using ChatGPT'
    });
    expect(runner.lastOptions?.args).toEqual(['login', 'status']);
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
    branch_name: 'agent/101-add-login-api',
    worktree_path: null,
    created_at: '2026-08-29T00:00:00.000Z',
    updated_at: '2026-08-29T00:00:00.000Z'
  };
}
