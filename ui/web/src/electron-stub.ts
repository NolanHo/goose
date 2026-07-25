// Stub module for `import ... from 'electron'`.
//
// The desktop renderer only imports the *type* IpcRendererEvent from 'electron'
// (in App.tsx, AppLayout.tsx, ExtensionInstallModal.tsx) — those are erased at
// build time. This stub satisfies the resolver so Vite never tries to bundle the
// real electron package, and provides harmless runtime fallbacks in case any
// main-process-only util leaks into the graph.

export type IpcRendererEvent = {
  sender: unknown;
  preventDefault: () => void;
  defaultPrevented: boolean;
};

export const app = {
  getPath: () => '',
  getName: () => 'goose-web',
  getVersion: () => '0.1.0',
  isPackaged: false,
  isReady: () => true,
  getLocale: () => navigator.language,
};

export const ipcMain = {
  handle: () => {},
  on: () => {},
  off: () => {},
  removeHandler: () => {},
};

export class BrowserWindow {
  static getFocusedWindow() {
    return null;
  }
  static fromWebContents() {
    return null;
  }
}

const electron = { app, ipcMain, BrowserWindow };
export default electron;
