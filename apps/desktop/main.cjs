'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  net,
  session,
  shell,
} = require('electron');
const {
  DEFAULT_APP_URL,
  compareVersions,
  deepLinkToAppUrl,
  isTrustedAppUrl,
  navigationDisposition,
  normaliseAppUrl,
  releasePlatform,
} = require('./runtime.cjs');

const PERMITTED_WEB_PERMISSIONS = new Set([
  'clipboard-sanitized-write',
  'media',
  'notifications',
]);
const WINDOW_STATE_FILE = 'window-state.json';
const UPDATE_ENDPOINT = 'https://siragpt.com/api/desktop/releases';

let mainWindow = null;
let oauthWindow = null;
let pendingDeepLink = null;
let saveWindowTimer = null;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function allowLocalhost() {
  return !app.isPackaged;
}

function openExternalSafely(value) {
  if (navigationDisposition(value, { allowLocalhost: allowLocalhost() }) !== 'external') return;
  shell.openExternal(value).catch(() => {});
}

function windowStatePath() {
  return path.join(app.getPath('userData'), WINDOW_STATE_FILE);
}

function readWindowState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 390 || height < 640) return {};
    return {
      width: Math.min(width, 2400),
      height: Math.min(height, 1600),
      ...(Number.isFinite(Number(parsed.x)) ? { x: Number(parsed.x) } : {}),
      ...(Number.isFinite(Number(parsed.y)) ? { y: Number(parsed.y) } : {}),
      maximized: Boolean(parsed.maximized),
    };
  } catch {
    return {};
  }
}

function persistWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
  const payload = JSON.stringify({ ...bounds, maximized: win.isMaximized() });
  const destination = windowStatePath();
  const temporary = `${destination}.tmp`;
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(temporary, payload, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function scheduleWindowStateSave(win) {
  clearTimeout(saveWindowTimer);
  saveWindowTimer = setTimeout(() => persistWindowState(win), 250);
}

function currentStartUrl() {
  return normaliseAppUrl(process.env.SIRAGPT_DESKTOP_URL, { allowLocalhost: allowLocalhost() });
}

function showOfflinePage(win, target = currentStartUrl()) {
  if (!win || win.isDestroyed()) return;
  const safeTarget = normaliseAppUrl(target, { allowLocalhost: allowLocalhost() });
  win.loadFile(path.join(__dirname, 'offline.html'), { query: { target: safeTarget } }).catch(() => {});
}

function configureNavigation(webContents, ownerWindow, options = {}) {
  webContents.on('will-attach-webview', (event) => event.preventDefault());

  const handleNavigation = (event, url) => {
    const disposition = navigationDisposition(url, { allowLocalhost: allowLocalhost() });
    if (disposition === 'app' || (options.allowOAuth && disposition === 'oauth')) return;
    event.preventDefault();
    if (disposition === 'oauth' && typeof options.onOAuth === 'function') {
      options.onOAuth(url);
      return;
    }
    openExternalSafely(url);
  };
  webContents.on('will-navigate', handleNavigation);
  webContents.on('will-redirect', handleNavigation);

  webContents.on('render-process-gone', () => {
    showOfflinePage(ownerWindow);
  });
}

function createOAuthWindow(parent, url) {
  if (oauthWindow && !oauthWindow.isDestroyed()) {
    oauthWindow.show();
    oauthWindow.focus();
    return;
  }

  const authWindow = new BrowserWindow({
    parent,
    width: 560,
    height: 760,
    minWidth: 420,
    minHeight: 620,
    show: false,
    title: 'Acceso a SiraGPT',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171717' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      devTools: !app.isPackaged || process.env.SIRAGPT_DESKTOP_DEVTOOLS === '1',
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  oauthWindow = authWindow;
  configureNavigation(authWindow.webContents, authWindow, { allowOAuth: true });
  authWindow.once('ready-to-show', () => authWindow.show());
  authWindow.webContents.on('did-navigate', (_event, nextUrl) => {
    if (!isTrustedAppUrl(nextUrl, { allowLocalhost: allowLocalhost() })) return;
    const nextPath = new URL(nextUrl).pathname;
    if (!nextPath.startsWith('/auth/callback')) return;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(nextUrl).catch(() => {});
    authWindow.close();
  });
  authWindow.on('closed', () => { if (oauthWindow === authWindow) oauthWindow = null; });
  authWindow.loadURL(url).catch(() => authWindow.close());
}

function handleOpenRequest(win, url) {
  const disposition = navigationDisposition(url, { allowLocalhost: allowLocalhost() });
  if (disposition === 'app') {
    win.loadURL(url).catch(() => {});
    return { action: 'deny' };
  }
  if (disposition === 'oauth') {
    createOAuthWindow(win, url);
    return { action: 'deny' };
  }
  openExternalSafely(url);
  return { action: 'deny' };
}

async function checkForUpdates(win, interactive = true) {
  const platform = releasePlatform(process.platform, process.arch);
  if (!platform) {
    if (interactive) await dialog.showMessageBox(win, { type: 'info', message: 'Actualizaciones no disponibles en esta plataforma.' });
    return;
  }

  try {
    const response = await net.fetch(`${UPDATE_ENDPOINT}?channel=beta&platform=${platform}`);
    if (!response.ok) throw new Error(`release_status_${response.status}`);
    const payload = await response.json();
    const release = payload.release;
    if (!release || !release.version) throw new Error('release_unavailable');

    const isNewer = compareVersions(release.version, app.getVersion()) > 0;
    if (!isNewer && !interactive) return;
    const result = await dialog.showMessageBox(win, {
      type: isNewer ? 'info' : 'none',
      title: 'Actualizaciones de SiraGPT',
      message: isNewer ? `SiraGPT ${release.version} está disponible.` : `SiraGPT ${app.getVersion()} está actualizado.`,
      detail: release.signed
        ? 'La descarga está firmada y verificada.'
        : 'Esta versión pertenece al canal beta de escritorio.',
      buttons: isNewer ? ['Descargar', 'Más tarde'] : ['Aceptar'],
      defaultId: 0,
      cancelId: isNewer ? 1 : 0,
    });
    if (isNewer && result.response === 0) {
      shell.openExternal(release.pageUrl || 'https://siragpt.com/descargas').catch(() => {});
    }
  } catch {
    if (interactive) {
      await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Actualizaciones de SiraGPT',
        message: 'No pudimos comprobar las actualizaciones.',
        detail: 'Revisa tu conexión e inténtalo nuevamente.',
      });
    }
  }
}

function navigateMain(target) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const resolved = deepLinkToAppUrl(target) || normaliseAppUrl(target, { allowLocalhost: allowLocalhost() });
  mainWindow.loadURL(resolved).catch(() => showOfflinePage(mainWindow, resolved));
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildApplicationMenu(win) {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Buscar actualizaciones…', click: () => checkForUpdates(win) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Archivo',
      submenu: [
        { label: 'Nuevo chat', accelerator: 'CmdOrCtrl+N', click: () => navigateMain('https://siragpt.com/chat?new=1') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { label: 'Editar', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Navegar',
      submenu: [
        { label: 'Atrás', accelerator: 'Alt+Left', click: () => win.webContents.navigationHistory.canGoBack() && win.webContents.navigationHistory.goBack() },
        { label: 'Adelante', accelerator: 'Alt+Right', click: () => win.webContents.navigationHistory.canGoForward() && win.webContents.navigationHistory.goForward() },
        { type: 'separator' },
        { label: 'Chat', click: () => navigateMain(DEFAULT_APP_URL) },
        { label: 'Descargas', click: () => navigateMain('https://siragpt.com/descargas') },
      ],
    },
    {
      role: 'help',
      submenu: [
        ...(!isMac ? [{ label: 'Buscar actualizaciones…', click: () => checkForUpdates(win) }, { type: 'separator' }] : []),
        { label: 'Guía de instalación', click: () => shell.openExternal('https://siragpt.com/descargas').catch(() => {}) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  nativeTheme.themeSource = 'system';
  const state = readWindowState();
  const win = new BrowserWindow({
    title: 'SiraGPT',
    width: state.width || 1280,
    height: state.height || 860,
    ...(Number.isFinite(state.x) ? { x: state.x } : {}),
    ...(Number.isFinite(state.y) ? { y: state.y } : {}),
    minWidth: 390,
    minHeight: 640,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171717' : '#ffffff',
    show: false,
    webPreferences: {
      contextIsolation: true,
      devTools: !app.isPackaged || process.env.SIRAGPT_DESKTOP_DEVTOOLS === '1',
      navigateOnDragDrop: false,
      nodeIntegration: false,
      sandbox: true,
      safeDialogs: true,
      spellcheck: true,
      webSecurity: true,
    },
  });
  mainWindow = win;
  if (state.maximized) win.maximize();

  configureNavigation(win.webContents, win, {
    onOAuth: (url) => {
      createOAuthWindow(win, url);
      win.loadURL('https://siragpt.com/auth/login').catch(() => {});
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => handleOpenRequest(win, url));
  win.webContents.on('did-fail-load', (_event, errorCode, _description, validatedUrl, isMainFrame) => {
    if (isMainFrame && errorCode !== -3 && !validatedUrl.startsWith('file:')) showOfflinePage(win, validatedUrl);
  });
  win.once('ready-to-show', () => win.show());
  win.on('resize', () => scheduleWindowStateSave(win));
  win.on('move', () => scheduleWindowStateSave(win));
  win.on('close', () => persistWindowState(win));
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

  buildApplicationMenu(win);
  const startUrl = pendingDeepLink ? deepLinkToAppUrl(pendingDeepLink) : currentStartUrl();
  pendingDeepLink = null;
  win.loadURL(startUrl || DEFAULT_APP_URL).catch(() => showOfflinePage(win, startUrl || DEFAULT_APP_URL));
  return win;
}

function configureSession() {
  const desktopSession = session.defaultSession;
  const allowedOrigin = (webContents, requestingOrigin) => {
    const source = requestingOrigin || webContents?.getURL?.() || '';
    return isTrustedAppUrl(source, { allowLocalhost: allowLocalhost() });
  };
  desktopSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => (
    allowedOrigin(webContents, requestingOrigin) && PERMITTED_WEB_PERMISSIONS.has(permission)
  ));
  desktopSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(allowedOrigin(webContents, details.requestingUrl) && PERMITTED_WEB_PERMISSIONS.has(permission));
  });
  const userAgent = desktopSession.getUserAgent();
  desktopSession.setUserAgent(`${userAgent} SiraGPTDesktop/${app.getVersion()}`);
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (!deepLinkToAppUrl(url)) return;
  if (app.isReady()) navigateMain(url);
  else pendingDeepLink = url;
});

app.on('second-instance', (_event, argv) => {
  const deepLink = argv.find((value) => String(value).startsWith('siragpt://'));
  if (deepLink && deepLinkToAppUrl(deepLink)) navigateMain(deepLink);
  else if (mainWindow) navigateMain(mainWindow.webContents.getURL() || DEFAULT_APP_URL);
});

app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  event.preventDefault();
  callback(false);
});

if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    app.setName('SiraGPT');
    if (process.platform === 'win32') app.setAppUserModelId('com.siragpt.desktop');
    if (app.isPackaged) app.setAsDefaultProtocolClient('siragpt');
    configureSession();
    createMainWindow();

    nativeTheme.on('updated', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#171717' : '#ffffff');
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
      else if (mainWindow) navigateMain(mainWindow.webContents.getURL() || DEFAULT_APP_URL);
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
