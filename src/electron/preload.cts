import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktopWindow', {
  minimize: (): Promise<boolean> => ipcRenderer.invoke('window:minimize'),
  openPage: (page: string, screenX: number, screenY: number): Promise<boolean> =>
    ipcRenderer.invoke('window:open-page', { page, screenX, screenY }),
  close: (): Promise<boolean> => ipcRenderer.invoke('window:close'),
});
