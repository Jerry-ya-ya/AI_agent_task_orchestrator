import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import electronPath from 'electron';

const projectRoot = process.cwd();
const compiledMainPath = path.join(projectRoot, 'dist', 'main');
const angularUrl = 'http://127.0.0.1:4300';
let electronProcess = null;
let restartTimer = null;
let restarting = false;
let stopping = false;
let watcher = null;
let electronStartedAt = 0;
let earlyExitRetries = 0;

await waitForAngular();
startElectron();

watcher = watch(compiledMainPath, { recursive: true }, (_eventType, filename) => {
  if (stopping || !filename || (!filename.endsWith('.js') && !filename.endsWith('.cjs'))) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restartElectron, 350);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

function startElectron() {
  electronStartedAt = Date.now();
  console.log('[electron-dev] Starting Electron...');
  electronProcess = spawn(electronPath, ['.'], {
    cwd: projectRoot,
    env: { ...process.env, ORCHESTRATOR_DEV_URL: angularUrl },
    stdio: 'inherit',
    windowsHide: true
  });
  electronProcess.once('exit', (code) => {
    electronProcess = null;
    if (restarting) {
      restarting = false;
      startElectron();
      return;
    }
    if (stopping) return;
    if (Date.now() - electronStartedAt < 3_000 && earlyExitRetries < 3) {
      earlyExitRetries += 1;
      console.warn(`[electron-dev] Electron exited before opening; retrying (${earlyExitRetries}/3)...`);
      setTimeout(startElectron, 500);
      return;
    }
    shutdown(code ?? 0);
  });
}

function restartElectron() {
  restartTimer = null;
  if (electronProcess === null) {
    earlyExitRetries = 0;
    startElectron();
    return;
  }
  restarting = true;
  electronProcess.kill();
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  watcher?.close();
  electronProcess?.kill();
  process.exitCode = code;
}

async function waitForAngular() {
  let consecutiveHealthyChecks = 0;
  while (true) {
    try {
      const response = await fetch(angularUrl, { cache: 'no-store' });
      consecutiveHealthyChecks = response.ok ? consecutiveHealthyChecks + 1 : 0;
      if (consecutiveHealthyChecks >= 2) return;
    } catch {
      consecutiveHealthyChecks = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
