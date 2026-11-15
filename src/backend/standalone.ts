import { resolve } from 'node:path';
import { lockRuntimeDatabase } from './database/runtime-lock.js';
import { OrchestratorRuntime } from './runtime.js';

const port = Number.parseInt(process.env['ORCHESTRATOR_PORT'] ?? '4317', 10);
const databasePath = resolve(process.env['ORCHESTRATOR_DATABASE_PATH'] ?? '.data/isolated.sqlite');
const unlock = lockRuntimeDatabase(databasePath);
const configuredUiPath = process.env['ORCHESTRATOR_UI_PATH'];
const runtime = new OrchestratorRuntime({
  databasePath,
  port,
  worklogPath: resolve('worklog.md'),
  uiPath: configuredUiPath === undefined ? undefined : resolve(configuredUiPath)
});

const baseUrl = await runtime.start();
console.log(`[orchestrator] API listening at ${baseUrl}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  try { await runtime.stop(); } finally { unlock(); }
  process.exitCode = 0;
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
