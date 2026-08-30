import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface CodexCommandResolverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Resolves installations that are visible to an interactive PowerShell session
 * but absent from the smaller PATH inherited by an Electron app launched from
 * Explorer. Other platforms keep using normal PATH lookup.
 */
export async function resolveCodexCommand(
  options: CodexCommandResolverOptions = {}
): Promise<string> {
  const env = options.env ?? process.env;
  const configuredCommand = env['CODEX_BIN']?.trim();
  if (configuredCommand) {
    return configuredCommand;
  }

  if ((options.platform ?? process.platform) !== 'win32') {
    return 'codex';
  }

  const localAppData = env['LOCALAPPDATA']?.trim();
  if (!localAppData) {
    return 'codex';
  }

  const binDirectory = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const candidates = [path.join(binDirectory, 'codex.exe')];

  try {
    const entries = await readdir(binDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        candidates.push(path.join(binDirectory, entry.name, 'codex.exe'));
      }
    }
  } catch {
    return 'codex';
  }

  const installed: Array<{ command: string; modifiedAt: number }> = [];
  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate);
      if (metadata.isFile()) {
        installed.push({ command: candidate, modifiedAt: metadata.mtimeMs });
      }
    } catch {
      // Installation directories can contain stale version folders.
    }
  }

  installed.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return installed[0]?.command ?? 'codex';
}
