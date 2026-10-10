import { contextBridge, ipcRenderer } from 'electron';
import type { FeedMessage, LogEntry } from '../shared/types.ts';
import type { AppStatus, RendererApi } from '../shared/ipc.ts';
import { Channel } from '../shared/ipc.ts';

/**
 * preload 只做两件事：把白名单方法挂到 window，以及把主进程推送转成回调。
 * 绝不暴露 ipcRenderer 本身，否则渲染进程可以调用任意通道。
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: RendererApi = {
  getStatus: () => ipcRenderer.invoke(Channel.status) as Promise<AppStatus>,
  getSettings: () => ipcRenderer.invoke(Channel.settingsGet),
  saveSettings: (edit) => ipcRenderer.invoke(Channel.settingsSave, edit),
  connect: () => ipcRenderer.invoke(Channel.connect),
  disconnect: () => ipcRenderer.invoke(Channel.disconnect),
  send: (request) => ipcRenderer.invoke(Channel.send, request),
  testModel: (request) => ipcRenderer.invoke(Channel.modelTest, request),
  resetSessions: () => ipcRenderer.invoke(Channel.sessionsReset),
  sidecarAction: (action) => ipcRenderer.invoke(Channel.sidecar, action) as Promise<AppStatus>,
  searchPlugins: (request) => ipcRenderer.invoke(Channel.pluginSearch, request),
  installedPlugins: () => ipcRenderer.invoke(Channel.pluginInstalled),
  installPlugin: (ref) => ipcRenderer.invoke(Channel.pluginInstall, ref),
  uninstallPlugin: (module) => ipcRenderer.invoke(Channel.pluginUninstall, module),
  prepareEnv: () => ipcRenderer.invoke(Channel.envPrepare),
  recentLogs: () => ipcRenderer.invoke(Channel.logsRecent) as Promise<LogEntry[]>,
  recentFeed: () => ipcRenderer.invoke(Channel.feedRecent) as Promise<FeedMessage[]>,
  onFeed: (listener) => subscribe(Channel.feedPush, listener),
  onLog: (listener) => subscribe(Channel.logPush, listener),
  onStatus: (listener) => subscribe(Channel.statusPush, listener),
};

contextBridge.exposeInMainWorld('qqbot', api);
