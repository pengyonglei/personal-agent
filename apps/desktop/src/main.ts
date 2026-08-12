import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from 'electron';
import { createWebServer } from '@personal-agent/web';

// electron-updater 为 CJS 包且由 esbuild 标记 external：
// 运行时通过 build.mjs 注入的 __require（createRequire）加载，避免 ESM/CJS interop 问题。
declare const __require: (id: string) => unknown;
const electronUpdater = __require('electron-updater') as typeof import('electron-updater');

const APP_USER_MODEL_ID = 'com.personal-agent.desktop';
const SELECT_DIRECTORY_CHANNEL = 'desktop:select-directory';
const TOGGLE_DEVTOOLS_CHANNEL = 'desktop:toggle-devtools';
const OPEN_PATH_CHANNEL = 'desktop:open-path';
const mainDirectory = dirname(fileURLToPath(import.meta.url));

// Preload 脚本缺失会导致 window.personalAgentDesktop 不可用
//（桌面端原生目录选择器失效，前端静默回退到 Web 目录树）。
// 启动时显式检查并打印，便于排查。
const preloadPath = join(mainDirectory, 'preload.cjs');
if (!existsSync(preloadPath)) {
  console.error(`[desktop] preload script not found: ${preloadPath}`);
} else {
  console.log(`[desktop] preload ready: ${preloadPath}`);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let closeWebServer: (() => Promise<void>) | undefined;
let shutdownStarted = false;
let quitRequested = false;

app.enableSandbox();
app.setAppUserModelId(APP_USER_MODEL_ID);

startDesktopApplication();

function startDesktopApplication(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    showMainWindow();
  });

  ipcMain.handle(SELECT_DIRECTORY_CHANNEL, async (event, suggestedPath?: unknown) => {
    if (!mainWindow) return null;
    // 来源校验仅警告不阻断：sender 不匹配时仍尝试用主窗口弹窗，
    // 避免严格校验导致目录选择静默失败
    if (event.sender !== mainWindow.webContents) {
      console.warn('[desktop] select-directory: unexpected sender, falling back to main window');
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择本地根目录',
      defaultPath: resolveDirectoryPickerDefaultPath(suggestedPath),
      properties: ['openDirectory', 'dontAddToRecent'],
    });
    console.log(
      '[desktop] select-directory:',
      result.canceled ? 'cancelled' : `picked ${JSON.stringify(result.filePaths)}`,
    );
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(TOGGLE_DEVTOOLS_CHANNEL, (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const webContents = mainWindow.webContents;
    if (webContents.isDevToolsOpened()) {
      webContents.closeDevTools();
    } else {
      webContents.openDevTools({ mode: 'detach' });
    }
  });

  ipcMain.handle(OPEN_PATH_CHANNEL, async (event, targetPath?: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return 'Unauthorized';
    if (typeof targetPath !== 'string' || targetPath.length === 0) {
      return '无效的目录路径';
    }
    // shell.openPath 返回空字符串表示成功，否则返回错误信息
    const errorMessage = await shell.openPath(targetPath);
    return errorMessage || null;
  });

  app.on('before-quit', (event) => {
    quitRequested = true;
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

  // Keep the process and local Web runtime alive while the main window is hidden in the tray.
  app.on('window-all-closed', () => undefined);

  app.on('activate', () => {
    if (mainWindow) {
      showMainWindow();
      return;
    }
    void createDesktopWindow().catch(handleStartupError);
  });

  void app
    .whenReady()
    .then(() => createDesktopWindow())
    .then(() => setupAutoUpdater())
    .catch(handleStartupError);
}

async function createDesktopWindow(): Promise<void> {
  if (mainWindow) return;

  // desktop shares ~/.personal-agent/ with CLI/web: config.yaml, projects.json,
  // sessions and everything else live under the same root directory.
  const dataDirectory = join(app.getPath('home'), '.personal-agent');
  await mkdir(dataDirectory, { recursive: true });
  // One-time migration from the legacy Electron userData/agent-data directory.
  await migrateLegacyDataDirectory(join(app.getPath('userData'), 'agent-data'), dataDirectory);

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
    icon: getDesktopIconPath(),
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
  window.on('close', (event) => {
    if (quitRequested) return;
    event.preventDefault();
    window.hide();
  });
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

  // F12 / Ctrl+Shift+I：切换开发者工具（生产构建默认无菜单快捷键）
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isCtrlShiftI = input.control && input.shift && input.key.toLowerCase() === 'i';
    if (!isF12 && !isCtrlShiftI) return;
    event.preventDefault();
    const webContents = window.webContents;
    if (webContents.isDevToolsOpened()) {
      webContents.closeDevTools();
    } else {
      webContents.openDevTools({ mode: 'detach' });
    }
  });

  const pageUrl = new URL(applicationOrigin);
  pageUrl.searchParams.set('token', authToken);
  await window.loadURL(pageUrl.toString());
  createTray();
}

function showMainWindow(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createTray(): void {
  if (tray) return;

  const iconPath = getDesktopIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.error(`[desktop] tray icon could not be loaded: ${iconPath}`);
    return;
  }

  tray = new Tray(icon);
  tray.setToolTip('Personal Agent');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: showMainWindow,
      },
      { type: 'separator' },
      {
        label: '退出 Personal Agent',
        click: () => {
          quitRequested = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function getDesktopIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tray-icon.ico')
    : resolve(mainDirectory, '../build/icon.ico');
}

/**
 * 自动更新（electron-updater + Gitee Release）：
 * 仅打包版启用（开发模式无 app-update.yml）；启动 15 秒后首次检查，之后每 6 小时轮询；
 * 发现新版本后台自动下载，完成后弹系统通知，点击一键重启安装；
 * 所有失败仅记录日志，不阻塞正常使用。
 */
function setupAutoUpdater(): void {
  if (!app.isPackaged) return;

  const updater = electronUpdater.autoUpdater;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  updater.on('update-available', (info) => {
    console.log(`[desktop] update available: ${info.version}`);
  });

  updater.on('update-not-available', () => {
    console.log('[desktop] update not available');
  });

  updater.on('update-downloaded', (info) => {
    console.log(`[desktop] update downloaded: ${info.version}`);
    const notification = new Notification({
      title: 'Personal Agent 更新已就绪',
      body: `新版本 v${info.version} 已下载完成，点击立即重启安装。`,
    });
    notification.on('click', () => {
      notification.close();
      updater.quitAndInstall();
    });
    notification.show();
  });

  updater.on('error', (error) => {
    console.error('[desktop] auto update error:', error instanceof Error ? error.message : error);
  });

  const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const checkForUpdates = () =>
    updater.checkForUpdates().catch((error) => {
      console.error(
        '[desktop] checkForUpdates failed:',
        error instanceof Error ? error.message : error,
      );
    });

  setTimeout(() => void checkForUpdates(), 15_000);
  setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
}

/**
 * Migrates config files from the legacy Electron userData/agent-data directory
 * to ~/.personal-agent/ in one shot. Only moves entries that do not already
 * exist at the target so fresh data is never overwritten.
 */
async function migrateLegacyDataDirectory(
  oldDirectory: string,
  newDirectory: string,
): Promise<void> {
  if (oldDirectory === newDirectory) return;
  const legacyEntries = [
    { name: 'config.yaml', recursive: false },
    { name: 'projects.json', recursive: false },
    { name: 'sessions', recursive: true },
  ] as const;
  for (const entry of legacyEntries) {
    const oldPath = join(oldDirectory, entry.name);
    const newPath = join(newDirectory, entry.name);
    if (!existsSync(oldPath) || existsSync(newPath)) continue;
    try {
      await rename(oldPath, newPath);
      console.log(`[desktop] migrated ${oldPath} -> ${newPath}`);
    } catch (error) {
      // Cross-device (EXDEV) failures fall back to copy + delete.
      try {
        await cp(oldPath, newPath, { recursive: entry.recursive });
        await rm(oldPath, { recursive: entry.recursive, force: true });
        console.log(`[desktop] migrated (copy) ${oldPath} -> ${newPath}`);
      } catch (copyError) {
        console.warn(`[desktop] failed to migrate ${oldPath}:`, copyError);
      }
    }
  }
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
