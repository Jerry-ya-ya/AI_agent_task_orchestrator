import { app, BrowserWindow, dialog, shell } from 'electron';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchestratorRuntime } from '../backend/runtime.js';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
let runtime: OrchestratorRuntime | null = null;
let mainWindow: BrowserWindow | null = null;
let quittingAfterShutdown = false;
let shutdownPromise: Promise<void> | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const uiPath = resolve(currentDirectory, '../../frontend/browser');
      runtime = new OrchestratorRuntime({
        databasePath: join(app.getPath('userData'), 'data', 'orchestrator.sqlite'),
        uiPath
      });
      const apiUrl = await runtime.start();
      await createWindow(apiUrl);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      dialog.showErrorBox('AI Agent Task Orchestrator failed to start', message);
      quittingAfterShutdown = true;
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && runtime !== null) {
      void createWindow(runtime.baseUrl);
    }
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (quittingAfterShutdown) {
      return;
    }
    event.preventDefault();
    if (shutdownPromise === null) {
      shutdownPromise = shutdown().finally(() => {
        quittingAfterShutdown = true;
        app.quit();
      });
    }
  });
}

async function createWindow(apiUrl: string): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: 'AI Agent Task Orchestrator',
    backgroundColor: '#f4f6f8',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedOrigins = [new URL(apiUrl).origin, 'http://127.0.0.1:4300'];
    if (!allowedOrigins.includes(new URL(url).origin)) {
      event.preventDefault();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const developmentUrl = process.env['ORCHESTRATOR_DEV_URL'];
  if (developmentUrl !== undefined) {
    const url = new URL(developmentUrl);
    url.searchParams.set('apiBaseUrl', apiUrl);
    await mainWindow.loadURL(url.toString());
  } else {
    await mainWindow.loadURL(apiUrl);
  }
}

async function shutdown(): Promise<void> {
  mainWindow?.hide();
  if (runtime !== null) {
    await runtime.stop();
    runtime = null;
  }
}
