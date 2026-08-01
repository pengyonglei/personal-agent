import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { createWebServer } from '@personal-agent/web';

const APP_USER_MODEL_ID = 'com.squirrel.PersonalAgent.PersonalAgent';
const SELECT_DIRECTORY_CHANNEL = 'desktop:select-directory';
const mainDirectory = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let closeWebServer: (() => Promise<void>) | undefined;
let shutdownStarted = false;

app.enableSandbox();
app.setAppUserModelId(APP_USER_MODEL_ID);

if (squirrelStartup) {
  app.quit();
} else {
  startDesktopApplication();
}

function startDesktopApplication(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  ipcMain.handle(SELECT_DIRECTORY_CHANNEL, async (event, suggestedPath?: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('目录选择请求来源无效');
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择本地根目录',
      defaultPath: resolveDirectoryPickerDefaultPath(suggestedPath),
      properties: ['openDirectory', 'dontAddToRecent'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  app.on('before-quit', (event) => {
    if (!closeWebServer || shutdownStarted) return;
    event.preventDefault();
    shutdownStarted = true;
    void closeWebServer()
      .catch((error) => console.error('[desktop] Failed to close Web runtime:', error))
      .finally(() => {
        closeWebServer = undefined;
        app.quit();
      });
  });

  app.on('window-all-closed', () => app.quit());

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
      return;
    }
    void createDesktopWindow().catch(handleStartupError);
  });

  void app.whenReady().then(createDesktopWindow).catch(handleStartupError);
}

async function createDesktopWindow(): Promise<void> {
  if (mainWindow) return;

  const dataDirectory = join(app.getPath('userData'), 'agent-data');
  await mkdir(dataDirectory, { recursive: true });

  const clientBuildDirectory = app.isPackaged
    ? join(process.resourcesPath, 'client')
    : resolve(mainDirectory, '../../web/dist/client');
  if (!existsSync(join(clientBuildDirectory, 'index.html'))) {
    throw new Error(`找不到桌面页面资源：${clientBuildDirectory}`);
  }

  const authToken = randomBytes(32).toString('hex');
  const web = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    authToken,
    workingDirectory: app.getPath('documents'),
    configPath: join(dataDirectory, 'config.yaml'),
    projectStoragePath: join(dataDirectory, 'projects.json'),
    sessionsDirectory: join(dataDirectory, 'sessions'),
    clientBuildDirectory,
  });
  closeWebServer = web.close;

  const applicationOrigin = `http://${web.host}:${web.port}`;
  const window = new BrowserWindow({
    title: 'Personal Agent',
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f7f1',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: join(mainDirectory, 'preload.cjs'),
    },
  });
  mainWindow = window;

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isApplicationUrl(url, applicationOrigin)) return;
    event.preventDefault();
    openExternalUrl(url);
  });

  const pageUrl = new URL(applicationOrigin);
  pageUrl.searchParams.set('token', authToken);
  await window.loadURL(pageUrl.toString());
}

function resolveDirectoryPickerDefaultPath(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    const candidate = resolve(value.trim());
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Fall back to the user's Documents directory for invalid or inaccessible paths.
    }
  }
  return app.getPath('documents');
}

function isApplicationUrl(value: string, applicationOrigin: string): boolean {
  try {
    return new URL(value).origin === applicationOrigin;
  } catch {
    return false;
  }
}

function openExternalUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      void shell.openExternal(url.toString());
    }
  } catch {
    // Ignore malformed URLs emitted by untrusted page content.
  }
}

async function handleStartupError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error('[desktop] Startup failed:', message);
  dialog.showErrorBox('Personal Agent 启动失败', message);
  const close = closeWebServer;
  closeWebServer = undefined;
  if (close) {
    await close().catch((closeError) =>
      console.error('[desktop] Failed to close Web runtime after startup error:', closeError),
    );
  }
  app.quit();
}
