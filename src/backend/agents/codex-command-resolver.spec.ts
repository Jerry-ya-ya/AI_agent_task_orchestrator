import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveCodexCommand } from './codex-command-resolver.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map(async (entry) => await rm(entry, { recursive: true, force: true }))
  );
});

describe('resolveCodexCommand', () => {
  it('honors an explicit CODEX_BIN override', async () => {
    await expect(
      resolveCodexCommand({ env: { CODEX_BIN: 'C:\\Tools\\codex.exe' }, platform: 'win32' })
    ).resolves.toBe('C:\\Tools\\codex.exe');
  });

  it('finds a versioned Windows Codex installation outside PATH', async () => {
    const localAppData = await mkdtemp(path.join(tmpdir(), 'orchestrator-local-app-data-'));
    temporaryPaths.push(localAppData);
    const executable = path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'release-id', 'codex.exe');
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, 'test executable placeholder');

    await expect(
      resolveCodexCommand({ env: { LOCALAPPDATA: localAppData }, platform: 'win32' })
    ).resolves.toBe(executable);
  });

  it('falls back to PATH lookup when no Windows installation is present', async () => {
    await expect(resolveCodexCommand({ env: {}, platform: 'win32' })).resolves.toBe('codex');
  });
});
