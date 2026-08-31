import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProcessResult } from '../domain/types.js';
import {
  ProcessRunner,
  type ProcessRunOptions,
  type ProcessRunnerLike
} from '../infra/process-runner.js';
import { TestService } from './test-service.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(async (entry) => await rm(entry, { recursive: true, force: true })));
});

describe('TestService', () => {
  it('forces Angular package tests into non-watch mode', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ scripts: { test: 'ng test' }, packageManager: 'pnpm@10.0.0' })
    );
    await writeFile(path.join(workspace, 'angular.json'), '{}');
    const runner = new RecordingRunner(successResult());
    const service = new TestService(runner);

    const result = await service.execute(workspace);

    expect(result.exitCode).toBe(0);
    if (process.platform === 'win32') {
      expect(path.basename(runner.lastOptions?.command ?? '').toLowerCase()).toBe('cmd.exe');
      const windowsCommandLine = (runner.lastOptions?.args?.at(-1) ?? '').toLowerCase();
      expect(windowsCommandLine).toContain('pnpm.cmd');
      expect(runner.lastOptions?.args?.at(-1)).toContain('--watch=false');
    } else {
      expect(runner.lastOptions?.command).toBe('pnpm');
      expect(runner.lastOptions?.args).toEqual(['run', 'test', '--', '--watch=false']);
    }
  });

  it('detects fixed pytest, Cargo, Go, and dotnet commands', async () => {
    const service = new TestService(new RecordingRunner(successResult()));

    const pytest = await temporaryWorkspace();
    await writeFile(path.join(pytest, 'pytest.ini'), '[pytest]');
    expect((await service.detectCommand(pytest))?.args).toEqual(['-m', 'pytest']);

    const cargo = await temporaryWorkspace();
    await writeFile(path.join(cargo, 'Cargo.toml'), '[package]');
    expect(await service.detectCommand(cargo)).toMatchObject({ command: 'cargo', args: ['test'] });

    const go = await temporaryWorkspace();
    await writeFile(path.join(go, 'go.mod'), 'module example.test/project');
    expect(await service.detectCommand(go)).toMatchObject({ command: 'go', args: ['test', './...'] });

    const dotnet = await temporaryWorkspace();
    await writeFile(path.join(dotnet, 'Example.sln'), '');
    expect(await service.detectCommand(dotnet)).toMatchObject({ command: 'dotnet' });
  });

  it('runs a package build when no test command is available', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'echo "Error: no test specified" && exit 1',
          build: 'vite build'
        },
        packageManager: 'pnpm@10.0.0'
      })
    );
    const runner = new RecordingRunner(successResult());
    const service = new TestService(runner);

    const result = await service.execute(workspace);

    expect(result).toMatchObject({
      exitCode: 0,
      executed: true,
      verificationKind: 'build',
      summary: 'Build passed.'
    });
    if (process.platform === 'win32') {
      expect((runner.lastOptions?.args?.at(-1) ?? '').toLowerCase()).toContain('"run" "build"');
    } else {
      expect(runner.lastOptions?.args).toEqual(['run', 'build']);
    }
  });

  it('prefers a declared Angular test target over its build target', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({}));
    await writeFile(
      path.join(workspace, 'angular.json'),
      JSON.stringify({ projects: { app: { architect: { build: {}, test: {} } } } })
    );
    const service = new TestService(new RecordingRunner(successResult()));

    const command = await service.detectCommand(workspace);

    expect(command).toMatchObject({
      kind: 'test',
      description: expect.stringContaining('Angular CLI tests')
    });
  });

  it('returns an UNVERIFIED success when no supported command exists', async () => {
    const workspace = await temporaryWorkspace();
    await mkdir(path.join(workspace, 'src'));
    const runner = new RecordingRunner(successResult());
    const service = new TestService(runner);

    const result = await service.execute(workspace);

    expect(result).toMatchObject({
      exitCode: 0,
      executed: false,
      verificationKind: 'none'
    });
    expect(result.summary).toContain('UNVERIFIED');
    expect(result.summary).toContain('No supported test or build command');
    expect(runner.lastOptions).toBeUndefined();
  });

  it('returns UNVERIFIED when a detected command cannot be started', async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ scripts: { build: 'vite build' } })
    );
    const runner: ProcessRunnerLike = {
      run: async () => { throw new Error('spawn npm ENOENT'); }
    };
    const service = new TestService(runner);

    const result = await service.execute(workspace);

    expect(result).toMatchObject({
      exitCode: 0,
      executed: false,
      verificationKind: 'none'
    });
    expect(result.summary).toContain('UNVERIFIED');
    expect(result.summary).toContain('could not be started');
  });

  it.runIf(process.platform === 'win32')(
    'executes a resolved npm.cmd shim with shell:false',
    async () => {
      const workspace = await temporaryWorkspace();
      const fakeBin = path.join(workspace, 'fake-bin');
      await mkdir(fakeBin);
      await writeFile(
        path.join(fakeBin, 'npm.cmd'),
        '@echo off\r\necho shim-ok\r\nexit /b 0\r\n'
      );
      await writeFile(
        path.join(workspace, 'package.json'),
        JSON.stringify({ scripts: { test: 'unused-by-fake-shim' } })
      );
      await writeFile(path.join(workspace, 'package-lock.json'), '{}');
      const service = new TestService(new ProcessRunner(), { timeoutMs: 10_000 });
      const originalPath = process.env['PATH'];
      process.env['PATH'] = `${fakeBin}${path.delimiter}${originalPath ?? ''}`;
      try {
        const result = await service.execute(workspace);

        expect(result.exitCode, JSON.stringify(result)).toBe(0);
        expect(result.stdout).toContain('shim-ok');
      } finally {
        process.env['PATH'] = originalPath;
      }
    }
  );
});

class RecordingRunner implements ProcessRunnerLike {
  public lastOptions: ProcessRunOptions | undefined;

  public constructor(private readonly result: ProcessResult) {}

  public async run(options: ProcessRunOptions): Promise<ProcessResult> {
    this.lastOptions = options;
    return this.result;
  }
}

function successResult(): ProcessResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false
  };
}

async function temporaryWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'orchestrator-test-service-'));
  temporaryPaths.push(workspace);
  return workspace;
}
