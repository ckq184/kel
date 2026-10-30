import { contextBridge, ipcRenderer } from 'electron';

export interface CkqclawDesktopConfig {
  appName: string;
  version: string;
  serverUrl: string;
  rendererUrl: string;
  isPackaged: boolean;
}

export interface CkqclawDesktopAPI {
  getConfig(): Promise<CkqclawDesktopConfig>;
  openExternal(url: string): Promise<void>;
  retry(): Promise<void>;
  reload(): void;
  showAbout(): Promise<void>;
}

const api: CkqclawDesktopAPI = {
  getConfig: () => ipcRenderer.invoke('desktop:get-config'),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  reload: () => ipcRenderer.send('desktop:reload'),
  showAbout: () => ipcRenderer.invoke('desktop:show-about'),
};

contextBridge.exposeInMainWorld('ckqclawDesktop', api);
