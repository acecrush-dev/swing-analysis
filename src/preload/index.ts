import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  pickVideo: () => ipcRenderer.invoke('pick-video') as Promise<string | null>,
  getServiceInfo: () => ipcRenderer.invoke('get-service-info') as Promise<string | null>
});