'use strict';

const { app, BrowserWindow, nativeTheme, session, shell } = require('electron');

const DEFAULT_APP_URL = 'https://siragpt.com';
const ALLOWED_HOSTS = new Set([
  'siragpt.com',
  'www.siragpt.com',
  'localhost',
  '127.0.0.1',
]);

function normaliseAppUrl(value) {
  const raw = String(value || '').trim() || DEFAULT_APP_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return DEFAULT_APP_URL;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return DEFAULT_APP_URL;
  if (!ALLOWED_HOSTS.has(url.hostname)) return DEFAULT_APP_URL;
  return url.toString();
}

function isAllowedAppUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function openExternalSafely(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return;
  shell.openExternal(url).catch(() => {});
}

function createMainWindow() {
  nativeTheme.themeSource = 'system';

  const win = new BrowserWindow({
    title: 'SiraGPT',
    width: 1280,
    height: 860,
    minWidth: 390,
    minHeight: 640,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      contextIsolation: true,
      devTools: !app.isPackaged || process.env.SIRAGPT_DESKTOP_DEVTOOLS === '1',
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedAppUrl(url)) return { action: 'allow' };
    openExternalSafely(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppUrl(url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });

  const startUrl = normaliseAppUrl(process.env.SIRAGPT_DESKTOP_URL);
  win.loadURL(startUrl).catch(() => {
    win.loadURL(DEFAULT_APP_URL).catch(() => {});
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = isAllowedAppUrl(webContents.getURL()) && ['media', 'notifications', 'clipboard-sanitized-write'].includes(permission);
    callback(allowed);
  });

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
