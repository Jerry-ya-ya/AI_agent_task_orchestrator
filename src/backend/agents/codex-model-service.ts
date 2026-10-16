import { spawn } from 'node:child_process';

import {
  DEFAULT_MODEL_ID,
  type AgentModel,
  type AgentModelEffort,
} from '../domain/types.js';
import { resolveCodexCommand } from './codex-command-resolver.js';

const QUERY_TIMEOUT_MS = 15_000;
const CACHE_DURATION_MS = 5 * 60_000;

export interface CodexModelServiceOptions {
  command?: string;
  commandResolver?: () => Promise<string>;
  cacheDurationMs?: number;
  query?: (command: string) => Promise<AgentModel[]>;
}

export class CodexModelService {
  private readonly commandResolver: () => Promise<string>;
  private readonly cacheDurationMs: number;
  private readonly query: (command: string) => Promise<AgentModel[]>;
  private cached: { expiresAt: number; value: AgentModel[] } | null = null;

  public constructor(options: CodexModelServiceOptions = {}) {
    this.commandResolver = options.command === undefined
      ? options.commandResolver ?? resolveCodexCommand
      : async () => options.command as string;
    this.cacheDurationMs = options.cacheDurationMs ?? CACHE_DURATION_MS;
    this.query = options.query ?? queryCodexModels;
  }

  public async list(force = false): Promise<AgentModel[]> {
    const now = Date.now();
    if (!force && this.cached !== null && this.cached.expiresAt > now) {
      return this.cached.value;
    }

    let models: AgentModel[];
    try {
      models = await this.query(await this.commandResolver());
      if (models.length === 0) models = fallbackModels();
    } catch {
      models = fallbackModels();
    }
    this.cached = { expiresAt: now + this.cacheDurationMs, value: models };
    return models;
  }
}

async function queryCodexModels(command: string): Promise<AgentModel[]> {
  return await new Promise<AgentModel[]>((resolve, reject) => {
    const child = spawn(command, ['app-server'], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    const models: AgentModel[] = [];
    let pendingLine = '';
    let stderr = '';
    let requestId = 1;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error('Codex model query timed out.')), QUERY_TIMEOUT_MS);
    timeout.unref();

    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const stop = (): void => {
      clearTimeout(timeout);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      stop();
      resolve(models);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      stop();
      reject(error);
    };
    const requestPage = (cursor: string | null = null): void => {
      send({ method: 'model/list', id: requestId, params: { cursor, includeHidden: false, limit: 100 } });
    };

    child.once('spawn', () => send({
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'agentboard', title: 'Agentboard', version: '0.1.0' } },
    }));
    child.once('error', fail);
    child.stdin.on('error', () => {
      // The process can close stdin while the completed query is shutting down.
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer | string) => {
      pendingLine += chunk.toString();
      const lines = pendingLine.split(/\r?\n/u);
      pendingLine = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = asRecord(JSON.parse(line));
          if (message?.['id'] === 0 && message['result'] !== undefined) {
            send({ method: 'initialized', params: {} });
            requestPage();
            continue;
          }
          if (message?.['id'] !== requestId) continue;
          const error = asRecord(message['error']);
          if (error !== null) {
            fail(new Error(stringValue(error['message']) ?? 'Codex rejected the model query.'));
            return;
          }
          const result = asRecord(message['result']);
          const data = Array.isArray(result?.['data']) ? result['data'] : [];
          models.push(...data.map(parseModel).filter((model): model is AgentModel => model !== null));
          const nextCursor = stringValue(result?.['nextCursor']);
          if (nextCursor === null) {
            finish();
          } else {
            requestId += 1;
            requestPage(nextCursor);
          }
        } catch {
          // Ignore non-protocol output and continue reading JSONL messages.
        }
      }
    });
    child.once('close', (exitCode) => {
      if (!settled) fail(new Error(stderr.trim() || `Codex model query exited with code ${exitCode ?? 1}.`));
    });
  });
}

function parseModel(value: unknown): AgentModel | null {
  const record = asRecord(value);
  if (record === null || record['hidden'] === true) return null;
  const id = stringValue(record['model']) ?? stringValue(record['id']);
  if (id === null) return null;
  const efforts = Array.isArray(record['supportedReasoningEfforts'])
    ? record['supportedReasoningEfforts'].map(parseEffort).filter((effort): effort is AgentModelEffort => effort !== null)
    : [];
  const defaultEffort = stringValue(record['defaultReasoningEffort']) ?? efforts[0]?.id ?? 'medium';
  return {
    id,
    displayName: stringValue(record['displayName']) ?? id,
    description: stringValue(record['description']) ?? '',
    isDefault: record['isDefault'] === true,
    defaultReasoningEffort: defaultEffort,
    supportedReasoningEfforts: efforts.length > 0 ? efforts : [{ id: defaultEffort, description: '' }],
  };
}

function parseEffort(value: unknown): AgentModelEffort | null {
  const record = asRecord(value);
  const id = stringValue(record?.['reasoningEffort']);
  if (id === null) return null;
  return { id, description: stringValue(record?.['description']) ?? '' };
}

function fallbackModels(): AgentModel[] {
  return [
    fallbackModel('gpt-6.1-sol', 'GPT-6.1-Sol', 'Latest workhorse model for coding and everyday work.', true, 'low', true),
    fallbackModel('gpt-6-astra', 'GPT-6-Astra', 'Frontier intelligence for the most demanding work.', false, 'low', true),
    fallbackModel('gpt-6-sol', 'GPT-6-Sol', 'Previous generation workhorse model.', false, 'medium', true),
    fallbackModel('gpt-6-luna', 'GPT-6-Luna', 'Fast and affordable model for easier tasks.', false, 'medium', false),
    fallbackModel('gpt-5.6-sol', 'GPT-5.6-Sol', 'Older generation workhorse model.', false, 'low', true),
    fallbackModel('gpt-5.6-terra', 'GPT-5.6-Terra', 'Older balanced model for straightforward work.', false, 'medium', true),
    fallbackModel('gpt-5.6-luna', 'GPT-5.6-Luna', 'Older fast and efficient model.', false, 'medium', false),
  ];
}

function fallbackModel(
  id: string,
  displayName: string,
  description: string,
  isDefault: boolean,
  defaultReasoningEffort: string,
  supportsUltra: boolean,
): AgentModel {
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max', ...(supportsUltra ? ['ultra'] : [])];
  return {
    id,
    displayName,
    description,
    isDefault: id === DEFAULT_MODEL_ID || isDefault,
    defaultReasoningEffort,
    supportedReasoningEfforts: efforts.map((effort) => ({ id: effort, description: '' })),
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
