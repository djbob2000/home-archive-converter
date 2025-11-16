import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  convert: {
    start: (data: any) => ipcRenderer.invoke('convert:start', data),
    cancel: () => ipcRenderer.invoke('convert:cancel'),
    onProgress: (callback: (progress: any) => void) => {
      const listener = (_event: any, progress: any) => callback(progress);
      ipcRenderer.on('convert:progress', listener);
      return () => ipcRenderer.removeListener('convert:progress', listener);
    },
    onComplete: (callback: (result: any) => void) => {
      const listener = (_event: any, result: any) => callback(result);
      ipcRenderer.on('convert:complete', listener);
      return () => ipcRenderer.removeListener('convert:complete', listener);
    },
    onError: (callback: (error: any) => void) => {
      const listener = (_event: any, error: any) => callback(error);
      ipcRenderer.on('convert:error', listener);
      return () => ipcRenderer.removeListener('convert:error', listener);
    }
  },
  dialog: {
    openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory')
  }
});
