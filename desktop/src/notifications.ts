// Tiny local HTTP listener in the Electron main process. The backend's
// notifications.windows channel adapter POSTs {title, body, runId} here;
// we show a native Notification and forward clicks back to the main
// window (focused + navigated to the relevant run).

import { BrowserWindow, Notification } from "electron";
import http from "node:http";

export type NotifyServer = {
  port: number;
  stop: () => Promise<void>;
};

type NotifyPayload = {
  title: string;
  body: string;
  runId?: string;
  soundEnabled?: boolean;
};

function isPayload(v: unknown): v is NotifyPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.title === "string" && typeof o.body === "string";
}

export async function startNotifyServer(
  getWindow: () => BrowserWindow | null
): Promise<NotifyServer> {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/notify") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!isPayload(body)) {
          res.writeHead(400);
          res.end("invalid payload");
          return;
        }
        showToast(body, getWindow);
        res.writeHead(204);
        res.end();
      } catch (err) {
        res.writeHead(500);
        res.end(err instanceof Error ? err.message : "error");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("notify server: unexpected listen address");
  }

  return {
    port: addr.port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

function showToast(p: NotifyPayload, getWindow: () => BrowserWindow | null): void {
  if (!Notification.isSupported()) {
    console.warn("[desktop/notifications] native notifications not supported");
    return;
  }
  const n = new Notification({
    title: p.title,
    body: p.body,
    silent: p.soundEnabled === false
  });
  n.on("click", () => {
    const win = getWindow();
    if (!win) return;
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
    if (p.runId) {
      // The frontend has no router today — fire a custom event the React
      // store can listen for and navigate the center view.
      void win.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent("openshuki:open-run", { detail: { runId: ${JSON.stringify(
          p.runId
        )} } }))`
      );
    }
  });
  n.show();
}
