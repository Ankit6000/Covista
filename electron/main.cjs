const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require("electron");
const path = require("path");

const isDev = !app.isPackaged;
const rendererUrl = process.env.ELECTRON_RENDERER_URL || "http://127.0.0.1:5173";
const hostedWebAppUrl = process.env.HOSTED_WEB_APP_URL || "";
const useHostedMode = Boolean(hostedWebAppUrl);
const backendBaseUrl = useHostedMode ? hostedWebAppUrl.replace(/\/+$/, "") : "http://127.0.0.1:3001";

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

let mainWindow = null;
let hostWindow = null;
let captureTimer = null;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function emitHostState() {
  if (!hostWindow || hostWindow.isDestroyed()) {
    sendToRenderer("host-browser:state", {
      isOpen: false,
      isCapturing: false,
      lastCaptureAt: null
    });
    return;
  }

  sendToRenderer("host-browser:state", {
    isOpen: true,
    url: hostWindow.webContents.getURL(),
    title: hostWindow.getTitle(),
    isCapturing: Boolean(captureTimer),
    lastCaptureAt: null
  });
}

async function captureHostFrame() {
  if (!hostWindow || hostWindow.isDestroyed() || hostWindow.isMinimized()) {
    return;
  }

  try {
    const bounds = hostWindow.getContentBounds();
    const width = Math.max(bounds.width || 1280, 1);
    const height = Math.max(bounds.height || 720, 1);
    const image = await hostWindow.webContents.capturePage();
    const jpeg = image.resize({ width: 640 }).toJPEG(18);
    sendToRenderer("host-browser:frame", {
      url: hostWindow.webContents.getURL(),
      title: hostWindow.getTitle(),
      frame: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
      aspectRatio: width / height,
      lastCaptureAt: Date.now()
    });
    sendToRenderer("host-browser:state", {
      isOpen: true,
      url: hostWindow.webContents.getURL(),
      title: hostWindow.getTitle(),
      isCapturing: true,
      lastCaptureAt: Date.now()
    });
  } catch (_error) {
    // Ignore transient capture failures during navigation.
  }
}

function startCaptureLoop() {
  if (captureTimer) {
    return;
  }

  captureTimer = setInterval(() => {
    captureHostFrame();
  }, 1200);
}

function stopCaptureLoop() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
}

function attachHostWindowEvents() {
  if (!hostWindow) {
    return;
  }

  hostWindow.on("closed", () => {
    hostWindow = null;
    stopCaptureLoop();
    emitHostState();
  });

  hostWindow.webContents.on("did-navigate", emitHostState);
  hostWindow.webContents.on("did-navigate-in-page", emitHostState);
  hostWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    emitHostState();
  });
}

async function ensureHostWindow() {
  if (hostWindow && !hostWindow.isDestroyed()) {
    hostWindow.focus();
    return hostWindow;
  }

  hostWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#111827",
    autoHideMenuBar: true,
    title: "RoomFlix Host Browser",
    webPreferences: {
      devTools: true,
      backgroundThrottling: false
    }
  });

  await hostWindow.loadURL("https://example.com");
  attachHostWindowEvents();
  emitHostState();
  return hostWindow;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#07111f",
    autoHideMenuBar: true,
    title: "RoomFlix Desktop",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (useHostedMode) {
    mainWindow.loadURL(hostedWebAppUrl);
  } else if (isDev) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      if (!hostWindow || hostWindow.isDestroyed()) {
        callback({});
        return;
      }

      try {
        const targetId = hostWindow.getMediaSourceId();
        const sources = await desktopCapturer.getSources({
          types: ["window"],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false
        });
        const source = sources.find((item) => item.id === targetId);

        if (!source) {
          callback({});
          return;
        }

        callback({
          video: source,
          audio: process.platform === "win32" ? "loopback" : undefined
        });
      } catch (_error) {
        callback({});
      }
    },
    { useSystemPicker: false }
  );

  createMainWindow();

  ipcMain.handle("host-browser:open", async () => {
    await ensureHostWindow();
    return { ok: true };
  });

  ipcMain.handle("host-browser:navigate", async (_event, targetUrl) => {
    const window = await ensureHostWindow();
    await window.loadURL(targetUrl);
    emitHostState();
    return { ok: true };
  });

  ipcMain.handle("host-browser:refresh", async () => {
    if (!hostWindow || hostWindow.isDestroyed()) {
      return { ok: false };
    }

    hostWindow.webContents.reload();
    return { ok: true };
  });

  ipcMain.handle("host-browser:back", async () => {
    if (!hostWindow || hostWindow.isDestroyed()) {
      return { ok: false };
    }

    if (hostWindow.webContents.canGoBack()) {
      hostWindow.webContents.goBack();
    }
    return { ok: true };
  });

  ipcMain.handle("host-browser:forward", async () => {
    if (!hostWindow || hostWindow.isDestroyed()) {
      return { ok: false };
    }

    if (hostWindow.webContents.canGoForward()) {
      hostWindow.webContents.goForward();
    }
    return { ok: true };
  });

  ipcMain.handle("host-browser:mouse-event", async (_event, payload) => {
    if (!hostWindow || hostWindow.isDestroyed()) {
      return { ok: false, reason: "host-window-missing" };
    }

    try {
      const bounds = hostWindow.getContentBounds();
      const x = Math.max(0, Math.min(bounds.width - 1, Math.round((payload?.xNorm || 0) * bounds.width)));
      const y = Math.max(0, Math.min(bounds.height - 1, Math.round((payload?.yNorm || 0) * bounds.height)));
      const type = payload?.type || "mouseMove";

      hostWindow.focus();

      if (type === "wheel") {
        hostWindow.webContents.sendInputEvent({
          type: "mouseWheel",
          x,
          y,
          deltaX: payload?.deltaX || 0,
          deltaY: payload?.deltaY || 0,
          modifiers: []
        });
        return { ok: true };
      }

      hostWindow.webContents.sendInputEvent({
        type,
        x,
        y,
        button: payload?.button || "left",
        clickCount: payload?.clickCount || 1,
        modifiers: []
      });

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: "mouse-event-failed",
        message: error?.message || "unknown"
      };
    }
  });

  ipcMain.handle("host-browser:key-event", async (_event, payload) => {
    if (!hostWindow || hostWindow.isDestroyed()) {
      return { ok: false, reason: "host-window-missing" };
    }

    try {
      hostWindow.focus();

      if (payload?.type === "char" && payload?.key) {
        hostWindow.webContents.sendInputEvent({
          type: "char",
          keyCode: payload.key
        });
        return { ok: true };
      }

      hostWindow.webContents.sendInputEvent({
        type: payload?.type || "keyDown",
        keyCode: payload?.key || "",
        modifiers: payload?.modifiers || []
      });

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: "key-event-failed",
        message: error?.message || "unknown"
      };
    }
  });

  ipcMain.handle("host-browser:upload-frame", async (_event, payload) => {
    const roomId = payload?.roomId;
    if (!roomId) {
      return { ok: false, reason: "missing-room-id" };
    }

    try {
      const response = await fetch(`${backendBaseUrl}/api/rooms/${roomId}/frame`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      return {
        ok: response.ok && Boolean(data?.ok),
        status: response.status,
        ...data
      };
    } catch (error) {
      return {
        ok: false,
        reason: "main-upload-failed",
        message: error?.message || "Unknown upload failure"
      };
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopCaptureLoop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
