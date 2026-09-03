import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktopWindow', {
  minimize: (): Promise<boolean> => ipcRenderer.invoke('window:minimize'),
  close: (): Promise<boolean> => ipcRenderer.invoke('window:close'),
});
