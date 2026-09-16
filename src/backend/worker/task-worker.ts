import type {
  AgentAvailability,
  AgentExecutionResult,
  AgentUsage,
  ClaimedTask,
  Task,
  TestExecutionResult,
  WorkerStatus
} from '../domain/types.js';
import { TaskRepository } from '../database/task-repository.js';
import { TaskRunRepository } from '../database/task-run-repository.js';
import type { AgentExecutor } from '../agents/agent-executor.js';
import { GitService, requireCanonicalCommitSummary, type PreparedCherryPick } from '../services/git-service.js';
import { TestService } from '../services/test-service.js';

interface UsageReader {
  read(force?: boolean): Promise<AgentUsage>;
}

export interface TaskWorkerOptions {
  pollIntervalMs?: number;
  usage?: UsageReader;
  clock?: () => number;
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

const MAX_CHERRY_PICK_CONFLICT_ROUNDS = 20;

export class TaskWorker {
  private running = false;
  private paused = false;
  private autoPaused = false;
  private batchTaskIds: Set<number> | null = null;
  private quotaLoopEnabled = false;
  private quotaWaitingUntil: number | null = null;
  private busy = false;
  private activeTaskId: number | null = null;
  private activeController: AbortController | null = null;
  private activeCompletion: Promise<void> | null = null;
  private finishActive: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  private stopRequested = false;
  private wakeIdle: (() => void) | null = null;
  private availability: AgentAvailability = {
    available: false,
    message: 'Codex availability has not been checked yet.'
  };
  private readonly pollIntervalMs: number;
  private readonly usage: UsageReader | undefined;
  private readonly clock: () => number;

  public constructor(
    private readonly tasks: TaskRepository,
    private readonly runs: TaskRunRepository,
    private readonly git: GitService,
    private readonly agent: AgentExecutor,
    private readonly tests: TestService,
    options: TaskWorkerOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.usage = options.usage;
    this.clock = options.clock ?? Date.now;
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
      paused: this.paused,
      autoPaused: this.autoPaused,
      quotaLoopEnabled: this.quotaLoopEnabled,
      quotaWaitingUntil: this.quotaWaitingUntil,
      busy: this.busy,
      activeTaskId: this.activeTaskId,
      agentAvailable: this.availability.available,
      message: this.paused
        ? (this.busy ? 'Worker will pause after the current task finishes.'
          : this.autoPaused ? 'Current Todo batch finished; Worker paused automatically.'
            : 'Worker is paused and will not claim new tasks.')
        : this.quotaWaitingUntil !== null
          ? `Codex usage is exhausted; waiting until ${new Date(this.quotaWaitingUntil).toLocaleString()} before retrying.`
          : this.availability.message
    };
  }

  public pause(): WorkerStatus {
    this.paused = true;
    this.autoPaused = false;
    this.batchTaskIds = null;
    return this.getStatus();
  }

  public resume(): WorkerStatus {
    this.paused = false;
    this.autoPaused = false;
    this.batchTaskIds = new Set(this.tasks.runnableTodoIds());
    this.wakeIdle?.();
    return this.getStatus();
  }

  public setQuotaLoopEnabled(enabled: boolean): WorkerStatus {
    this.quotaLoopEnabled = enabled;
    if (!enabled) this.quotaWaitingUntil = null;
    this.wakeIdle?.();
    return this.getStatus();
  }

  public async cancelTask(taskId: number): Promise<boolean> {
    if (this.activeTaskId !== taskId || this.activeController === null) {
      return false;
    }
    const completion = this.activeCompletion;
    this.activeController.abort();
    await completion;
    return true;
  }

  public async processNext(): Promise<boolean> {
    if (this.busy || this.paused) {
      return false;
    }

    if (this.batchTaskIds !== null && !this.hasRemainingBatchTasks()) {
      this.pauseAfterBatch();
      return false;
    }

    if (this.quotaLoopEnabled && this.usage !== undefined) {
      if (this.quotaWaitingUntil !== null && this.clock() < this.quotaWaitingUntil) return false;
      const usage = await this.usage.read(this.quotaWaitingUntil !== null);
      if (this.pauseForExhaustedUsage(usage)) return false;
      this.quotaWaitingUntil = null;
    }

    this.availability = await this.agent.checkAvailability();
    if (!this.availability.available || this.stopRequested || this.paused) {
      return false;
    }

    const claimed = this.tasks.claimNext(this.batchTaskIds === null ? undefined : [...this.batchTaskIds]);
    if (claimed === null) {
      return false;
    }

    this.busy = true;
    this.activeTaskId = claimed.id;
    this.activeController = new AbortController();
    this.activeCompletion = new Promise<void>((resolve) => {
      this.finishActive = resolve;
    });

    try {
      await this.executePipeline(claimed, this.activeController.signal);
    } finally {
      if (this.batchTaskIds !== null) {
        const current = this.tasks.findById(claimed.id);
        if (current?.status !== 'TODO') this.batchTaskIds.delete(claimed.id);
      }
      this.activeController = null;
      this.activeTaskId = null;
      this.busy = false;
      this.finishActive?.();
      this.finishActive = null;
      this.activeCompletion = null;
      if (!this.paused && this.batchTaskIds !== null && !this.hasRemainingBatchTasks()) {
        this.pauseAfterBatch();
      }
    }
    return true;
  }

  private hasRemainingBatchTasks(): boolean {
    const queued = new Set(this.tasks.runnableTodoIds());
    return [...(this.batchTaskIds ?? [])].some((id) => queued.has(id));
  }

  private pauseAfterBatch(): void {
    this.paused = true;
    this.autoPaused = true;
    this.batchTaskIds = null;
  }

  private pauseForExhaustedUsage(usage: AgentUsage): boolean {
    if (!usage.available) return false;
    const exhausted = [usage.primary, usage.secondary].filter((window) =>
      window !== null && window.remainingPercent <= 0);
    if (exhausted.length === 0) return false;
    const nextReset = Math.max(...exhausted.map((window) =>
      window?.resetsAt === null ? 0 : (window?.resetsAt ?? 0) * 1_000));
    this.quotaWaitingUntil = Math.max(this.clock() + 60_000, nextReset);
    return true;
  }

  private async waitForQuotaRefresh(): Promise<void> {
    if (!this.quotaLoopEnabled) return;
    const usage = await this.usage?.read(true);
    if (usage === undefined || !this.pauseForExhaustedUsage(usage)) {
      const futureResets = [usage?.primary?.resetsAt, usage?.secondary?.resetsAt]
        .filter((value): value is number => value !== null && value !== undefined)
        .map((value) => value * 1_000)
        .filter((value) => value > this.clock());
      this.quotaWaitingUntil = futureResets.length > 0
        ? Math.max(this.clock() + 60_000, Math.min(...futureResets))
        : this.clock() + 60_000;
    }
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
    let quotaLimited = false;

    try {
      const isCherryPickResolution = claimed.agent_mode === 'cherry_pick_resolution';
      this.runs.appendOutput(
        claimed.run_id,
        isCherryPickResolution
          ? '[git] Preparing a temporary main-based cherry-pick resolution branch...\n'
          : '[git] Checking out managed delivery branch...\n',
        '',
      );
      const prepared = isCherryPickResolution
        ? await this.git.prepareCherryPickResolution(claimed, claimed.project.repository_path, signal)
        : await this.git.prepareBranch(claimed, claimed.project.repository_path, signal);
      const sourceCommitSha = isCherryPickResolution
        ? (prepared as PreparedCherryPick).sourceCommitSha
        : null;
      this.runs.appendOutput(
        claimed.run_id,
        `[git] Branch: ${prepared.branchName}\n[git] Workspace: ${prepared.workspacePath}\n`,
        ''
      );

      let agentResult: AgentExecutionResult | undefined;
      let testResult: TestExecutionResult | undefined;
      let canonicalSummary: string | undefined;
      let cherryPickInProgress = false;
      let resolvedPublishCommitSha: string | undefined;
      let verificationPassed = false;
      try {
        const task = isCherryPickResolution
          ? this.tasks.setWorkspace(claimed.id, prepared.workspacePath)
          : this.tasks.setArtifacts(
              claimed.id,
              prepared.branchName,
              prepared.workspacePath,
              prepared.originalBranch,
            );
        if (task === null || this.tasks.transition(task.id, 'CLAIMED', 'IN_PROGRESS') === null) {
          throw new PipelineFailure('Task state changed while preparing its branch.', 1);
        }

        const agentTask: Task & { project: ClaimedTask['project'] } = {
          ...task,
          branch_name: prepared.branchName,
          worktree_path: prepared.workspacePath,
          status: 'IN_PROGRESS',
          project: claimed.project
        };
        if (isCherryPickResolution) {
          const completed = await this.git.beginFeatureCherryPick(
            prepared.workspacePath,
            sourceCommitSha as string,
            signal,
          );
          cherryPickInProgress = !completed;
        }

        let conflictRound = 0;
        while (!isCherryPickResolution || cherryPickInProgress) {
          conflictRound += 1;
          if (conflictRound > MAX_CHERRY_PICK_CONFLICT_ROUNDS) {
            throw new PipelineFailure('Cherry-pick conflict resolution exceeded the safe round limit.', 1);
          }
          agentResult = await this.agent.execute(agentTask, prepared.workspacePath, signal);
          this.appendAgentResult(claimed.run_id, agentResult);
          if (agentResult.exitCode !== 0) {
            quotaLimited = this.quotaLoopEnabled && !agentResult.timedOut && !agentResult.aborted
              && /(?:rate[\s_-]*limit|usage[\s_-]*limit|quota|too many requests|(?:^|\W)429(?:\W|$))/iu
                .test(`${agentResult.summary}\n${agentResult.stderr}\n${agentResult.stdout}`);
            throw new PipelineFailure(
              agentResult.timedOut ? 'Codex execution timed out.' : 'Codex execution failed.',
              agentResult.exitCode
            );
          }
          canonicalSummary = requireCanonicalCommitSummary(agentResult.summary);
          if (cherryPickInProgress) {
            cherryPickInProgress = !await this.git.continueFeatureCherryPick(prepared.workspacePath, signal);
          } else {
            break;
          }
        }

        if (isCherryPickResolution) {
          resolvedPublishCommitSha = await this.git.currentCommit(prepared.workspacePath, signal);
        }

        if (this.tasks.transition(claimed.id, 'IN_PROGRESS', 'TESTING') === null) {
          throw new PipelineFailure('Task state changed before testing.', 1);
        }
        testResult = await this.tests.execute(prepared.workspacePath, signal);
        this.appendTestResult(claimed.run_id, testResult);
        if (testResult.executed && testResult.exitCode !== 0) {
          throw new PipelineFailure(
            testResult.summary || 'Project verification failed.',
            testResult.exitCode
          );
        }
        verificationPassed = true;
      } finally {
        if (cherryPickInProgress) {
          await this.git.abortFeatureCherryPick(prepared.workspacePath);
        }
        const checkpointed = await this.git.completeBranch(prepared, claimed.id, canonicalSummary);
        try {
          const runDiff = await this.git.captureRunDiff(prepared);
          this.runs.setDiff(claimed.run_id, runDiff.fileDiff, runDiff.codeDiff);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.runs.appendOutput(
            claimed.run_id,
            '',
            `[git] Task changes were saved, but the read-only diff snapshot could not be captured: ${message}\n`,
          );
        }
        if (isCherryPickResolution && verificationPassed && resolvedPublishCommitSha !== undefined) {
          this.tasks.finishCherryPickResolution(claimed.id, resolvedPublishCommitSha);
        } else if (!isCherryPickResolution && canonicalSummary !== undefined) {
          const publishCommitSha = claimed.feature_id === null || claimed.feature_id === undefined
            ? null
            : await this.git.commitAtRef(prepared.workspacePath, prepared.branchName);
          this.tasks.setCommitSummary(claimed.id, canonicalSummary, publishCommitSha);
        }
        this.runs.appendOutput(
          claimed.run_id,
          checkpointed
            ? `[git] Checkpointed ${prepared.branchName} and restored ${prepared.originalBranch}.\n`
            : `[git] No file changes to checkpoint; restored ${prepared.originalBranch}.\n`,
          ''
        );
      }

      if (this.tasks.transition(claimed.id, 'TESTING', 'IN_REVIEW') === null) {
        throw new PipelineFailure('Task state changed after testing.', 1);
      }
      exitCode = 0;
      const agentSummary = agentResult?.summary || 'Codex completed the task.';
      summary = testResult?.executed === false
        ? `${agentSummary}\n\n${testResult.summary}`
        : agentSummary || testResult?.summary || 'Codex completed the task and verification passed.';
    } catch (error) {
      const failure = this.normalizeFailure(error, signal);
      exitCode = failure.exitCode;
      const stoppedDuringShutdown = signal.aborted && this.stopRequested;
      summary = quotaLimited
        ? 'Codex usage limit reached; task returned to Todo until usage refreshes.'
        : stoppedDuringShutdown
        ? 'Application stopped; task returned to TODO.'
        : failure.message;
      if (failure.stdout.length > 0 || failure.stderr.length > 0) {
        this.runs.appendOutput(claimed.run_id, failure.stdout, failure.stderr);
      }
      this.runs.appendOutput(claimed.run_id, '', `[orchestrator] ${summary}\n`);
      if (quotaLimited) {
        this.tasks.requeueAfterShutdown(claimed.id);
        await this.waitForQuotaRefresh();
      } else if (stoppedDuringShutdown) {
        this.tasks.requeueAfterShutdown(claimed.id);
      } else {
        this.tasks.transition(claimed.id, ['CLAIMED', 'IN_PROGRESS', 'TESTING'], 'FAILED');
      }
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
    const label = result.verificationKind === 'test'
      ? 'test'
      : result.verificationKind === 'build'
        ? 'build'
        : 'verification';
    this.runs.appendOutput(
      runId,
      `[${label}] ${result.commandDescription}\n${result.stdout}${result.stdout.endsWith('\n') ? '' : '\n'}`,
      result.stderr.length > 0
        ? `[${label}]\n${result.stderr}${result.stderr.endsWith('\n') ? '' : '\n'}`
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
