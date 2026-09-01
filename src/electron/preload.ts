import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktopWindow', {
  close: (): void => ipcRenderer.send('window:close'),
});
