import { spawn, type ChildProcess } from 'node:child_process';
import { Buffer } from 'node:buffer';

import type { ProcessResult } from '../domain/types.js';

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 2_000;
const TRUNCATION_MARKER = '\n[output truncated]\n';

export interface ProcessRunOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}

export interface ProcessRunnerLike {
  run(options: ProcessRunOptions): Promise<ProcessResult>;
}

export class ProcessSpawnError extends Error {
  public constructor(
    public readonly command: string,
    options: ErrorOptions
  ) {
    super(`Unable to start ${command}: ${options.cause instanceof Error ? options.cause.message : String(options.cause)}`, options);
    this.name = 'ProcessSpawnError';
  }
}

/**
 * Runs backend-generated executables without a command shell.
 *
 * Output is bounded per stream. Once the bound is exceeded, the beginning and
 * end are retained so setup failures and final summaries are both visible.
 */
export class ProcessRunner implements ProcessRunnerLike {
  public async run(options: ProcessRunOptions): Promise<ProcessResult> {
    validateOptions(options);

    if (options.signal?.aborted) {
      return abortedResult();
    }

    const args = [...(options.args ?? [])];
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    return await new Promise<ProcessResult>((resolve, reject) => {
      const stdout = new CappedOutput(maxOutputBytes);
      const stderr = new CappedOutput(maxOutputBytes);
      let child: ChildProcess;

      try {
        child = spawn(options.command, args, {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (error) {
        reject(new ProcessSpawnError(options.command, { cause: error }));
        return;
      }

      let settled = false;
      let spawned = false;
      let timedOut = false;
      let aborted = false;
      let terminationReason: 'timeout' | 'abort' | undefined;
      let terminationStarted = false;
      let timeout: NodeJS.Timeout | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const clearResources = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
        options.signal?.removeEventListener('abort', onAbort);
      };

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearResources();

        resolve({
          exitCode: timedOut
            ? 124
            : aborted
              ? 130
              : exitCode ?? fallbackExitCode(signal),
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          timedOut,
          aborted
        });
      };

      const terminate = (reason: 'timeout' | 'abort'): void => {
        if (
          settled ||
          child.exitCode !== null ||
          child.signalCode !== null
        ) {
          return;
        }

        if (terminationReason === undefined) {
          terminationReason = reason;
          timedOut = reason === 'timeout';
          aborted = reason === 'abort';
        }
        if (terminationStarted || child.pid === undefined) {
          return;
        }
        terminationStarted = true;
        child.stdin?.destroy();
        terminateProcessTree(child, false);

        forceKillTimer = setTimeout(() => {
          if (!settled && child.exitCode === null && child.signalCode === null) {
            terminateProcessTree(child, true);
          }
        }, FORCE_KILL_DELAY_MS);
        forceKillTimer.unref();
      };

      const onAbort = (): void => {
        terminate('abort');
      };

      options.signal?.addEventListener('abort', onAbort, { once: true });

      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          terminate('timeout');
        }, options.timeoutMs);
        timeout.unref();
      }

      child.once('spawn', () => {
        spawned = true;
        if (terminationReason !== undefined) {
          terminate(terminationReason);
        } else if (options.signal?.aborted) {
          terminate('abort');
        }
      });

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout.append(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr.append(chunk);
      });

      child.once('error', (error) => {
        if (settled) {
          return;
        }

        // A child can emit an error after spawning (for example an IPC error).
        // In that case close remains the authoritative source of its exit code.
        if (spawned) {
          stderr.append(`\nProcess error: ${error.message}\n`);
          return;
        }

        settled = true;
        clearResources();
        reject(new ProcessSpawnError(options.command, { cause: error }));
      });

      child.once('close', finish);

      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        // EPIPE is expected when a command exits before consuming all input.
        if (error.code !== 'EPIPE') {
          stderr.append(`\nUnable to write process input: ${error.message}\n`);
        }
      });

      if (options.stdin === undefined) {
        child.stdin?.end();
      } else {
        child.stdin?.end(options.stdin);
      }
    });
  }
}

function validateOptions(options: ProcessRunOptions): void {
  if (options.command.trim().length === 0 || options.command.includes('\0')) {
    throw new TypeError('Process command must be a non-empty executable name.');
  }

  if ((options.args ?? []).some((argument) => argument.includes('\0'))) {
    throw new TypeError('Process arguments cannot contain NUL bytes.');
  }

  if (options.cwd?.includes('\0')) {
    throw new TypeError('Process working directory cannot contain NUL bytes.');
  }

  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new RangeError('Process timeout must be a positive finite number.');
  }

  if (
    options.maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 256)
  ) {
    throw new RangeError('Process output limit must be an integer of at least 256 bytes.');
  }
}

function abortedResult(): ProcessResult {
  return {
    exitCode: 130,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: true
  };
}

function fallbackExitCode(signal: NodeJS.Signals | null): number {
  return signal === null ? 1 : 128 + signalNumber(signal);
}

function signalNumber(signal: NodeJS.Signals): number {
  const conventionalNumbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGABRT: 6,
    SIGALRM: 14,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGHUP: 1,
    SIGILL: 4,
    SIGINT: 2,
    SIGKILL: 9,
    SIGPIPE: 13,
    SIGQUIT: 3,
    SIGSEGV: 11,
    SIGTERM: 15,
    SIGTRAP: 5
  };
  return conventionalNumbers[signal] ?? 1;
}

function terminateProcessTree(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  if (process.platform === 'win32') {
    const killer = spawn(
      'taskkill.exe',
      ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])],
      {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      }
    );
    killer.on('error', () => {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    });
    killer.on('close', (exitCode) => {
      if (exitCode !== 0 && child.exitCode === null && child.signalCode === null) {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      }
    });
    if (force) {
      // Sandboxed Windows sessions can deny taskkill access even for a child
      // created by this process. Always retain the direct-child kill fallback.
      child.kill('SIGKILL');
    }
    killer.unref();
    return;
  }

  try {
    // POSIX children are detached into their own process group, so this also
    // terminates subprocesses launched by git, test runners, or an agent.
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
}

class CappedOutput {
  private chunks: Buffer[] = [];
  private byteLength = 0;
  private truncated = false;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);

  public constructor(private readonly maxBytes: number) {}

  public append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (chunk.length === 0) {
      return;
    }

    if (!this.truncated && this.byteLength + chunk.length <= this.maxBytes) {
      this.chunks.push(chunk);
      this.byteLength += chunk.length;
      return;
    }

    const markerLength = Buffer.byteLength(TRUNCATION_MARKER);
    const available = Math.max(0, this.maxBytes - markerLength);
    const headLimit = Math.ceil(available * 0.6);
    const tailLimit = available - headLimit;

    if (!this.truncated) {
      const combined = Buffer.concat([...this.chunks, chunk]);
      this.head = combined.subarray(0, headLimit);
      this.tail = tailLimit === 0 ? Buffer.alloc(0) : combined.subarray(-tailLimit);
      this.chunks = [];
      this.byteLength = combined.length;
      this.truncated = true;
      return;
    }

    this.byteLength += chunk.length;
    if (tailLimit > 0) {
      this.tail = Buffer.concat([this.tail, chunk]).subarray(-tailLimit);
    }
  }

  public toString(): string {
    if (!this.truncated) {
      return Buffer.concat(this.chunks).toString('utf8');
    }
    return Buffer.concat([this.head, Buffer.from(TRUNCATION_MARKER), this.tail]).toString('utf8');
  }
}
