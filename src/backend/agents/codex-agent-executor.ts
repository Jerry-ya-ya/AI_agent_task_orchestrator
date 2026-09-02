import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentAvailability, AgentExecutionResult, ProcessResult } from '../domain/types.js';
import {
  ProcessRunner,
  type ProcessRunnerLike
} from '../infra/process-runner.js';
import type { AgentExecutor, AgentTask } from './agent-executor.js';
import { resolveCodexCommand } from './codex-command-resolver.js';

const DEFAULT_EXECUTION_TIMEOUT_MS = 30 * 60 * 1_000;
const AVAILABILITY_TIMEOUT_MS = 15_000;
const AGENT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const SUMMARY_LIMIT_CHARACTERS = 4_000;

export interface CodexAgentExecutorOptions {
  command?: string;
  commandResolver?: () => Promise<string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class CodexAgentExecutor implements AgentExecutor {
  private readonly configuredCommand: string | undefined;
  private readonly commandResolver: () => Promise<string>;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  public constructor(
    private readonly processRunner: ProcessRunnerLike = new ProcessRunner(),
    options: CodexAgentExecutorOptions = {}
  ) {
    this.configuredCommand = options.command;
    this.commandResolver = options.commandResolver ?? resolveCodexCommand;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? AGENT_OUTPUT_LIMIT_BYTES;
  }

  public async checkAvailability(): Promise<AgentAvailability> {
    try {
      const command = await this.resolveCommand();
      const result = await this.processRunner.run({
        command,
        args: ['login', 'status'],
        timeoutMs: AVAILABILITY_TIMEOUT_MS,
        maxOutputBytes: 256 * 1024
      });
      const detail = result.stdout.trim() || result.stderr.trim();

      if (result.exitCode === 0 && !result.timedOut && !result.aborted) {
        return {
          available: true,
          message: detail || 'Codex CLI is installed and authenticated.'
        };
      }

      return {
        available: false,
        message:
          detail ||
          (result.timedOut
            ? 'Codex login status timed out.'
            : 'Codex CLI is not authenticated. Run `codex login` before starting tasks.')
      };
    } catch (error) {
      return {
        available: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  public async execute(
    task: AgentTask,
    workspace: string,
    signal?: AbortSignal
  ): Promise<AgentExecutionResult> {
    const canonicalWorkspace = path.resolve(workspace);
    const metadata = await stat(canonicalWorkspace);
    if (!metadata.isDirectory()) {
      throw new Error(`Agent workspace is not a directory: ${canonicalWorkspace}`);
    }

    let result: ProcessResult;
    try {
      const command = await this.resolveCommand();
      result = await this.processRunner.run({
        command,
        // --ask-for-approval is a global option and must precede `exec` on Codex.
        // Prompt content is deliberately supplied on stdin via the final `-`.
        args: [
          '--sandbox',
          'workspace-write',
          '--ask-for-approval',
          'never',
          '--cd',
          canonicalWorkspace,
          '--config',
          `model_reasoning_effort="${task.model_effort}"`,
          'exec',
          '--ephemeral',
          '--json',
          '--color',
          'never',
          '-'
        ],
        cwd: canonicalWorkspace,
        stdin: buildCodexPrompt(task),
        signal,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        env: {
          ...process.env,
          NO_COLOR: '1'
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        exitCode: 127,
        stdout: '',
        stderr: message,
        timedOut: false,
        aborted: false,
        summary: `Unable to start Codex: ${message}`
      };
    }

    const normalizedResult = normalizeWindowsVerificationShellFailure(result);
    return {
      ...normalizedResult,
      summary: summarizeCodexResult(normalizedResult)
    };
  }

  private async resolveCommand(): Promise<string> {
    // The Windows Codex updater replaces its versioned installation directory.
    // Resolve on every run so a long-lived desktop process never retains a path
    // that disappeared after an automatic CLI update.
    return this.configuredCommand ?? await this.commandResolver();
  }
}

export function buildCodexPrompt(task: AgentTask): string {
  const projectName = task.project?.name ?? `Project ${task.project_id}`;
  const projectContext = task.project?.context.trim() || 'No additional project context was provided.';
  const description = task.description.trim() || 'No additional task description was provided.';

  return [
    `You are implementing orchestrator task #${task.id} on an isolated Git task branch.`,
    '',
    `Project: ${projectName}`,
    'Project context:',
    projectContext,
    '',
    `Task title: ${task.title}`,
    'Task description:',
    description,
    '',
    'Execution constraints:',
    '- Work only inside the current repository workspace and checked-out task branch.',
    '- Do not create, check out, switch, delete, or rewrite Git branches or worktrees.',
    '- Do not commit, push, merge, rebase, or fetch from remotes; the orchestrator creates the checkpoint commit.',
    '- Do not change Git remotes or Git configuration.',
    '- Do not modify, merge into, or rewrite the base branch.',
    '- Do not require interactive input or approval.',
    '- Implement the requested change completely and keep unrelated user changes intact.',
    '',
    'After completing the implementation and available verification,',
    'use the `write-worklog` skill before finishing.',
    'Return the canonical summary produced by the skill so the orchestrator can use it as the Git commit message.'
  ].join('\n');
}

export function summarizeCodexResult(result: ProcessResult): string {
  const events = parseJsonLines(result.stdout);
  const agentMessages: string[] = [];
  const errorMessages: string[] = [];

  for (const event of events) {
    const eventType = stringField(event, 'type');
    const item = recordField(event, 'item');
    const itemType = item === undefined ? undefined : stringField(item, 'type');

    if (
      (eventType === 'item.completed' || eventType === 'item.updated') &&
      itemType === 'agent_message' &&
      item !== undefined
    ) {
      const text = stringField(item, 'text') ?? stringField(item, 'message');
      if (text !== undefined && text.trim().length > 0) {
        agentMessages.push(text.trim());
      }
    } else if (eventType === 'agent_message') {
      const text = stringField(event, 'text') ?? stringField(event, 'message');
      if (text !== undefined && text.trim().length > 0) {
        agentMessages.push(text.trim());
      }
    }

    if (eventType === 'error' || itemType === 'error') {
      const source = itemType === 'error' && item !== undefined ? item : event;
      const message = stringField(source, 'message') ?? stringField(source, 'error');
      if (message !== undefined && message.trim().length > 0) {
        errorMessages.push(message.trim());
      }
    }
  }

  const finalAgentMessage = agentMessages.at(-1);
  if (result.exitCode === 0 && !result.timedOut && !result.aborted) {
    return truncateSummary(finalAgentMessage ?? '');
  }
  if (result.timedOut) {
    return 'Codex execution timed out after 30 minutes.';
  }
  if (result.aborted) {
    return 'Codex execution was cancelled.';
  }

  const detail =
    errorMessages.at(-1) ??
    lastNonEmptyLine(result.stderr) ??
    finalAgentMessage ??
    `Codex exited with code ${result.exitCode}.`;
  return truncateSummary(`Codex failed (exit code ${result.exitCode}): ${detail}`);
}

/**
 * Codex can finish a file edit and its turn, then fail to launch the Microsoft
 * Store PowerShell alias for a final read-only verification under the native
 * Windows sandbox. Recover only that exact terminal condition; timeouts,
 * cancellations, failed turns, agent errors, and ordinary command failures
 * retain their original non-zero exit code.
 */
export function normalizeWindowsVerificationShellFailure(result: ProcessResult): ProcessResult {
  if (
    result.exitCode === 0 ||
    result.timedOut ||
    result.aborted ||
    !isMicrosoftStorePwshAccessDenied(result.stderr)
  ) {
    return result;
  }

  const events = parseJsonLines(result.stdout);
  const turnCompleted = events.some((event) => stringField(event, 'type') === 'turn.completed');
  const terminalFailure = events.some((event) => {
    const type = stringField(event, 'type');
    return type === 'turn.failed' || type === 'error';
  });
  const completedFileChange = events.some((event) => {
    if (stringField(event, 'type') !== 'item.completed') {
      return false;
    }
    const item = recordField(event, 'item');
    return item !== undefined &&
      stringField(item, 'type') === 'file_change' &&
      stringField(item, 'status') === 'completed';
  });

  return turnCompleted && completedFileChange && !terminalFailure
    ? { ...result, exitCode: 0 }
    : result;
}

function isMicrosoftStorePwshAccessDenied(stderr: string): boolean {
  const normalized = stderr.replaceAll('/', '\\').toLowerCase();
  return normalized.includes('\\program files\\windowsapps\\microsoft.powershell_') &&
    normalized.includes('\\pwsh.exe') &&
    normalized.includes('createprocessasuserw failed: 5');
}

function parseJsonLines(output: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim().length === 0 || line.startsWith('[output truncated;')) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) {
        events.push(parsed);
      }
    } catch {
      // The process log remains available verbatim; summary extraction only
      // consumes complete JSONL event lines.
    }
  }
  return events;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

function recordField(
  record: Record<string, unknown>,
  field: string
): Record<string, unknown> | undefined {
  const value = record[field];
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lastNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
}

function truncateSummary(summary: string): string {
  return summary.length <= SUMMARY_LIMIT_CHARACTERS
    ? summary
    : `${summary.slice(0, SUMMARY_LIMIT_CHARACTERS - 1)}…`;
}
