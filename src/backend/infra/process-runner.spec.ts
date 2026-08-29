import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { ProcessRunner } from './process-runner.js';

describe('ProcessRunner', () => {
  it('passes argv and stdin without a shell', async () => {
    const runner = new ProcessRunner();
    const result = await runner.run({
      command: process.execPath,
      args: [
        '-e',
        'process.stdin.setEncoding("utf8");let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({arg:process.argv[1],input})))',
        'literal && not-a-command'
      ],
      stdin: 'hello from stdin',
      timeoutMs: 5_000
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      arg: 'literal && not-a-command',
      input: 'hello from stdin'
    });
  });

  it('bounds captured output while preserving its beginning and end', async () => {
    const runner = new ProcessRunner();
    const result = await runner.run({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("HEAD"+"x".repeat(2000)+"TAIL")'],
      timeoutMs: 5_000,
      maxOutputBytes: 256
    });

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(256);
    expect(result.stdout).toContain('HEAD');
    expect(result.stdout).toContain('[output truncated]');
    expect(result.stdout).toContain('TAIL');
  });

  it('terminates timed out commands with a deterministic sentinel', async () => {
    const runner = new ProcessRunner();
    const result = await runner.run({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{}, 1000)'],
      timeoutMs: 50
    });

    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });
});
