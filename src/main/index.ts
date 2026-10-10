import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NsbPlugin } from './plugins/registry.ts';
import { Backend } from './app.ts';
import { registerIpc } from './ipc.ts';
import { SettingsStore, type SecretCodec } from './store.ts';
import { makeRunner, makeSpawner } from './process.ts';

const REGISTRY_CACHE = 'registry-cache.json';

function codec(): SecretCodec {
  try {
    return {
      available: safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    };
  } catch {
    return { available: false, encrypt: (value) => value, decrypt: () => '' };
  }
}

/** 打包后侧车随 asar 外资源走，开发时直接用仓库里的 sidecar/ */
function sidecarDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'sidecar') : join(app.getAppPath(), 'sidecar');
}

function readCache(path: string): NsbPlugin[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as NsbPlugin[]) : [];
  } catch {
    return [];
  }
}

let mainWindow: BrowserWindow | null = null;
let backend: Backend | null = null;

// 两个实例会抢同一个监听端口并让 NapCat 连到错误的进程上
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    const dataDir = app.getPath('userData');
    mkdirSync(dataDir, { recursive: true });

    backend = new Backend({
      store: new SettingsStore({ dir: () => dataDir, codec: codec(), log: (level, text) => console.log(`[${level}] ${text}`) }),
      version: app.getVersion(),
      dataDir: () => dataDir,
      sidecarDir,
      platform: process.platform,
      exists: (p) => existsSync(p),
      readText: (p) => readFileSync(p, 'utf8'),
      writeText: (p, text) => {
        writeFileSync(p, text, 'utf8');
      },
      spawn: makeSpawner(),
      run: makeRunner(),
      send: (channel, payload) => {
        if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
      },
      readRegistryCache: () => readCache(join(dataDir, REGISTRY_CACHE)),
      writeRegistryCache: (list) => {
        try {
          writeFileSync(join(dataDir, REGISTRY_CACHE), JSON.stringify(list), 'utf8');
        } catch {
          // 缓存写失败不要紧，下次还能重新拉
        }
      },
    });

    registerIpc(ipcMain, backend);

    // 渲染进程里全是群聊原文，任何设备/权限请求都不该批准
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    mainWindow = new BrowserWindow({
      width: 1_180,
      height: 820,
      minWidth: 900,
      minHeight: 600,
      title: 'QQ 机器人桌面端',
      backgroundColor: '#15171c',
      show: false,
      webPreferences: {
        preload: join(__dirname, '..', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
      },
    });
    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      console.log(`[warn] 已阻止页面跳转到 ${url}`);
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      console.log(`[warn] 已阻止新开窗口：${url}`);
      return { action: 'deny' };
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
    void backend.connect();
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

// 关窗前先把侧车子进程和监听端口释放掉，否则下次启动会撞上自己占的端口
app.on('before-quit', (event) => {
  const service = backend;
  if (service === null) return;
  event.preventDefault();
  backend = null;
  void service.shutdown().finally(() => app.quit());
});
