import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell, type OpenDialogOptions } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchestratorRuntime } from '../backend/runtime.js';

const currentDirectory = fileURLToPath(new URL('.', import.meta.url));
let runtime: OrchestratorRuntime | null = null;
let mainWindow: BrowserWindow | null = null;
let quittingAfterShutdown = false;
let shutdownPromise: Promise<void> | null = null;
const APP_PAGES = new Set(['features', 'taskboard', 'history', 'settings']);
const APP_ICONS = new Set(['original', 'violet', 'ember', 'frost']);
const iconDirectory = app.isPackaged
  ? resolve(currentDirectory, '../../frontend/browser')
  : resolve(currentDirectory, '../../../src/frontend/public');
let selectedWindowIcon = 'original';

function iconPath(id: string): string {
  const name = id === 'original' ? 'icon' : `icon-${id}`;
  return join(iconDirectory, `${name}.${process.platform === 'win32' ? 'ico' : 'png'}`);
}

type AppPage = 'features' | 'taskboard' | 'history' | 'settings';

interface WindowPlacement {
  x: number;
  y: number;
}

Menu.setApplicationMenu(null);
if (process.platform === 'win32') app.setAppUserModelId('dev.local.ai-agent-task-orchestrator');

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

ipcMain.handle('window:set-icon', (_event, candidate: unknown) => {
  if (typeof candidate !== 'string' || !APP_ICONS.has(candidate)) return false;
  const selectedPath = iconPath(candidate);
  if (!existsSync(selectedPath)) return false;
  selectedWindowIcon = candidate;
  if (process.platform === 'darwin') {
    app.dock?.setIcon(selectedPath);
  } else {
    BrowserWindow.getAllWindows().forEach((browserWindow) => {
      if (!browserWindow.isDestroyed()) browserWindow.setIcon(selectedPath);
    });
  }
  return true;
});

ipcMain.handle('project:choose-repository', async (event, suggestedPath: unknown): Promise<string | null> => {
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  const defaultPath = typeof suggestedPath === 'string' && suggestedPath.trim().length > 0
    ? suggestedPath.trim()
    : undefined;
  const options: OpenDialogOptions = {
    title: 'Choose a local Git repository',
    defaultPath,
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = browserWindow === null
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(browserWindow, options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle('window:open-page', async (_event, request: unknown) => {
  if (runtime === null || typeof request !== 'object' || request === null) return false;
  const candidate = request as Record<string, unknown>;
  if (typeof candidate['page'] !== 'string' || !APP_PAGES.has(candidate['page'])) return false;
  if (typeof candidate['screenX'] !== 'number' || !Number.isFinite(candidate['screenX'])
    || typeof candidate['screenY'] !== 'number' || !Number.isFinite(candidate['screenY'])) return false;

  await createWindow(runtime.baseUrl, candidate['page'] as AppPage, {
    x: Math.round(candidate['screenX']),
    y: Math.round(candidate['screenY']),
  });
  return true;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const browserWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
    if (browserWindow !== null) {
      if (browserWindow.isMinimized()) {
        browserWindow.restore();
      }
      browserWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const uiPath = resolve(currentDirectory, '../../frontend/browser');
      runtime = new OrchestratorRuntime({
        databasePath: join(app.getPath('userData'), 'data', 'orchestrator.sqlite'),
        uiPath,
        // Keep the packaged renderer origin stable so its localStorage persists across launches.
        port: process.env['ORCHESTRATOR_DEV_URL'] === undefined ? 4317 : 0
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

async function createWindow(
  apiUrl: string,
  initialPage: AppPage = 'taskboard',
  placement?: WindowPlacement,
): Promise<void> {
  const width = 1180;
  const height = 780;
  const bounds = placement === undefined ? {} : detachedWindowBounds(placement, width, height);
  const browserWindow = new BrowserWindow({
    width: placement === undefined ? 1440 : width,
    height: placement === undefined ? 900 : height,
    ...bounds,
    minWidth: 980,
    minHeight: 680,
    title: 'AI Agent Task Orchestrator',
    icon: iconPath(selectedWindowIcon),
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
  if (mainWindow === null) mainWindow = browserWindow;
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
    url.searchParams.set('page', initialPage);
    await browserWindow.loadURL(url.toString());
  } else {
    const url = new URL(apiUrl);
    url.searchParams.set('page', initialPage);
    await browserWindow.loadURL(url.toString());
  }
  if (!browserWindow.isDestroyed() && !browserWindow.isVisible()) {
    browserWindow.show();
    browserWindow.focus();
  }
}

function detachedWindowBounds(placement: WindowPlacement, width: number, height: number): WindowPlacement {
  const display = screen.getDisplayNearestPoint(placement);
  const { workArea } = display;
  return {
    x: Math.min(Math.max(placement.x - 48, workArea.x), workArea.x + Math.max(0, workArea.width - width)),
    y: Math.min(Math.max(placement.y - 32, workArea.y), workArea.y + Math.max(0, workArea.height - height)),
  };
}

async function shutdown(): Promise<void> {
  mainWindow?.hide();
  if (runtime !== null) {
    await runtime.stop();
    runtime = null;
  }
}
