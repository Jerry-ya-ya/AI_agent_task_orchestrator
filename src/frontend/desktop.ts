import type { HttpInterceptorFn } from '@angular/common/http';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface DesktopConnection {
  baseUrl: string;
  token: string;
}

export async function initializeDesktop(): Promise<HttpInterceptorFn[]> {
  if (!isTauri()) return [];

  const { baseUrl, token } = await invoke<DesktopConnection>('desktop_connection');
  const desktop = getCurrentWindow();
  window.desktopWindow = {
    apiBaseUrl: baseUrl,
    chooseRepository: (suggestedPath) => invoke('choose_repository', { suggestedPath }),
    startDragging: (toggleMaximize) => complete(
      toggleMaximize ? desktop.toggleMaximize() : desktop.startDragging(),
    ),
    minimize: () => complete(desktop.minimize()),
    close: () => complete(desktop.close()),
    openPage: (request) => complete(invoke('open_page', { request })),
    setIcon: (icon) => complete(invoke('set_window_icon', { icon })),
  };

  return [(request, next) => next(request.url.startsWith(`${baseUrl}/`)
    ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : request)];
}

async function complete(action: Promise<unknown>): Promise<boolean> {
  try {
    await action;
    return true;
  } catch (error: unknown) {
    console.error('Desktop window action failed.', error);
    return false;
  }
}
