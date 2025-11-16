import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { Controller } from './main/controller';
import { ProcessManager } from './main/process-manager';

let mainWindow: BrowserWindow | null = null;
let controller: Controller | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'XL Converter',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

  controller = new Controller(mainWindow);

  mainWindow.on('closed', () => {
    if (controller) {
      ProcessManager.terminateAll();
    }
    mainWindow = null;
    controller = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('convert:start', async (event, data) => {
  if (!controller) {
    return { success: false, error: 'Controller not initialized' };
  }

  try {
    void controller.startProcessing(data).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      event.sender.send('convert:error', { message });
    });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    event.sender.send('convert:error', { message });
    return { success: false, error: message };
  }
});

ipcMain.handle('convert:cancel', async () => {
  if (!controller) return;
  controller.cancel();
});

ipcMain.handle('dialog:openFiles', async () => {
  if (!mainWindow) return [];
  
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'jxl', 'avif', 'gif', 'bmp', 'tiff'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  return result.filePaths;
});

ipcMain.handle('dialog:openDirectory', async () => {
  if (!mainWindow) return null;
  
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });

  return result.filePaths[0] || null;
});
