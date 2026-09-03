import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentExecutor } from '../agents/agent-executor.js';
import { OrchestratorDatabase } from '../database/database.js';
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
import { TaskWorker } from './task-worker.js';

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
      originalBranch: 'main'
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
    expect(taskRuns[0]?.stdout).toContain('[git] Checking out isolated task branch...');
    expect(taskRuns[0]?.stdout).toContain('[git] Checkpointed');
    expect(taskRuns[0]?.stdout).toContain('[agent]\nAgent stdout');
    expect(taskRuns[0]?.stdout).toContain('[test] pnpm test\nTest stdout');
    expect(worker.getStatus()).toMatchObject({ busy: false, activeTaskId: null });
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
      originalBranch: 'main'
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
      originalBranch: 'main'
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

  it('moves an unverified task to IN_REVIEW with a visible warning', async () => {
    const task = createTask('Documentation-only change');
    const prepareBranch = vi.fn(async (claimed: Task): Promise<PreparedBranch> => ({
      branchName: `agent/${claimed.id}-documentation-only-change`,
      workspacePath: project.repository_path,
      originalBranch: 'main'
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

  it('cancels the active task and waits for its pipeline to finish', async () => {
    const task = createTask('Cancel active task');
    const prepareBranch = vi.fn(async (claimed: Task): Promise<PreparedBranch> => ({
      branchName: `agent/${claimed.id}-cancel-active-task`,
      workspacePath: project.repository_path,
      originalBranch: 'main'
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
    executeTests: () => Promise<TestExecutionResult>
  ): { worker: TaskWorker; completeBranch: ReturnType<typeof vi.fn> } {
    const completeBranch = vi.fn(async () => true);
    const git = { prepareBranch, completeBranch } as unknown as GitService;
    const agent: AgentExecutor = {
      checkAvailability: async () => ({ available: true, message: 'Codex CLI is available.' }),
      execute: executeAgent
    };
    const testService = { execute: executeTests } as unknown as TestService;
    return {
      worker: new TaskWorker(tasks, runs, git, agent, testService, { pollIntervalMs: 1 }),
      completeBranch
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
