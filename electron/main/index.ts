/**
 * Electron Main Process Entry
 * Manages window creation, system tray, and IPC handlers
 */
import { app, BrowserWindow, nativeImage, screen, session, shell } from 'electron';
import type { Server } from 'node:http';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { GatewayManager } from '../gateway/manager';
import { registerIpcHandlers } from './ipc-handlers';
import { createTray } from './tray';
import { createMenu } from './menu';

import { appUpdater, registerUpdateHandlers } from './updater';
import { logger } from '../utils/logger';
import { warmupNetworkOptimization } from '../utils/uv-env';
import { initTelemetry } from '../utils/telemetry';

import { ClawHubService } from '../gateway/clawhub';
import { isQuitting, setQuitting } from './app-state';
import { applyProxySettings } from './proxy';
import { syncLaunchAtStartupSettingFromStore } from './launch-at-startup';
import {
  clearPendingSecondInstanceFocus,
  consumeMainWindowReady,
  createMainWindowFocusState,
  requestSecondInstanceFocus,
} from './main-window-focus';
import {
  createQuitLifecycleState,
  markQuitCleanupCompleted,
  requestQuitLifecycleAction,
} from './quit-lifecycle';
import { createSignalQuitHandler } from './signal-quit';
import { acquireProcessInstanceFileLock } from './process-instance-lock';
import { getSetting } from '../utils/store';
import { startHostApiServer } from '../api/server';
import { HostEventBus } from '../api/event-bus';
import { runStages, type BootContext } from './boot/phase-runner';
import { healthStages } from './boot/phase-health';
import { backgroundStages } from './boot/phase-background';
import { applyRuntimePathToProcess } from '../services/dependency/runtime-paths';

const WINDOWS_APP_USER_MODEL_ID = 'com.wonder.shine';

app.setName('阿山');

// Disable GPU hardware acceleration globally for maximum stability across
// all GPU configurations (no GPU, integrated, discrete).
//
// Rationale (following VS Code's philosophy):
// - Page/file loading is async data fetching — zero GPU dependency.
// - The original per-platform GPU branching was added to avoid CPU rendering
//   competing with sync I/O on Windows, but all file I/O is now async
//   (fs/promises), so that concern no longer applies.
// - Software rendering is deterministic across all hardware; GPU compositing
//   behaviour varies between vendors (Intel, AMD, NVIDIA, Apple Silicon) and
//   driver versions, making it the #1 source of rendering bugs in Electron.
//
// Users who want GPU acceleration can pass `--enable-gpu` on the CLI or
// set `"disable-hardware-acceleration": false` in the app config (future).
app.disableHardwareAcceleration();

// On Linux, set CHROME_DESKTOP so Chromium can find the correct .desktop file.
// On Wayland this maps the running window to shan.desktop (→ icon + app grouping);
// on X11 it supplements the StartupWMClass matching.
// Must be called before app.whenReady() / before any window is created.
if (process.platform === 'linux') {
  app.setDesktopName('shan.desktop');
}

// Prevent multiple instances of the app from running simultaneously.
// Without this, two instances each spawn their own gateway process on the
// same port, then each treats the other's gateway as "orphaned" and kills
// it — creating an infinite kill/restart loop on Windows.
//
// In dev mode, the dev server's hot-reload sometimes spawns a new Electron
// process before the old one's lock is released. We don't fail-loudly there;
// we just quit silently so the user sees their existing window.
const gotElectronLock = app.requestSingleInstanceLock();
if (!gotElectronLock) {
  if (!app.isPackaged) {
    console.info('[阿山] Dev hot-reload duplicate detected; the existing window will be focused.');
  } else {
    console.info(
      '[阿山] Another instance already holds the single-instance lock; exiting duplicate process'
    );
  }
  app.exit(0);
}
let releaseProcessInstanceFileLock: () => void = () => {};
let gotFileLock = true;
if (gotElectronLock) {
  try {
    const fileLock = acquireProcessInstanceFileLock({
      userDataDir: app.getPath('userData'),
      lockName: 'shan',
    });
    gotFileLock = fileLock.acquired;
    releaseProcessInstanceFileLock = fileLock.release;

    // Register exit handler IMMEDIATELY after lock acquisition, regardless of
    // whether we proceed to full initialization. If we don't proceed (because
    // file lock was contested), we still need to clean up our own lock file
    // when this duplicate process exits.
    process.once('exit', () => {
      try {
        releaseProcessInstanceFileLock();
      } catch {
        // best-effort
      }
    });
    if (!fileLock.acquired) {
      const ownerDescriptor = fileLock.ownerPid
        ? `${fileLock.ownerFormat ?? 'legacy'} pid=${fileLock.ownerPid}`
        : fileLock.ownerFormat === 'unknown'
          ? 'unknown lock format/content'
          : 'unknown owner';
      console.info(
        `[阿山] Another instance already holds process lock (${fileLock.lockPath}, ${ownerDescriptor}); exiting duplicate process`
      );
      app.exit(0);
    }
  } catch (error) {
    console.warn(
      '[阿山] Failed to acquire process instance file lock; continuing with Electron single-instance lock only',
      error
    );
  }
}
const gotTheLock = gotElectronLock && gotFileLock;

// Global references
let mainWindow: BrowserWindow | null = null;
let floatingBallWindow: BrowserWindow | null = null;
let gatewayManager!: GatewayManager;
let clawHubService!: ClawHubService;
let hostEventBus!: HostEventBus;
let hostApiServer: Server | null = null;
const mainWindowFocusState = createMainWindowFocusState();
const quitLifecycleState = createQuitLifecycleState();

/**
 * Resolve the icons directory path (works in both dev and packaged mode)
 */
function getIconsDir(): string {
  if (app.isPackaged) {
    // Packaged: icons are in extraResources → process.resourcesPath/resources/icons
    return join(process.resourcesPath, 'resources', 'icons');
  }
  // Development: relative to dist-electron/main/
  return join(__dirname, '../../resources/icons');
}

/**
 * Get the app icon for the current platform
 */
function getAppIcon(): Electron.NativeImage | undefined {
  if (process.platform === 'darwin') return undefined; // macOS uses the app bundle icon

  const iconsDir = getIconsDir();
  const iconPath =
    process.platform === 'win32' ? join(iconsDir, 'icon.ico') : join(iconsDir, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

function applyMacDockIcon(): void {
  if (process.platform !== 'darwin') return;

  const iconCandidates = [
    join(app.getAppPath(), 'src/assets/logo.icns'),
    join(__dirname, '../../src/assets/logo.icns'),
    join(process.resourcesPath, 'resources/icons/icon.icns'),
  ];

  const iconPath = iconCandidates.find((candidate) => existsSync(candidate));
  if (!iconPath) return;

  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) {
    app.dock.setIcon(icon);
  }
}

/**
 * Create the main application window
 */
function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';
  const useCustomTitleBar = isWindows;

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 700,
    minHeight: 700,
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true, // Enable <webview> for embedding OpenClaw Control UI
    },
    titleBarStyle: isMac ? 'hiddenInset' : useCustomTitleBar ? 'hidden' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 12 } : undefined,
    frame: isMac || !useCustomTitleBar,
    show: false,
  });

  // Handle external links
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(join(__dirname, '../../dist/index.html'));
  }

  return win;
}

function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    return;
  }

  if (win.isMinimized()) {
    win.restore();
  }

  win.show();
  win.focus();
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  clearPendingSecondInstanceFocus(mainWindowFocusState);
  focusWindow(mainWindow);
}

function createMainWindow(): BrowserWindow {
  const win = createWindow();

  win.once('ready-to-show', () => {
    if (mainWindow !== win) {
      return;
    }

    const action = consumeMainWindowReady(mainWindowFocusState);
    if (action === 'focus') {
      focusWindow(win);
      return;
    }

    win.show();
  });

  win.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  mainWindow = win;
  return win;
}

function createFloatingBallWindow(): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workArea;
  const size = 76;
  const x = workArea.x + workArea.width - size - 18;
  const y = workArea.y + Math.floor(workArea.height * 0.34);

  const win = new BrowserWindow({
    width: size,
    height: size,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setMenuBarVisibility(false);

  const petDirs = [
    join(app.getAppPath(), 'src/assets/pets'),
    join(__dirname, '../../src/assets/pets'),
    join(process.cwd(), 'src/assets/pets'),
  ];
  const petDir = petDirs.find((dir) => existsSync(dir));
  const petGifBundle = petDir
    ? (() => {
        const files = readdirSync(petDir).filter((name) => /\.gif$/i.test(name));
        const onGif = files.find((name) => name.toLowerCase() === 'on.gif') || '';
        const loopFiles = files.filter((name) => name.toLowerCase() !== 'on.gif');
        const toDataUrl = (filename: string) => {
          const raw = readFileSync(join(petDir, filename));
          return `data:image/gif;base64,${raw.toString('base64')}`;
        };
        return {
          onGif: onGif ? toDataUrl(onGif) : '',
          loopGifs: (loopFiles.length > 0 ? loopFiles : files).map(toDataUrl),
        };
      })()
    : { onGif: '', loopGifs: [] as string[] };

  const floatingBallHtml = `
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        background: transparent;
        overflow: hidden;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        -webkit-user-select: none;
      }
      button {
        width: 68px;
        height: 68px;
        border: 0;
        border-radius: 999px;
        cursor: pointer !important;
        padding: 0;
        background: transparent;
        box-shadow: none;
        transition: transform 120ms ease;
        animation: breathe 2.2s ease-in-out infinite;
        overflow: hidden;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        -webkit-user-drag: none;
      }
      button:hover {
        transform: scale(1.04);
      }
      button:active { transform: scale(0.96); }
      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 999px;
        opacity: 1;
        transition: opacity 220ms ease;
        user-select: none;
        -webkit-user-select: none;
        -webkit-user-drag: none;
        pointer-events: none;
        cursor: pointer !important;
      }
      .fallback {
        width: 100%;
        height: 100%;
        border-radius: 999px;
        display: grid;
        place-items: center;
        color: #ffffff;
        font-size: 22px;
        font-weight: 600;
        background: radial-gradient(circle at 30% 30%, #4ade80 0%, #10b981 45%, #059669 100%);
        cursor: pointer !important;
      }
      button * {
        cursor: pointer !important;
      }
      @keyframes breathe {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.04); }
      }
    </style>
  </head>
  <body>
    <button id="ball"></button>
    <script>
      const petGifBundle = ${JSON.stringify(petGifBundle)};
      const ball = document.getElementById('ball');
      let dragging = false;
      let activePointerId = null;
      let suppressClick = false;
      let dragStartX = 0;
      let dragStartY = 0;
      let startWindowX = 0;
      let startWindowY = 0;
      let movedPx = 0;
      let loopTimer = null;
      let currentIndex = 0;
      let imageEl = null;
      let hovered = false;

      function mountFallback() {
        if (!ball) return;
        ball.innerHTML = '<div class="fallback">阿</div>';
      }

      function mountCarousel() {
        if (!ball || !petGifBundle.loopGifs.length) {
          mountFallback();
          return;
        }
        imageEl = document.createElement('img');
        imageEl.draggable = false;
        imageEl.src = petGifBundle.loopGifs[currentIndex];
        ball.appendChild(imageEl);
        loopTimer = setInterval(() => {
          if (!imageEl || hovered) return;
          currentIndex = (currentIndex + 1) % petGifBundle.loopGifs.length;
          imageEl.style.opacity = '0';
          setTimeout(() => {
            if (!imageEl) return;
            imageEl.src = petGifBundle.loopGifs[currentIndex];
            imageEl.style.opacity = '1';
          }, 120);
        }, 2600);
      }

      mountCarousel();

      ball?.addEventListener('mouseenter', () => {
        hovered = true;
        if (!imageEl || !petGifBundle.onGif) return;
        imageEl.src = petGifBundle.onGif;
      });

      ball?.addEventListener('mouseleave', () => {
        hovered = false;
        if (!imageEl || !petGifBundle.loopGifs.length) return;
        imageEl.src = petGifBundle.loopGifs[currentIndex];
      });

      function onPointerMove(event) {
        if (!dragging) return;
        if (activePointerId !== null && event.pointerId !== activePointerId) return;
        const nextX = startWindowX + (event.screenX - dragStartX);
        const nextY = startWindowY + (event.screenY - dragStartY);
        movedPx = Math.max(movedPx, Math.abs(event.screenX - dragStartX), Math.abs(event.screenY - dragStartY));
        window.electron.ipcRenderer.invoke('floating:setPosition', nextX, nextY).catch(() => {});
      }

      function stopDrag(event) {
        if (!dragging) return;
        if (event && activePointerId !== null && event.pointerId !== activePointerId) return;
        suppressClick = movedPx > 4;
        dragging = false;
        if (ball && activePointerId !== null && ball.hasPointerCapture(activePointerId)) {
          ball.releasePointerCapture(activePointerId);
        }
        activePointerId = null;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', stopDrag);
        window.removeEventListener('pointercancel', stopDrag);
      }

      ball?.addEventListener('dragstart', (event) => {
        event.preventDefault();
      });

      ball?.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        dragging = true;
        activePointerId = event.pointerId;
        movedPx = 0;
        dragStartX = event.screenX;
        dragStartY = event.screenY;
        startWindowX = window.screenX;
        startWindowY = window.screenY;
        ball.setPointerCapture(event.pointerId);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', stopDrag);
        window.addEventListener('pointercancel', stopDrag);
      });

      ball?.addEventListener('click', async () => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        try {
          await window.electron.ipcRenderer.invoke('hostapi:fetch', {
            path: '/api/app/show-main-window',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
        } catch (error) {
          console.error('Failed to show main window from floating ball:', error);
        }
      });

      window.addEventListener('beforeunload', () => {
        stopDrag();
        if (loopTimer) clearInterval(loopTimer);
      });
    </script>
  </body>
</html>
`;

  const floatingHtmlPath = join(app.getPath('userData'), 'floating-ball.html');
  writeFileSync(floatingHtmlPath, floatingBallHtml, 'utf8');
  void win.loadFile(floatingHtmlPath);
  win.showInactive();

  win.on('closed', () => {
    if (floatingBallWindow === win) {
      floatingBallWindow = null;
    }
  });

  floatingBallWindow = win;
  return win;
}

function setFloatingBallEnabled(enabled: boolean): void {
  if (!enabled) {
    if (floatingBallWindow && !floatingBallWindow.isDestroyed()) {
      floatingBallWindow.close();
    }
    floatingBallWindow = null;
    return;
  }

  if (floatingBallWindow && !floatingBallWindow.isDestroyed()) {
    floatingBallWindow.showInactive();
    return;
  }

  createFloatingBallWindow();
}

/**
 * Initialize the application — three-phase boot sequence.
 */
async function initialize(): Promise<void> {
  logger.init();
  logger.info('=== 阿山 Application Starting ===');
  logger.debug(
    `Runtime: platform=${process.platform}/${process.arch}, electron=${process.versions.electron}, node=${process.versions.node}, packaged=${app.isPackaged}, pid=${process.pid}, ppid=${process.ppid}`
  );

  // Apply managed runtime PATH before anything else
  applyRuntimePathToProcess();

  // ── Phase 1: Critical (blocks window display) ──────────────────────────
  void warmupNetworkOptimization();
  await initTelemetry();
  await applyProxySettings();
  await syncLaunchAtStartupSettingFromStore();

  createMenu();
  applyMacDockIcon();

  const window = createMainWindow();
  const floatingBallEnabled = await getSetting('floatingBallEnabled');
  setFloatingBallEnabled(floatingBallEnabled);
  createTray(window);

  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://127.0.0.1:18789/*', 'http://localhost:18789/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers['X-Frame-Options'];
      delete headers['x-frame-options'];
      if (headers['Content-Security-Policy']) {
        headers['Content-Security-Policy'] = headers['Content-Security-Policy'].map((csp) =>
          csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      if (headers['content-security-policy']) {
        headers['content-security-policy'] = headers['content-security-policy'].map((csp) =>
          csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      callback({ responseHeaders: headers });
    }
  );

  registerIpcHandlers(gatewayManager, clawHubService, window, () => floatingBallWindow);

  hostApiServer = startHostApiServer({
    gatewayManager,
    clawHubService,
    eventBus: hostEventBus,
    mainWindow: window,
    setFloatingBallEnabled,
  });

  registerUpdateHandlers(appUpdater, window);
  logger.info('[boot] phase=critical done');

  // ── Phase 2: Health (dependency gate) ──────────────────────────────────
  const bootCtx: BootContext = {
    mainWindow: window,
    gatewayManager,
    clawHubService,
    hostEventBus,
    hostApiServer,
    setFloatingBallEnabled,
    floatingBallWindow: () => floatingBallWindow,
  };

  await runStages('health', healthStages, bootCtx);

  // ── Phase 3: Background (non-blocking) ─────────────────────────────────
  void runStages('background', backgroundStages, bootCtx);
}

if (gotTheLock) {
  const requestQuitOnSignal = createSignalQuitHandler({
    logInfo: (message) => logger.info(message),
    requestQuit: () => app.quit(),
  });

  process.on('exit', () => {
    releaseProcessInstanceFileLock();
  });

  process.once('SIGINT', () => requestQuitOnSignal('SIGINT'));
  process.once('SIGTERM', () => requestQuitOnSignal('SIGTERM'));

  app.on('will-quit', () => {
    releaseProcessInstanceFileLock();
  });

  if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  }

  gatewayManager = new GatewayManager();
  clawHubService = new ClawHubService();
  hostEventBus = new HostEventBus();

  // When a second instance is launched, focus the existing window instead.
  app.on('second-instance', () => {
    logger.info('Second 阿山 instance detected; redirecting to the existing window');

    const focusRequest = requestSecondInstanceFocus(
      mainWindowFocusState,
      Boolean(mainWindow && !mainWindow.isDestroyed())
    );

    if (focusRequest === 'focus-now') {
      focusMainWindow();
      return;
    }

    logger.debug(
      'Main window is not ready yet; deferring second-instance focus until ready-to-show'
    );
  });

  // Application lifecycle
  app.whenReady().then(() => {
    void initialize().catch((error) => {
      logger.error('Application initialization failed:', error);
    });

    // Register activate handler AFTER app is ready to prevent
    // "Cannot create BrowserWindow before app is ready" on macOS.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      } else {
        focusMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    setQuitting();
    const action = requestQuitLifecycleAction(quitLifecycleState);

    if (action === 'allow-quit') {
      return;
    }

    event.preventDefault();

    if (action === 'cleanup-in-progress') {
      logger.debug(
        'Quit requested while cleanup already in progress; waiting for shutdown task to finish'
      );
      return;
    }

    hostEventBus.closeAll();
    hostApiServer?.close();

    const stopPromise = gatewayManager.stop().catch((err) => {
      logger.warn('gatewayManager.stop() error during quit:', err);
    });
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 5000);
    });

    void Promise.race([stopPromise.then(() => 'stopped' as const), timeoutPromise]).then(
      (result) => {
        if (result === 'timeout') {
          logger.warn('Gateway shutdown timed out during app quit; proceeding with forced quit');
          void gatewayManager
            .forceTerminateOwnedProcessForQuit()
            .then((terminated) => {
              if (terminated) {
                logger.warn('Forced gateway process termination completed after quit timeout');
              }
            })
            .catch((err) => {
              logger.warn('Forced gateway termination failed after quit timeout:', err);
            });
        }
        markQuitCleanupCompleted(quitLifecycleState);
        app.quit();
      }
    );
  });

  // Best-effort Gateway cleanup on unexpected crashes.
  // These handlers attempt to terminate the Gateway child process within a
  // short timeout before force-exiting, preventing orphaned processes.
  const emergencyGatewayCleanup = (reason: string, error: unknown): void => {
    logger.error(`${reason}:`, error);
    try {
      void gatewayManager?.stop().catch(() => {
        /* ignore */
      });
    } catch {
      // ignore — stop() may not be callable if state is corrupted
    }
    // Give Gateway stop a brief window, then force-exit.
    setTimeout(() => {
      process.exit(1);
    }, 3000).unref();
  };

  process.on('uncaughtException', (error) => {
    emergencyGatewayCleanup('Uncaught exception in main process', error);
  });

  process.on('unhandledRejection', (reason) => {
    emergencyGatewayCleanup('Unhandled promise rejection in main process', reason);
  });
}

// Export for testing
export { mainWindow, gatewayManager };
