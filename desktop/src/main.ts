// Electron main process for openshuki:
//  - single-instance lock (raising existing window on relaunch)
//  - spawn backend subprocess
//  - open BrowserWindow pointing at the frontend (Vite dev server in dev,
//    built assets in packaged mode)
//  - intercept window close to hide-to-tray; only the tray Quit really exits

import { BrowserWindow, app, dialog, shell } from "electron";
import path from "node:path";
import { startBackend, type BackendHandle } from "./backend";
import { createTray } from "./tray";

let mainWindow: BrowserWindow | null = null;
let backend: BackendHandle | null = null;
let trayHandle: ReturnType<typeof createTray> | null = null;
let quitting = false;

// AppUserModelID — required for Windows toast notifications (PR #6) to
// show under our app instead of "Electron". Must match the install-time
// shortcut name set by electron-builder.
app.setAppUserModelId("com.openshuki.tray");

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void main();
}

async function main(): Promise<void> {
  await app.whenReady();

  // Pick a port from env or default to 4000. PORT=0 is not honoured by the
  // current backend (no port re-read after listen()); we fix the port so
  // the frontend's existing /api proxy/relative URLs keep working.
  const port = Number(process.env.OPENSHUKI_BACKEND_PORT ?? 4000);

  try {
    backend = await startBackend(port);
  } catch (err) {
    dialog.showErrorBox(
      "openshuki backend failed to start",
      err instanceof Error ? err.message : String(err)
    );
    app.exit(1);
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Dev: Vite serves at :5173 with /api proxied to the backend.
  // Packaged: load the built frontend from disk (relative to backend cwd
  // — same layout pnpm-workspace gives us in dev).
  const devUrl = process.env.OPENSHUKI_FRONTEND_URL ?? "http://localhost:5173";
  const builtPath = path.resolve(process.cwd(), "..", "frontend", "dist", "index.html");
  const startUrl = process.env.OPENSHUKI_USE_BUILT === "1" ? `file://${builtPath}` : devUrl;
  await mainWindow.loadURL(startUrl);
  mainWindow.show();

  // Open external links in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // Intercept close: hide instead of quit. Tray "Quit" sets `quitting` so
  // the real exit path runs.
  mainWindow.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  trayHandle = createTray(
    () => mainWindow,
    () => {
      quitting = true;
      app.quit();
    }
  );
}

app.on("before-quit", () => {
  quitting = true;
  trayHandle?.destroy();
  backend?.stop();
});

// Don't auto-quit when the window is hidden — that's the tray behaviour.
// Electron only auto-quits on non-macOS when there are no windows; by
// keeping the window hidden (not closed) the count stays at 1 and this
// event never fires. If it does (e.g. window was destroyed), only exit
// when an explicit quit was requested via the tray menu.
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});
