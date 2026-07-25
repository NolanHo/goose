// Web replacement for the Electron preload bridge.
//
// The desktop renderer talks to two surfaces:
//   1. ACP over WebSocket — already browser-native (createWebSocketStream.ts).
//   2. window.electron / window.appConfig — the Electron IPC bridge.
//
// This module installs web-compatible implementations of (2) BEFORE the renderer
// boots, so every `window.electron.*` call resolves to a sensible web behaviour.
//
// Core chat needs almost nothing from here: getAcpUrl() is the one that matters.

import { defaultSettings, type Settings, type SettingKey } from '../../desktop/src/utils/settings';

const ACP_TOKEN = import.meta.env.VITE_GOOSE_TOKEN ?? '';
// Default working directory for new sessions. The desktop app injects this via
// Electron at launch; on web we fall back to the goosed process cwd ("/root").
// Override with VITE_GOOSE_WORKING_DIR in .env if needed.
const WORKING_DIR =
  (import.meta.env.VITE_GOOSE_WORKING_DIR as string | undefined) ?? '/root';

// The ACP WebSocket is served same-origin as the page and proxied to goosed by
// Vite (see vite.config.ts server.proxy). Deriving from window.location makes
// it work for local (http://localhost:39248) and domain
// (https://goose.apeiria.cn) access alike.
// The ACP WebSocket goes through the gateway (default :39249), which adds
// permessage-deflate compression and keeps the goosed connection alive when
// the browser disconnects (so in-flight prompts are not aborted).
// In production behind a reverse proxy, set VITE_GATEWAY_PORT to the same
// port as the web UI so the URL is same-origin.
function acpWebSocketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const gwPort = import.meta.env.VITE_GATEWAY_PORT ?? '39249';
  // If the gateway runs on the same port as the web UI (reverse proxy), use
  // the same host:port; otherwise use the gateway port explicitly.
  if (gwPort === window.location.port || gwPort === 'same') {
    return `${proto}://${window.location.host}/acp`;
  }
  return `${proto}://${window.location.hostname}:${gwPort}/acp`;
}

// ---------------------------------------------------------------------------
// Settings — persisted to localStorage (mirrors the desktop JSON-file approach)
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'goose-web-settings';

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    /* ignore corrupt store */
  }
  return { ...defaultSettings };
}

function writeSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage full / unavailable */
  }
}

// ---------------------------------------------------------------------------
// Minimal in-page event bus for on/off/emit
// (theme broadcast, updater events, mouse-back — all single-window on web)
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;
const bus = new Map<string, Set<Handler>>();

function on(channel: string, callback: Handler): void {
  let set = bus.get(channel);
  if (!set) {
    set = new Set();
    bus.set(channel, set);
  }
  set.add(callback);
}

function off(channel: string, callback: Handler): void {
  bus.get(channel)?.delete(callback);
}

function emit(channel: string, ...args: unknown[]): void {
  bus.get(channel)?.forEach((cb) => {
    try {
      cb({ sender: null }, ...args);
    } catch (err) {
      console.error(`[web] event handler error on "${channel}":`, err);
    }
  });
}

// ---------------------------------------------------------------------------
// electron API
// ---------------------------------------------------------------------------

const noop = (): void => {};
const noopAsync = async (): Promise<void> => {};
const noopBool = async (): Promise<boolean> => false;

function detectLocale(): string {
  const lang = navigator.language || 'en';
  return lang.replace('-', '_');
}

const electronAPI = {
  platform: 'web' as const,
  arch: 'web' as const,

  reactReady: noop,
  getConfig: () => ({}) as Record<string, unknown>,

  // Window / lifecycle — no-ops on web (single tab).
  hideWindow: noop,
  closeWindow: noop,
  reloadApp: () => window.location.reload(),
  createChatWindow: noop,

  logInfo: (txt: string) => console.log('[renderer]', txt),

  // The single most important method: where the ACP WebSocket lives.
  getAcpUrl: () => acpWebSocketUrl(),
  getSecretKey: () => ACP_TOKEN || null,

  // Settings — localStorage-backed.
  getSetting: async <K extends SettingKey>(key: K): Promise<Settings[K]> =>
    readSettings()[key] as Settings[K],
  setSetting: async <K extends SettingKey>(key: K, value: Settings[K]): Promise<void> => {
    const s = readSettings();
    (s as Record<string, unknown>)[key] = value;
    writeSettings(s);
  },

  // File system — web has no direct FS access. Expose enough for the renderer
  // not to crash; file flows go through the browser File API instead.
  readFile: async (filePath: string) => ({
    file: '',
    filePath,
    error: 'File system access is not available in the web build',
    found: false,
  }),
  writeFile: noopBool,
  ensureDirectory: noopBool,
  listFiles: async (): Promise<string[]> => [],
  getAllowedExtensions: async (): Promise<string[]> => [],
  getPathForFile: () => '',
  selectFileOrDirectory: async (): Promise<string | null> => null,
  selectImportSessionFile: async () => null,
  directoryChooser: async () => ({ canceled: true, filePaths: [] }),

  // Native dialogs → browser primitives.
  showMessageBox: async (opts: { message: string; type?: string; buttons?: string[] }) => {
    const ok = window.confirm(opts.message);
    return { response: ok ? 0 : 1, checkboxChecked: false };
  },
  showSaveDialog: async (opts: { defaultPath?: string; title?: string }) => {
    // Best-effort: trigger a no-op download stub.
    return { canceled: true };
  },
  showNotification: (data: { title: string; body: string }) => {
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(data.title, { body: data.body });
      }
    } catch {
      /* ignore */
    }
  },

  // External links / OS integration.
  openExternal: async (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  openInChrome: (url: string) => window.open(url, '_blank', 'noopener,noreferrer'),
  openDirectoryInExplorer: noopBool,
  openNotificationsSettings: noopBool,

  // Tray / dock / menubar / wakelock / spellcheck — not applicable on web.
  setMenuBarIcon: noopBool,
  getMenuBarIconState: noopBool,
  setDockIcon: noopBool,
  getDockIconState: async () => false,
  setWakelock: noopBool,
  getWakelockState: async () => false,
  setSpellcheck: noopBool,
  getSpellcheckState: async () => false,
  isAnyWindowFocused: async () => document.hasFocus(),
  getIsFullScreen: async () => !!document.fullscreenElement,
  checkForOllama: noopBool,
  getBinaryPath: async (name: string) => name,

  // Recent dirs / worktrees — no persistent store on web; return empty.
  addRecentDir: noopBool,
  listRecentDirs: async (): Promise<string[]> => [],
  listGitWorktreeDirs: async (): Promise<string[]> => [],

  // MCP apps (platform_events) — launchApp etc. are desktop-only; no-op on web.
  launchApp: noopAsync,
  refreshApp: noopAsync,
  closeApp: noopAsync,

  // Recipe acceptance — always treat as not-yet-accepted, never persist.
  hasAcceptedRecipeBefore: async () => false,
  recordRecipeHash: noopBool,

  // Auto-update — meaningless on web (reload = update).
  getVersion: () => '0.1.0-web',
  checkForUpdates: async () => ({ updateInfo: null, error: null }),
  downloadUpdate: async () => ({ success: false, error: 'Not available in web build' }),
  installUpdate: noop,
  restartApp: () => window.location.reload(),
  onUpdaterEvent: noop,
  getUpdateState: async () => null,
  isUsingGitHubFallback: noopBool,
  getAutoDownloadDisabled: async () => true,

  // Mouse back button — map to browser history.
  onMouseBackButtonClicked: (callback: () => void) => {
    const handler = (e: PopStateEvent) => callback();
    window.addEventListener('popstate', handler);
    return handler;
  },
  offMouseBackButtonClicked: (callback: (e: PopStateEvent) => void) => {
    window.removeEventListener('popstate', callback);
  },

  // IPC event bus.
  on,
  off,
  emit,
  broadcastThemeChange: (themeData: { mode: string; useSystemTheme: boolean; theme: string }) => {
    // Apply to the current document and re-broadcast within the page.
    const isDark = themeData.useSystemTheme
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : themeData.theme === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
    emit('theme-change', themeData);
  },
};

// ---------------------------------------------------------------------------
// appConfig — mirrors the desktop's boot config object
// ---------------------------------------------------------------------------

const appConfigValues: Record<string, unknown> = {
  GOOSE_VERSION: '0.1.0-web',
  GOOSE_LOCALE: detectLocale(),
  GOOSE_WORKING_DIR: WORKING_DIR,
  recipeDeeplink: undefined,
  recipeId: undefined,
};

const appConfigAPI = {
  get: (key: string) => {
    if (key === 'GOOSE_LOCALE') return detectLocale();
    return appConfigValues[key];
  },
  getAll: () => ({ ...appConfigValues, GOOSE_LOCALE: detectLocale() }),
};

// Install onto the window before the renderer boots.
declare global {
  interface Window {
    electron: typeof electronAPI;
    appConfig: typeof appConfigAPI;
  }
}

window.electron = electronAPI;
window.appConfig = appConfigAPI;
