import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { AgentAvailability, AgentExecutionResult, ProcessResult } from '../domain/types.js';
import {
  ProcessRunner,
  type ProcessRunnerLike
} from '../infra/process-runner.js';
import type { AgentExecutor, AgentTask } from './agent-executor.js';

const DEFAULT_EXECUTION_TIMEOUT_MS = 30 * 60 * 1_000;
const AVAILABILITY_TIMEOUT_MS = 15_000;
const AGENT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const SUMMARY_LIMIT_CHARACTERS = 4_000;

export interface CodexAgentExecutorOptions {
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class CodexAgentExecutor implements AgentExecutor {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  public constructor(
    private readonly processRunner: ProcessRunnerLike = new ProcessRunner(),
    options: CodexAgentExecutorOptions = {}
  ) {
    this.command = options.command ?? (process.env['CODEX_BIN']?.trim() || 'codex');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? AGENT_OUTPUT_LIMIT_BYTES;
  }

  public async checkAvailability(): Promise<AgentAvailability> {
    try {
      const result = await this.processRunner.run({
        command: this.command,
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
      result = await this.processRunner.run({
        command: this.command,
        // --ask-for-approval is a global option and must precede `exec` on Codex.
        // Prompt content is deliberately supplied on stdin via the final `-`.
        args: [
          '--sandbox',
          'workspace-write',
          '--ask-for-approval',
          'never',
          '--cd',
          canonicalWorkspace,
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

    return {
      ...result,
      summary: summarizeCodexResult(result)
    };
  }
}

export function buildCodexPrompt(task: AgentTask): string {
  const projectName = task.project?.name ?? `Project ${task.project_id}`;
  const projectContext = task.project?.context.trim() || 'No additional project context was provided.';
  const description = task.description.trim() || 'No additional task description was provided.';

  return [
    `You are implementing orchestrator task #${task.id} in an isolated Git worktree.`,
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
    '- Work only inside the current worktree.',
    '- Do not create, check out, switch, delete, or rewrite Git branches or worktrees.',
    '- Do not commit, push, merge, rebase, or fetch from remotes.',
    '- Do not change Git remotes or Git configuration.',
    '- Do not modify the parent repository or its main branch.',
    '- Do not require interactive input or approval.',
    '- Implement the requested change completely and keep unrelated user changes intact.',
    '- Finish with a concise summary of the implementation and any checks you ran.'
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
    return truncateSummary(finalAgentMessage ?? 'Codex completed successfully.');
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
