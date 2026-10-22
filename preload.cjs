const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('newMassGenDesktop', Object.freeze({
  chooseOutputFolder: () => ipcRenderer.invoke('choose-output-folder')
}));
