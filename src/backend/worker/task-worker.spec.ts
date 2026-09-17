import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentExecutor } from '../agents/agent-executor.js';
import { OrchestratorDatabase } from '../database/database.js';
import { FeatureRepository } from '../database/feature-repository.js';
import { ProjectRepository } from '../database/project-repository.js';
import { TaskRepository } from '../database/task-repository.js';
import { TaskRunRepository } from '../database/task-run-repository.js';
import type {
  AgentExecutionResult,
  Project,
  Task,
  TestExecutionResult
} from '../domain/types.js';
import type { GitService, PreparedBranch } from '../services/git-service.js';
import type { TestService } from '../services/test-service.js';
import { TaskWorker, type TaskWorkerOptions } from './task-worker.js';

describe('TaskWorker', () => {
  let database: OrchestratorDatabase;
  let projects: ProjectRepository;
  let runs: TaskRunRepository;
  let tasks: TaskRepository;
  let project: Project;

  beforeEach(() => {
    database = new OrchestratorDatabase(':memory:');
    projects = new ProjectRepository(database);
    runs = new TaskRunRepository(database);
    tasks = new TaskRepository(database, runs);
    project = projects.create({
      name: 'Example',
      repository_path: path.resolve('example-repository'),
      context: 'Follow the project conventions.'
    });
  });

  afterEach(() => {
    database.close();
  });

  it('runs the isolated pipeline and stops at IN_REVIEW rather than DONE', async () => {
    const task = createTask('Implement search');
    const prepareBranch = vi.fn(async (claimed: Task): Promise<PreparedBranch> => ({
      branchName: `agent/${claimed.id}-implement-search`,
      workspacePath: project.repository_path,
      originalBranch: 'main',
      startingCommitSha: 'starting-commit-sha'
    }));
    const executeAgent = vi.fn(async (agentTask: Task): Promise<AgentExecutionResult> => {
      expect(agentTask.status).toBe('IN_PROGRESS');
      expect(agentTask.branch_name).toBe(`agent/${task.id}-implement-search`);
      expect(tasks.findById(task.id)?.status).toBe('IN_PROGRESS');
      return successfulAgent('Implemented search and updated its tests.');
    });
    const executeTests = vi.fn(async (): Promise<TestExecutionResult> => {
      expect(tasks.findById(task.id)?.status).toBe('TESTING');
      return successfulTests();
    });
    const { worker, completeBranch } = createWorker(prepareBranch, executeAgent, executeTests);

    await expect(worker.processNext()).resolves.toBe(true);

    const completed = tasks.findById(task.id);
    expect(completed).toMatchObject({
      status: 'IN_REVIEW',
      branch_name: `agent/${task.id}-implement-search`,
      worktree_path: project.repository_path
    });
    expect(completed?.status).not.toBe('DONE');
    expect(prepareBranch).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id, status: 'CLAIMED' }),
      project.repository_path,
      expect.any(AbortSignal)
    );
    expect(executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: task.id,
        project: expect.objectContaining({ id: project.id, context: project.context })
      }),
      project.repository_path,
      expect.any(AbortSignal)
    );
    expect(executeTests).toHaveBeenCalledOnce();
    expect(completeBranch).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: `agent/${task.id}-implement-search` }),
      task.id,
      'Implemented search and updated its tests.'
    );
    expect(completed?.base_branch).toBe('main');
    expect(completed?.commit_summary).toBe('Implemented search and updated its tests.');

    const taskRuns = runs.listForTask(task.id);
    expect(taskRuns).toHaveLength(1);
    expect(taskRuns[0]).toMatchObject({
      exit_code: 0,
      result_summary: 'Implemented search and updated its tests.'
    });
    expect(taskRuns[0]?.finished_at).not.toBeNull();
    expect(taskRuns[0]?.stdout).toContain('[git] Checking out managed delivery branch...');
    expect(taskRuns[0]?.stdout).toContain('[git] Checkpointed');
    expect(taskRuns[0]?.stdout).toContain('[agent]\nAgent stdout');
    expect(taskRuns[0]?.stdout).toContain('[test] pnpm test\nTest stdout');
    expect(taskRuns[0]?.file_diff).toContain('1 file changed');
    expect(taskRuns[0]?.code_diff).toContain('diff --git a/search.ts b/search.ts');
    expect(worker.getStatus()).toMatchObject({ busy: false, activeTaskId: null });
  });

  it('lets Codex resolve a controlled Feature cherry-pick conflict before testing', async () => {
    const task = createTask('Resolve cherry-pick conflicts');
    expect(tasks.transition(task.id, 'TODO', 'CHERRY_PICK_CONFLICT')).not.toBeNull();
    expect(tasks.queueCherryPickResolution(task.id, 'high')).toMatchObject({ agent_mode: 'cherry_pick_resolution' });
    const prepareBranch = vi.fn(async (): Promise<PreparedBranch> => ({
      branchName: 'feature/conflicted', workspacePath: project.repository_path, originalBranch: 'main',
      startingCommitSha: 'starting-commit-sha',
    }));
    const executeAgent = vi.fn(async () => successfulAgent('Resolve Feature cherry-pick conflicts.'));
    const { worker, beginFeatureCherryPick, continueFeatureCherryPick, abortFeatureCherryPick } = createWorker(
      prepareBranch,
      executeAgent,
      async () => successfulTests(),
    );
    beginFeatureCherryPick.mockResolvedValueOnce(false);
    continueFeatureCherryPick.mockResolvedValueOnce(true);

    await expect(worker.processNext()).resolves.toBe(true);

    expect(beginFeatureCherryPick).toHaveBeenCalledWith(
      project.repository_path, 'source-commit-sha', expect.any(AbortSignal),
    );
    expect(executeAgent).toHaveBeenCalledTimes(1);
    expect(continueFeatureCherryPick).toHaveBeenCalledTimes(1);
    expect(abortFeatureCherryPick).not.toHaveBeenCalled();
    expect(tasks.findById(task.id)).toMatchObject({
      status: 'IN_REVIEW', agent_mode: 'implementation', publish_commit_sha: 'resolved-commit-sha',
    });
  });

  it('marks an agent failure FAILED and can immediately process the next TODO task', async () => {
    const first = createTask('First task');
    const second = createTask('Second task');
    const agentResults = [
      failedAgent(23, 'Agent failed to edit the project.'),
      successfulAgent('Second task completed.')
    ];
    const prepareBranch = vi.fn(async (task: Task): Promise<PreparedBranch> => ({
      branchName: `agent/${task.id}-task`,
      workspacePath: project.repository_path,
      originalBranch: 'main',
      startingCommitSha: 'starting-commit-sha'
    }));
    const executeAgent = vi.fn(async (): Promise<AgentExecutionResult> => {
      const result = agentResults.shift();
      if (result === undefined) {
        throw new Error('Unexpected agent invocation.');
      }
      return result;
    });
    const executeTests = vi.fn(async (): Promise<TestExecutionResult> => successfulTests());
    const { worker, completeBranch } = createWorker(prepareBranch, executeAgent, executeTests);

    await expect(worker.processNext()).resolves.toBe(true);
    expect(tasks.findById(first.id)?.status).toBe('FAILED');
    expect(tasks.findById(second.id)?.status).toBe('TODO');
    expect(runs.listForTask(first.id)[0]).toMatchObject({
      exit_code: 23,
      result_summary: 'Codex execution failed.'
    });
    expect(runs.listForTask(first.id)[0]?.stderr).toContain('Agent failed to edit the project.');
    expect(executeTests).not.toHaveBeenCalled();

    await expect(worker.processNext()).resolves.toBe(true);
    expect(tasks.findById(second.id)?.status).toBe('IN_REVIEW');
    expect(tasks.findById(second.id)?.status).not.toBe('DONE');
    expect(executeAgent).toHaveBeenCalledTimes(2);
    expect(executeTests).toHaveBeenCalledOnce();
    expect(completeBranch).toHaveBeenCalledTimes(2);
  });

  it('marks a task FAILED when project tests fail and persists test output', async () => {
    const task = createTask('Break a test');
    const prepareBranch = vi.fn(async (claimed: Task): Promise<PreparedBranch> => ({
      branchName: `agent/${claimed.id}-break-a-test`,
      workspacePath: project.repository_path,
      originalBranch: 'main',
      startingCommitSha: 'starting-commit-sha'
    }));
    const executeAgent = vi.fn(async (): Promise<AgentExecutionResult> => successfulAgent());
    const executeTests = vi.fn(async (): Promise<TestExecutionResult> => ({
      exitCode: 7,
      stdout: '2 tests passed, 1 failed\n',
      stderr: 'AssertionError: expected true to be false\n',
      timedOut: false,
      aborted: false,
      executed: true,
      verificationKind: 'test',
      summary: 'Unit tests failed.',
      commandDescription: 'pnpm test'
    }));
    const { worker, completeBranch } = createWorker(prepareBranch, executeAgent, executeTests);

    await expect(worker.processNext()).resolves.toBe(true);

    expect(tasks.findById(task.id)?.status).toBe('FAILED');
    const run = runs.listForTask(task.id)[0];
    expect(run).toMatchObject({ exit_code: 7, result_summary: 'Unit tests failed.' });
    expect(run?.stdout).toContain('[test] pnpm test\n2 tests passed, 1 failed');
    expect(run?.stderr).toContain('[test]\nAssertionError: expected true to be false');
    expect(run?.stderr).toContain('[orchestrator] Unit tests failed.');
    expect(completeBranch).toHaveBeenCalledOnce();
  });

  it('retains the checkpoint SHA when a Feature attempt fails after changing files', async () => {
    const feature = new FeatureRepository(database).create(
      { project_id: project.id, name: 'Migrations' }, 'feature/migrations', 'main',
    );
    const task = tasks.create({
      project_id: project.id, feature_id: feature.id, title: 'Add migration',
      description: '', priority: 'MEDIUM',
    });
    const prepareBranch = vi.fn(async (): Promise<PreparedBranch> => ({
      branchName: 'feature/migrations', workspacePath: project.repository_path,
      originalBranch: 'main', startingCommitSha: 'starting-commit-sha',
    }));
    const executeAgent = vi.fn(async (): Promise<AgentExecutionResult> => ({
      ...successfulAgent(), exitCode: 1, summary: 'Agent stopped after writing a file.',
    }));
    const executeTests = vi.fn(async (): Promise<TestExecutionResult> => successfulTests());
    const { worker } = createWorker(prepareBranch, executeAgent, executeTests);

    await expect(worker.processNext()).resolves.toBe(true);
    expect(tasks.findById(task.id)).toMatchObject({
      status: 'FAILED', publish_commit_sha: 'task-commit-sha',
    });
  });

  it('moves an unverified task to IN_REVIEW with a visible warning', async () => {
    const task = createTask('Documentation-only change');
    const prepareBranch = vi.fn(async (claimed: Task): Promise<PreparedBranch> => ({
      branchName: `agent/${claimed.id}-documentation-only-change`,
      workspacePath: project.repository_path,
      originalBranch: 'main',
      startingCommitSha: 'starting-commit-sha'
    }));
    const executeAgent = vi.fn(async (): Promise<AgentExecutionResult> =>
      successfulAgent('Updated the documentation.'));
    const executeVerification = vi.fn(async (): Promise<TestExecutionResult> => ({
      exitCode: 0,
      stdout: 'UNVERIFIED: No supported test or build command was detected.\n',
      stderr: '',
      timedOut: false,
      aborted: false,
      executed: false,
      verificationKind: 'none',
      summary: 'UNVERIFIED: No supported test or build command was detected.',
      commandDescription: 'No verification command executed'
    }));
    const { worker } = createWorker(prepareBranch, executeAgent, executeVerification);

    await expect(worker.processNext()).resolves.toBe(true);

    expect(tasks.findById(task.id)?.status).toBe('IN_REVIEW');
    const run = runs.listForTask(task.id)[0];
    expect(run).toMatchObject({ exit_code: 0 });
    expect(run?.result_summary).toContain('UNVERIFIED');
    expect(run?.stdout).toContain('[verification] No verification command executed');
  });

  it('does not claim a TODO task while the configured agent is unavailable', async () => {
    const task = createTask('Wait for Codex');
    const checkAvailability = vi.fn(async () => ({
      available: false,
      message: 'Codex CLI is not available.'
    }));
    const execute = vi.fn(async (): Promise<AgentExecutionResult> => successfulAgent());
    const agent: AgentExecutor = { checkAvailability, execute };
    const git = {
      prepareBranch: vi.fn(),
      completeBranch: vi.fn()
    } as unknown as GitService;
    const tests = {
      execute: vi.fn()
    } as unknown as TestService;
    const worker = new TaskWorker(tasks, runs, git, agent, tests);

    await expect(worker.processNext()).resolves.toBe(false);

    expect(tasks.findById(task.id)?.status).toBe('TODO');
    expect(runs.listForTask(task.id)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(worker.getStatus()).toMatchObject({
      agentAvailable: false,
      message: 'Codex CLI is not available.'
    });
  });

  it('pauses new task claims and resumes processing without cancelling active work', async () => {
    const task = createTask('Wait for resume');
    const checkAvailability = vi.fn(async () => ({ available: true, message: 'Codex CLI is available.' }));
    const prepareBranch = vi.fn(async (claimed: Task): Promise<PreparedBranch> => ({
      branchName: `agent/${claimed.id}-wait-for-resume`,
      workspacePath: project.repository_path,
      originalBranch: 'main',
      startingCommitSha: 'starting-commit-sha'
    }));
    const execute = vi.fn(async (): Promise<AgentExecutionResult> => successfulAgent());
    const git = {
      prepareBranch,
      completeBranch: vi.fn(async () => true),
      captureRunDiff: vi.fn(async () => ({ fileDiff: '', codeDiff: '' })),
    } as unknown as GitService;
    const agent: AgentExecutor = { checkAvailability, execute };
    const tests = { execute: vi.fn(async () => successfulTests()) } as unknown as TestService;
    const worker = new TaskWorker(tasks, runs, git, agent, tests);

    expect(worker.pause()).toMatchObject({ paused: true, busy: false });
    await expect(worker.processNext()).resolves.toBe(false);
    expect(tasks.findById(task.id)?.status).toBe('TODO');
    expect(checkAvailability).not.toHaveBeenCalled();

    expect(worker.resume()).toMatchObject({ paused: false });
    await expect(worker.processNext()).resolves.toBe(true);
    expect(tasks.findById(task.id)?.status).toBe('IN_REVIEW');
  });

  it('processes only the Todo batch present when Play is pressed and pauses afterward', async () => {
    const first = createTask('Current task');
    const second = createTask('Another current task');
    const prepare = vi.fn(async (claimed: Task): Promise<PreparedBranch> => ({
      branchName: `agent/${claimed.id}-task`, workspacePath: project.repository_path,
      originalBranch: 'main', startingCommitSha: 'start',
    }));
    const { worker } = createWorker(prepare, async () => successfulAgent(), async () => successfulTests());

    worker.pause();
    expect(worker.resume()).toMatchObject({ paused: false });
    const later = createTask('Added after Play');

    await expect(worker.processNext()).resolves.toBe(true);
    expect(tasks.findById(first.id)?.status).toBe('IN_REVIEW');
    expect(tasks.findById(second.id)?.status).toBe('TODO');
    expect(tasks.findById(later.id)?.status).toBe('TODO');
    expect(worker.getStatus()).toMatchObject({ paused: false, autoPaused: false });
    await expect(worker.processNext()).resolves.toBe(true);
    expect(tasks.findById(second.id)?.status).toBe('IN_REVIEW');
    expect(worker.getStatus()).toMatchObject({ paused: true, autoPaused: true });
    await expect(worker.processNext()).resolves.toBe(false);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('waits for an exhausted Codex window and resumes the current batch after its reset', async () => {
    const task = createTask('Wait for quota');
    let now = 1_800_000_000_000;
    let remainingPercent = 0;
    const read = vi.fn(async () => ({
      available: true, planType: 'plus', secondary: null, resetCredits: 0,
      checkedAt: new Date(now).toISOString(), message: 'Codex usage is available.',
      primary: { remainingPercent, usedPercent: 100 - remainingPercent,
        windowDurationMins: 300, resetsAt: (now + 120_000) / 1_000 },
    }));
    const prepare = vi.fn(async (claimed: Task): Promise<PreparedBranch> => ({
      branchName: `agent/${claimed.id}-task`, workspacePath: project.repository_path,
      originalBranch: 'main', startingCommitSha: 'start',
    }));
    const { worker } = createWorker(prepare, async () => successfulAgent(), async () => successfulTests(), {
      usage: { read }, clock: () => now,
    });
    worker.setQuotaLoopEnabled(true);
    worker.resume();

    await expect(worker.processNext()).resolves.toBe(false);
    expect(tasks.findById(task.id)?.status).toBe('TODO');
    expect(worker.getStatus()).toMatchObject({ quotaLoopEnabled: true, quotaWaitingUntil: now + 120_000 });
    now += 60_000;
    await expect(worker.processNext()).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    now += 60_000;
    remainingPercent = 100;
    await expect(worker.processNext()).resolves.toBe(true);
    expect(tasks.findById(task.id)?.status).toBe('IN_REVIEW');
    expect(worker.getStatus()).toMatchObject({ paused: true, autoPaused: true, quotaWaitingUntil: null });
  });

  it('requeues a Codex quota error instead of marking the task Failed', async () => {
    const task = createTask('Continue after quota refresh');
    const prepare = vi.fn(async (claimed: Task): Promise<PreparedBranch> => ({
      branchName: `agent/${claimed.id}-task`, workspacePath: project.repository_path,
      originalBranch: 'main', startingCommitSha: 'start',
    }));
    const read = vi.fn(async () => ({
      available: true, planType: 'plus', secondary: null, resetCredits: 0,
      checkedAt: new Date().toISOString(), message: 'Codex usage exhausted.',
      primary: { remainingPercent: 0, usedPercent: 100, windowDurationMins: 300, resetsAt: 1_900_000_000 },
    }));
    const usage = { read };
    const { worker } = createWorker(prepare, async () => ({
      ...successfulAgent(), exitCode: 1, stderr: 'rate_limit_exceeded: try later', summary: 'Usage limit reached.',
    }), async () => successfulTests(), { usage });
    worker.setQuotaLoopEnabled(true);
    worker.resume();

    // The first read must allow a claim; the forced read after failure reports exhaustion.
    read.mockResolvedValueOnce({
      available: true, planType: 'plus', secondary: null, resetCredits: 0,
      checkedAt: new Date().toISOString(), message: 'Codex usage is available.',
      primary: { remainingPercent: 10, usedPercent: 90, windowDurationMins: 300, resetsAt: 1_900_000_000 },
    });
    await expect(worker.processNext()).resolves.toBe(true);
    expect(tasks.findById(task.id)?.status).toBe('TODO');
    expect(runs.listForTask(task.id)[0]?.result_summary).toContain('usage limit reached');
    expect(worker.getStatus().quotaWaitingUntil).not.toBeNull();
    expect(worker.getStatus().paused).toBe(false);
  });

  it('cancels the active task and waits for its pipeline to finish', async () => {
    const task = createTask('Cancel active task');
    const prepareBranch = vi.fn(async (claimed: Task): Promise<PreparedBranch> => ({
      branchName: `agent/${claimed.id}-cancel-active-task`,
      workspacePath: project.repository_path,
      originalBranch: 'main',
      startingCommitSha: 'starting-commit-sha'
    }));
    const executeAgent = vi.fn(async (
      _task: Task,
      _workspace: string,
      signal: AbortSignal
    ): Promise<AgentExecutionResult> => await new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({
        exitCode: 130,
        stdout: '',
        stderr: 'Cancelled by user.\n',
        timedOut: false,
        aborted: true,
        summary: 'Task cancelled.'
      }), { once: true });
    }));
    const { worker } = createWorker(prepareBranch, executeAgent, async () => successfulTests());

    const processing = worker.processNext();
    await vi.waitFor(() => expect(worker.getStatus()).toMatchObject({
      busy: true, activeTaskId: task.id
    }));

    await expect(worker.cancelTask(task.id + 1)).resolves.toBe(false);
    await expect(worker.cancelTask(task.id)).resolves.toBe(true);
    await expect(processing).resolves.toBe(true);
    expect(tasks.findById(task.id)?.status).toBe('FAILED');
    expect(worker.getStatus()).toMatchObject({ busy: false, activeTaskId: null });
  });

  it('returns an active task to runnable TODO during application shutdown', async () => {
    const task = createTask('Continue after restart');
    const prepareBranch = vi.fn(async (claimed: Task): Promise<PreparedBranch> => ({
      branchName: `feature/${claimed.id}-continue-after-restart`,
      workspacePath: project.repository_path,
      originalBranch: 'main',
      startingCommitSha: 'starting-commit-sha'
    }));
    const executeAgent = vi.fn(async (
      _task: Task,
      _workspace: string,
      signal: AbortSignal
    ): Promise<AgentExecutionResult> => await new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({
        exitCode: 130,
        stdout: 'Partial work remains on the branch.\n',
        stderr: '',
        timedOut: false,
        aborted: true,
        summary: 'Task interrupted.'
      }), { once: true });
    }));
    const { worker } = createWorker(prepareBranch, executeAgent, async () => successfulTests());

    worker.start();
    await vi.waitFor(() => expect(worker.getStatus()).toMatchObject({
      busy: true, activeTaskId: task.id
    }));
    await worker.stop();

    expect(tasks.findById(task.id)).toMatchObject({ status: 'TODO', is_paused: false });
    expect(runs.listForTask(task.id)[0]).toMatchObject({
      exit_code: 130,
      result_summary: 'Application stopped; task returned to TODO.'
    });
    expect(runs.listForTask(task.id)[0]?.stderr).toContain('task returned to TODO');
  });

  function createTask(title: string): Task {
    return tasks.create({
      project_id: project.id,
      title,
      description: `${title} description`,
      priority: 'MEDIUM'
    });
  }

  function createWorker(
    prepareBranch: (task: Task) => Promise<PreparedBranch>,
    executeAgent: (task: Task) => Promise<AgentExecutionResult>,
    executeTests: () => Promise<TestExecutionResult>,
    options: TaskWorkerOptions = {},
  ): {
    worker: TaskWorker;
    completeBranch: ReturnType<typeof vi.fn>;
    beginFeatureCherryPick: ReturnType<typeof vi.fn>;
    continueFeatureCherryPick: ReturnType<typeof vi.fn>;
    abortFeatureCherryPick: ReturnType<typeof vi.fn>;
  } {
    const completeBranch = vi.fn(async () => true);
    const captureRunDiff = vi.fn(async () => ({
      fileDiff: ' 1 file changed, 1 insertion(+)',
      codeDiff: 'diff --git a/search.ts b/search.ts',
    }));
    const prepareCherryPickResolution = vi.fn(async () => ({
      branchName: 'agent/1-cherry-pick-resolution', workspacePath: project.repository_path,
      originalBranch: 'main', startingCommitSha: 'starting-commit-sha', sourceCommitSha: 'source-commit-sha',
    }));
    const beginFeatureCherryPick = vi.fn(async () => true);
    const continueFeatureCherryPick = vi.fn(async () => true);
    const abortFeatureCherryPick = vi.fn(async () => undefined);
    const currentCommit = vi.fn(async () => 'resolved-commit-sha');
    const commitAtRef = vi.fn(async () => 'task-commit-sha');
    const git = {
      prepareBranch, prepareCherryPickResolution, completeBranch, beginFeatureCherryPick,
      continueFeatureCherryPick, abortFeatureCherryPick, currentCommit, commitAtRef, captureRunDiff,
    } as unknown as GitService;
    const agent: AgentExecutor = {
      checkAvailability: async () => ({ available: true, message: 'Codex CLI is available.' }),
      execute: executeAgent
    };
    const testService = { execute: executeTests } as unknown as TestService;
    return {
      worker: new TaskWorker(tasks, runs, git, agent, testService, { pollIntervalMs: 1, ...options }),
      completeBranch,
      beginFeatureCherryPick,
      continueFeatureCherryPick,
      abortFeatureCherryPick,
    };
  }
});

function successfulAgent(summary = 'Agent completed the task.'): AgentExecutionResult {
  return {
    exitCode: 0,
    stdout: 'Agent stdout\n',
    stderr: '',
    timedOut: false,
    aborted: false,
    summary
  };
}

function failedAgent(exitCode: number, stderr: string): AgentExecutionResult {
  return {
    exitCode,
    stdout: 'Partial agent output\n',
    stderr: `${stderr}\n`,
    timedOut: false,
    aborted: false,
    summary: stderr
  };
}

function successfulTests(): TestExecutionResult {
  return {
    exitCode: 0,
    stdout: 'Test stdout\n',
    stderr: '',
    timedOut: false,
    aborted: false,
    executed: true,
    verificationKind: 'test',
    summary: 'Tests passed.',
    commandDescription: 'pnpm test'
  };
}
