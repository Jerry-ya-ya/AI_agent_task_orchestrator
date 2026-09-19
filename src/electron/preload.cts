import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktopWindow', {
  chooseRepository: (suggestedPath: string): Promise<string | null> =>
    ipcRenderer.invoke('project:choose-repository', suggestedPath),
  minimize: (): Promise<boolean> => ipcRenderer.invoke('window:minimize'),
  openPage: (page: string, screenX: number, screenY: number): Promise<boolean> =>
    ipcRenderer.invoke('window:open-page', { page, screenX, screenY }),
  setIcon: (icon: string): Promise<boolean> => ipcRenderer.invoke('window:set-icon', icon),
  close: (): Promise<boolean> => ipcRenderer.invoke('window:close'),
});
