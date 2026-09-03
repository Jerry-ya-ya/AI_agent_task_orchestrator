import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchestratorRuntime } from '../backend/runtime.js';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
let runtime: OrchestratorRuntime | null = null;
let mainWindow: BrowserWindow | null = null;
let quittingAfterShutdown = false;
let shutdownPromise: Promise<void> | null = null;

Menu.setApplicationMenu(null);

ipcMain.handle('window:close', (event) => {
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  if (browserWindow === null || browserWindow.isDestroyed()) {
    return false;
  }
  browserWindow.close();
  return true;
});

ipcMain.handle('window:minimize', (event) => {
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  if (browserWindow === null || browserWindow.isDestroyed()) {
    return false;
  }
  browserWindow.minimize();
  return true;
});

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
  const browserWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: 'AI Agent Task Orchestrator',
    frame: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f6f8',
    webPreferences: {
      preload: join(currentDirectory, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  mainWindow = browserWindow;
  browserWindow.once('ready-to-show', () => {
    browserWindow.show();
    browserWindow.focus();
  });
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  browserWindow.webContents.on('will-navigate', (event, url) => {
    const allowedOrigins = [new URL(apiUrl).origin, 'http://127.0.0.1:4300'];
    if (!allowedOrigins.includes(new URL(url).origin)) {
      event.preventDefault();
    }
  });
  browserWindow.on('closed', () => {
    if (mainWindow === browserWindow) {
      mainWindow = null;
    }
  });

  const developmentUrl = process.env['ORCHESTRATOR_DEV_URL'];
  if (developmentUrl !== undefined) {
    const url = new URL(developmentUrl);
    url.searchParams.set('apiBaseUrl', apiUrl);
    await browserWindow.loadURL(url.toString());
  } else {
    await browserWindow.loadURL(apiUrl);
  }
  if (!browserWindow.isDestroyed() && !browserWindow.isVisible()) {
    browserWindow.show();
    browserWindow.focus();
  }
}

async function shutdown(): Promise<void> {
  mainWindow?.hide();
  if (runtime !== null) {
    await runtime.stop();
    runtime = null;
  }
}
