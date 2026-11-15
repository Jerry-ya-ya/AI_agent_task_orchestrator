import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { lockRuntimeDatabase } from './database/runtime-lock.js';
import { OrchestratorRuntime } from './runtime.js';

async function migrateDesktopData(dataDirectory: string, legacyDirectory: string): Promise<void> {
  const oldDatabase = join(legacyDirectory, 'orchestrator.sqlite');
  const oldConnections = join(legacyDirectory, 'connections.json');
  const hasDatabase = existsSync(oldDatabase);
  const hasConnections = existsSync(oldConnections);
  if (existsSync(dataDirectory) || (!hasDatabase && !hasConnections)) return;

  // A SQLite backup includes committed changes still in the write-ahead log.
  await mkdir(dirname(dataDirectory), { recursive: true });
  const staging = await mkdtemp(join(dirname(dataDirectory), 'migration-'));
  try {
    if (hasDatabase) {
      const source = new DatabaseSync(oldDatabase, { readOnly: true });
      try {
        await backup(source, join(staging, 'orchestrator.sqlite'));
      } finally {
        source.close();
      }
    }
    if (hasConnections) await copyFile(oldConnections, join(staging, 'connections.json'));
    await rename(staging, dataDirectory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [dataDirectory, legacyDirectory, worklogPath] = process.argv.slice(2);
  if (!dataDirectory || !legacyDirectory || !worklogPath) {
    throw new Error('Expected desktop data, legacy data and worklog paths.');
  }
  await migrateDesktopData(dataDirectory, legacyDirectory);
  const token = randomBytes(32).toString('hex');
  const databasePath = resolve(process.env['ORCHESTRATOR_DATABASE_PATH'] ?? join(dataDirectory, 'orchestrator.sqlite'));
  const unlock = lockRuntimeDatabase(databasePath);
  let runtime: OrchestratorRuntime | undefined;
  try {
    runtime = new OrchestratorRuntime({ databasePath, worklogPath, desktopToken: token });
    const baseUrl = await runtime.start();
    process.stdout.write(`${JSON.stringify({ baseUrl, token })}\n`);
    // The parent holds the write end open. EOF also stops the worker after a parent crash.
    await new Promise<void>((resolve, reject) => {
      process.stdin.once('end', resolve);
      process.stdin.once('error', reject);
      process.stdin.resume();
    });
  } finally {
    try { await runtime?.stop(); } finally { unlock(); }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
