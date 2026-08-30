import { spawn } from 'node:child_process';

import type { AgentUsage, AgentUsageWindow, ProcessResult } from '../domain/types.js';
import { resolveCodexCommand } from './codex-command-resolver.js';

const QUERY_TIMEOUT_MS = 15_000;
const CACHE_DURATION_MS = 60_000;

export interface CodexUsageServiceOptions {
  command?: string;
  commandResolver?: () => Promise<string>;
  clock?: () => Date;
  cacheDurationMs?: number;
  query?: (command: string) => Promise<ProcessResult>;
}

export class CodexUsageService {
  private readonly commandResolver: () => Promise<string>;
  private readonly clock: () => Date;
  private readonly cacheDurationMs: number;
  private readonly query: (command: string) => Promise<ProcessResult>;
  private cached: { expiresAt: number; value: AgentUsage } | null = null;

  public constructor(options: CodexUsageServiceOptions = {}) {
    this.commandResolver = options.command === undefined
      ? options.commandResolver ?? resolveCodexCommand
      : async () => options.command as string;
    this.clock = options.clock ?? (() => new Date());
    this.cacheDurationMs = options.cacheDurationMs ?? CACHE_DURATION_MS;
    this.query = options.query ?? queryCodexAppServer;
  }

  public async read(): Promise<AgentUsage> {
    const now = this.clock();
    if (this.cached !== null && this.cached.expiresAt > now.getTime()) {
      return this.cached.value;
    }

    let usage: AgentUsage;
    try {
      const command = await this.commandResolver();
      const result = await this.query(command);
      usage = parseCodexUsage(result, now);
    } catch (error) {
      usage = unavailableUsage(
        now,
        error instanceof Error ? error.message : String(error)
      );
    }

    this.cached = { expiresAt: now.getTime() + this.cacheDurationMs, value: usage };
    return usage;
  }
}

function initializeRequest(): object {
  return {
    method: 'initialize',
    id: 0,
    params: {
      clientInfo: {
        name: 'agentboard',
        title: 'Agentboard',
        version: '0.1.0'
      }
    }
  };
}

async function queryCodexAppServer(command: string): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, ['app-server'], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' }
    });
    let stdout = '';
    let stderr = '';
    let pendingLine = '';
    let settled = false;
    const timeout = setTimeout(() => finish(124, true), QUERY_TIMEOUT_MS);
    timeout.unref();

    const finish = (exitCode: number, timedOut: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      resolve({ exitCode, stdout, stderr, timedOut, aborted: false });
    };

    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    child.once('spawn', () => send(initializeRequest()));
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.stdin.on('error', () => {
      // The process may close stdin while shutdown is already in progress.
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      pendingLine += text;
      const lines = pendingLine.split(/\r?\n/u);
      pendingLine = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = asRecord(JSON.parse(line));
          if (message?.['id'] === 0 && message['result'] !== undefined) {
            send({ method: 'initialized', params: {} });
            send({ method: 'account/rateLimits/read', id: 1 });
          } else if (message?.['id'] === 1) {
            finish(0, false);
          }
        } catch {
          // Non-protocol output stays in stdout for diagnostics.
        }
      }
    });
    child.once('close', (exitCode) => {
      finish(exitCode ?? 1, false);
    });
  });
}

export function parseCodexUsage(result: ProcessResult, checkedAt: Date): AgentUsage {
  for (const line of result.stdout.split(/\r?\n/u)) {
    try {
      const message: unknown = JSON.parse(line);
      const record = asRecord(message);
      if (record === null || record['id'] !== 1) {
        continue;
      }
      const error = asRecord(record['error']);
      if (error !== null) {
        return unavailableUsage(checkedAt, stringValue(error['message']) ?? 'Codex rejected the usage query.');
      }
      const response = asRecord(record['result']);
      const snapshot = response === null ? null : asRecord(response['rateLimits']);
      if (snapshot === null) {
        return unavailableUsage(checkedAt, 'Codex returned no rate-limit data.');
      }
      const resetCredits = asRecord(response?.['rateLimitResetCredits']);
      return {
        available: true,
        planType: stringValue(snapshot['planType']),
        primary: parseWindow(snapshot['primary']),
        secondary: parseWindow(snapshot['secondary']),
        resetCredits: numberValue(resetCredits?.['availableCount']),
        checkedAt: checkedAt.toISOString(),
        message: stringValue(snapshot['rateLimitReachedType']) ?? 'Codex usage is available.'
      };
    } catch {
      // Ignore non-protocol output and continue looking for response id 1.
    }
  }

  const detail = result.stderr.trim();
  return unavailableUsage(
    checkedAt,
    detail || (result.timedOut ? 'Codex usage query timed out.' : 'Codex did not return usage data.')
  );
}

function parseWindow(value: unknown): AgentUsageWindow | null {
  const window = asRecord(value);
  const usedPercent = numberValue(window?.['usedPercent']);
  if (window === null || usedPercent === null) {
    return null;
  }
  const boundedUsed = Math.min(100, Math.max(0, usedPercent));
  return {
    usedPercent: boundedUsed,
    remainingPercent: 100 - boundedUsed,
    windowDurationMins: numberValue(window['windowDurationMins']),
    resetsAt: numberValue(window['resetsAt'])
  };
}

function unavailableUsage(checkedAt: Date, message: string): AgentUsage {
  return {
    available: false,
    planType: null,
    primary: null,
    secondary: null,
    resetCredits: null,
    checkedAt: checkedAt.toISOString(),
    message
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
