import type {
  AgentAvailability,
  AgentExecutionResult,
  ClaimedTask,
  Task,
  TestExecutionResult,
  WorkerStatus
} from '../domain/types.js';
import { TaskRepository } from '../database/task-repository.js';
import { TaskRunRepository } from '../database/task-run-repository.js';
import type { AgentExecutor } from '../agents/agent-executor.js';
import { GitService } from '../services/git-service.js';
import { TestService } from '../services/test-service.js';

export interface TaskWorkerOptions {
  pollIntervalMs?: number;
}

class PipelineFailure extends Error {
  public constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stdout = '',
    public readonly stderr = ''
  ) {
    super(message);
  }
}

export class TaskWorker {
  private running = false;
  private busy = false;
  private activeTaskId: number | null = null;
  private activeController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopRequested = false;
  private wakeIdle: (() => void) | null = null;
  private availability: AgentAvailability = {
    available: false,
    message: 'Codex availability has not been checked yet.'
  };
  private readonly pollIntervalMs: number;

  public constructor(
    private readonly tasks: TaskRepository,
    private readonly runs: TaskRunRepository,
    private readonly git: GitService,
    private readonly agent: AgentExecutor,
    private readonly tests: TestService,
    options: TaskWorkerOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.stopRequested = false;
    this.running = true;
    this.loopPromise = this.loop();
  }

  public async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;
    this.activeController?.abort();
    this.wakeIdle?.();
    await this.loopPromise;
    this.loopPromise = null;
  }

  public getStatus(): WorkerStatus {
    return {
      running: this.running,
      busy: this.busy,
      activeTaskId: this.activeTaskId,
      agentAvailable: this.availability.available,
      message: this.availability.message
    };
  }

  public async processNext(): Promise<boolean> {
    if (this.busy) {
      return false;
    }

    this.availability = await this.agent.checkAvailability();
    if (!this.availability.available || this.stopRequested) {
      return false;
    }

    const claimed = this.tasks.claimNext();
    if (claimed === null) {
      return false;
    }

    this.busy = true;
    this.activeTaskId = claimed.id;
    this.activeController = new AbortController();

    try {
      await this.executePipeline(claimed, this.activeController.signal);
    } finally {
      this.activeController = null;
      this.activeTaskId = null;
      this.busy = false;
    }
    return true;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.processNext();
        if (!processed && this.running) {
          await this.waitForNextPoll();
        }
      } catch (error) {
        console.error('[worker] Unexpected polling failure:', error);
        if (this.running) {
          await this.waitForNextPoll();
        }
      }
    }
  }

  private async executePipeline(claimed: ClaimedTask, signal: AbortSignal): Promise<void> {
    let exitCode = 1;
    let summary = 'Task pipeline failed.';

    try {
      this.runs.appendOutput(claimed.run_id, '[git] Preparing isolated branch and worktree...\n', '');
      const prepared = await this.git.prepareWorktree(claimed, claimed.project.repository_path, signal);
      const task = this.tasks.setArtifacts(claimed.id, prepared.branchName, prepared.worktreePath);
      if (task === null || this.tasks.transition(task.id, 'CLAIMED', 'IN_PROGRESS') === null) {
        throw new PipelineFailure('Task state changed while preparing the worktree.', 1);
      }
      this.runs.appendOutput(
        claimed.run_id,
        `[git] Branch: ${prepared.branchName}\n[git] Worktree: ${prepared.worktreePath}\n`,
        ''
      );

      const agentTask: Task & { project: ClaimedTask['project'] } = {
        ...task,
        branch_name: prepared.branchName,
        worktree_path: prepared.worktreePath,
        status: 'IN_PROGRESS',
        project: claimed.project
      };
      const agentResult = await this.agent.execute(agentTask, prepared.worktreePath, signal);
      this.appendAgentResult(claimed.run_id, agentResult);
      if (agentResult.exitCode !== 0) {
        throw new PipelineFailure(
          agentResult.timedOut ? 'Codex execution timed out.' : 'Codex execution failed.',
          agentResult.exitCode,
          '',
          ''
        );
      }

      if (this.tasks.transition(claimed.id, 'IN_PROGRESS', 'TESTING') === null) {
        throw new PipelineFailure('Task state changed before testing.', 1);
      }
      const testResult = await this.tests.execute(prepared.worktreePath, signal);
      this.appendTestResult(claimed.run_id, testResult);
      if (testResult.exitCode !== 0) {
        throw new PipelineFailure(testResult.summary || 'Project tests failed.', testResult.exitCode);
      }

      if (this.tasks.transition(claimed.id, 'TESTING', 'IN_REVIEW') === null) {
        throw new PipelineFailure('Task state changed after testing.', 1);
      }
      exitCode = 0;
      summary = agentResult.summary || testResult.summary || 'Codex completed the task and tests passed.';
    } catch (error) {
      const failure = this.normalizeFailure(error, signal);
      exitCode = failure.exitCode;
      summary = failure.message;
      if (failure.stdout.length > 0 || failure.stderr.length > 0) {
        this.runs.appendOutput(claimed.run_id, failure.stdout, failure.stderr);
      }
      this.runs.appendOutput(claimed.run_id, '', `[orchestrator] ${failure.message}\n`);
      this.tasks.transition(claimed.id, ['CLAIMED', 'IN_PROGRESS', 'TESTING'], 'FAILED');
    } finally {
      this.runs.finish(claimed.run_id, exitCode, summary);
    }
  }

  private appendAgentResult(runId: number, result: AgentExecutionResult): void {
    this.runs.appendOutput(
      runId,
      `[agent]\n${result.stdout}${result.stdout.endsWith('\n') ? '' : '\n'}`,
      result.stderr.length > 0
        ? `[agent]\n${result.stderr}${result.stderr.endsWith('\n') ? '' : '\n'}`
        : ''
    );
  }

  private appendTestResult(runId: number, result: TestExecutionResult): void {
    this.runs.appendOutput(
      runId,
      `[test] ${result.commandDescription}\n${result.stdout}${result.stdout.endsWith('\n') ? '' : '\n'}`,
      result.stderr.length > 0
        ? `[test]\n${result.stderr}${result.stderr.endsWith('\n') ? '' : '\n'}`
        : ''
    );
  }

  private normalizeFailure(error: unknown, signal: AbortSignal): PipelineFailure {
    if (error instanceof PipelineFailure) {
      return error;
    }
    if (signal.aborted) {
      return new PipelineFailure('Task execution was cancelled during application shutdown.', 130);
    }
    if (error instanceof Error) {
      return new PipelineFailure(error.message, 1, '', `${error.stack ?? error.message}\n`);
    }
    return new PipelineFailure('Unknown task pipeline failure.', 1);
  }

  private waitForNextPoll(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.wakeIdle = null;
        resolve();
      };
      const timer = setTimeout(finish, this.pollIntervalMs);
      this.wakeIdle = finish;
    });
  }
}
