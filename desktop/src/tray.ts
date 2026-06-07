import { Menu, Tray, nativeImage, type BrowserWindow } from "electron";
import path from "node:path";

type TrayHandle = {
  tray: Tray;
  destroy: () => void;
};

function buildIcon(): Electron.NativeImage {
  // Prefer a checked-in icon, fall back to an Electron default if missing.
  const candidates = [
    path.resolve(__dirname, "..", "build", "icon.ico"),
    path.resolve(__dirname, "..", "build", "icon.png")
  ];
  for (const p of candidates) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  // Empty 16x16 so the tray entry still appears.
  return nativeImage.createEmpty();
}

export function createTray(getWindow: () => BrowserWindow | null, onQuit: () => void): TrayHandle {
  const tray = new Tray(buildIcon());
  tray.setToolTip("openshuki");

  const refresh = (): void => {
    const win = getWindow();
    const visible = win?.isVisible() ?? false;
    const menu = Menu.buildFromTemplate([
      {
        label: visible ? "Hide window" : "Show window",
        click: () => {
          const w = getWindow();
          if (!w) return;
          if (w.isVisible()) w.hide();
          else {
            w.show();
            w.focus();
          }
          refresh();
        }
      },
      { type: "separator" },
      {
        label: "Open in browser",
        click: () => {
          const w = getWindow();
          const url = (w?.webContents.getURL() ?? "").trim();
          if (url.startsWith("http")) {
            void import("electron").then(({ shell }) => shell.openExternal(url));
          }
        }
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => onQuit()
      }
    ]);
    tray.setContextMenu(menu);
  };

  // Double-click to toggle the window.
  tray.on("double-click", () => {
    const w = getWindow();
    if (!w) return;
    if (w.isVisible()) w.hide();
    else {
      w.show();
      w.focus();
    }
    refresh();
  });

  refresh();
  const win = getWindow();
  if (win) {
    win.on("show", refresh);
    win.on("hide", refresh);
  }

  return {
    tray,
    destroy: () => tray.destroy()
  };
}
