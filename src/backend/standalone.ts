import { resolve } from 'node:path';
import { OrchestratorRuntime } from './runtime.js';

const port = Number.parseInt(process.env['ORCHESTRATOR_PORT'] ?? '4317', 10);
const databasePath = process.env['ORCHESTRATOR_DATABASE_PATH'] ?? resolve('.data', 'orchestrator.sqlite');
const configuredUiPath = process.env['ORCHESTRATOR_UI_PATH'];
const runtime = new OrchestratorRuntime({
  databasePath,
  port,
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
  await runtime.stop();
  process.exitCode = 0;
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
