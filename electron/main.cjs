const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require("electron");
const path = require("path");
const { startAudioCapture, stopAudioCapture, setExecutablesRoot } = require("application-loopback");

const initialDeepLinkArg = process.argv.find((value) => typeof value === "string" && value.startsWith("covista://")) || null;
const isDev = !app.isPackaged;
const rendererUrl = process.env.ELECTRON_RENDERER_URL || "http://127.0.0.1:5173";
const packagedHostedWebAppUrl = "https://covista-4hyb.onrender.com";
const hostedWebAppUrl =
  process.env.HOSTED_WEB_APP_URL ||
  (app.isPackaged ? packagedHostedWebAppUrl : "");
const useHostedMode = Boolean(hostedWebAppUrl);
if (app.isPackaged) {
  setExecutablesRoot(path.join(process.resourcesPath, "application-loopback-bin"));
}

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion,WebRtcAllowInputVolumeAdjustment");

let mainWindow = null;
let hostWindow = null;
let captureTimer = null;
let pendingLaunchRoom = null;
let activePublicOriginOverride = "";
let activeHostAudioProcessId = null;
let hostAudioCaptureRequested = false;

function getPendingLaunchRoomSnapshot() {
  if (!pendingLaunchRoom) {
    return null;
  }

  return { ...pendingLaunchRoom };
}

function getDeepLinkUrlFromArgv(argv = []) {
  return argv.find((value) => typeof value === "string" && value.startsWith("covista://")) || null;
}

function parseLaunchRoom(urlString) {
  if (!urlString) {
    return null;
  }

  try {
    const url = new URL(urlString);
    const roomId = (url.searchParams.get("room") || "").trim().toUpperCase();
    const username = String(url.searchParams.get("name") || "").trim().slice(0, 32);
    const hostKey = String(url.searchParams.get("hostKey") || "").trim();
    const origin = String(url.searchParams.get("origin") || "").trim();
    if (!roomId) {
      return null;
    }

    return {
      roomId,
      username,
      hostKey,
      origin,
      source: urlString
    };
  } catch (_error) {
    return null;
  }
}

function normalizeOrigin(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    return url.origin;
  } catch (_error) {
    return "";
  }
}

function getActivePublicAppUrl() {
  const launchOrigin = normalizeOrigin(activePublicOriginOverride || pendingLaunchRoom?.origin);
  if (launchOrigin) {
    return launchOrigin;
  }

  if (hostedWebAppUrl) {
    return hostedWebAppUrl.replace(/\/+$/, "");
  }

  return rendererUrl.replace(/\/+$/, "");
}

function getActiveBackendBaseUrl() {
  const publicUrl = getActivePublicAppUrl();
  if (!publicUrl) {
    return "http://127.0.0.1:3001";
  }

  try {
    const url = new URL(publicUrl);
    const isLocalRenderer = ["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "5173";
    if (isLocalRenderer) {
      return `${url.protocol}//${url.hostname}:3001`;
    }
    return publicUrl;
  } catch (_error) {
    return "http://127.0.0.1:3001";
  }
}

function dispatchPendingLaunchRoom() {
  if (!mainWindow || mainWindow.isDestroyed() || !pendingLaunchRoom) {
    return;
  }

  mainWindow.webContents.send("app:launch-room", getPendingLaunchRoomSnapshot());
}

function shouldReloadMainWindowForActiveOrigin() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  const targetUrl = getActivePublicAppUrl();
  const currentUrl = String(mainWindow.webContents.getURL() || "").trim();
  if (!targetUrl || !currentUrl) {
    return false;
  }

  try {
    return new URL(targetUrl).origin !== new URL(currentUrl).origin;
  } catch (_error) {
    return false;
  }
}

function registerProtocolHandler() {
  if (process.defaultApp) {
    app.setAsDefaultProtocolClient("covista", process.execPath, [path.resolve(process.argv[1] || "")]);
    return;
  }

  app.setAsDefaultProtocolClient("covista");
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function getHostErrorPage(title, message, details = "") {
  return `data:text/html;charset=UTF-8,${encodeURIComponent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #07111f;
        color: #f4f7fb;
        font-family: Segoe UI, Arial, sans-serif;
      }
      .card {
        width: min(720px, calc(100vw - 48px));
        padding: 32px;
        border-radius: 24px;
        background: rgba(12, 23, 41, 0.95);
        border: 1px solid rgba(120, 155, 210, 0.22);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 30px;
      }
      p {
        margin: 0 0 10px;
        line-height: 1.5;
        color: #cfd8e6;
      }
      code {
        display: block;
        margin-top: 18px;
        padding: 14px 16px;
        border-radius: 14px;
        background: #040b16;
        color: #8dd6ff;
        white-space: pre-wrap;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${message}</p>
      ${details ? `<code>${details}</code>` : ""}
    </div>
  </body>
</html>`)}`;
}

function stopHostAudioCapture() {
  if (!activeHostAudioProcessId) {
    return;
  }

  try {
    stopAudioCapture(String(activeHostAudioProcessId));
  } catch (_error) {
    // Ignore shutdown races from the helper process.
  }

  activeHostAudioProcessId = null;
}

function syncHostAudioCapture() {
  if (!hostAudioCaptureRequested || !hostWindow || hostWindow.isDestroyed()) {
    stopHostAudioCapture();
    return {
      ok: false,
      reason: "host-window-missing"
    };
  }

  const processId = process.pid;
  if (!processId) {
    return {
      ok: false,
      reason: "host-process-missing"
    };
  }

  if (String(activeHostAudioProcessId) === String(processId)) {
    return {
      ok: true,
      processId
    };
  }

  stopHostAudioCapture();

  try {
    startAudioCapture(String(processId), {
      onData: (chunk) => {
        sendToRenderer("host-browser:audio-chunk", chunk);
      }
    });
    activeHostAudioProcessId = processId;
    return {
      ok: true,
      processId
    };
  } catch (error) {
    return {
      ok: false,
      reason: "audio-capture-failed",
      message: error?.message || "Unknown audio capture failure"
    };
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
    stopHostAudioCapture();
    emitHostState();
  });

  hostWindow.webContents.on("did-finish-load", () => {
    emitHostState();
    syncHostAudioCapture();
  });
  hostWindow.webContents.on("did-navigate", () => {
    emitHostState();
    syncHostAudioCapture();
  });
  hostWindow.webContents.on("did-navigate-in-page", () => {
    emitHostState();
    syncHostAudioCapture();
  });
  hostWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    emitHostState();
  });

  hostWindow.webContents.on("did-fail-load", async (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || !hostWindow || hostWindow.isDestroyed()) {
      return;
    }

    const isIgnorable = errorCode === -3;
    if (isIgnorable) {
      return;
    }

    await hostWindow.loadURL(
      getHostErrorPage(
        "Page failed to load",
        "Covista could not open that page inside the desktop host browser.",
        `${validatedURL || "Unknown URL"}\n${errorCode}: ${errorDescription || "Unknown navigation failure"}`
      )
    );
    emitHostState();
  });

  hostWindow.webContents.on("render-process-gone", async (_event, details) => {
    if (!hostWindow || hostWindow.isDestroyed()) {
      return;
    }

    await hostWindow.loadURL(
      getHostErrorPage(
        "Browser crashed",
        "The desktop host browser renderer stopped unexpectedly.",
        `${details?.reason || "unknown"}`
      )
    );
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

  attachHostWindowEvents();
  await hostWindow.loadURL(
    getHostErrorPage(
      "Host browser ready",
      "Paste a URL in Covista and click Open Page to load a site into the shared browser."
    )
  );
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

  const initialMainWindowUrl = getActivePublicAppUrl();

  if (initialMainWindowUrl) {
    mainWindow.loadURL(initialMainWindowUrl);
  } else if (isDev) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.webContents.on("did-finish-load", () => {
    dispatchPendingLaunchRoom();
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const launchRoom = parseLaunchRoom(getDeepLinkUrlFromArgv(argv));
    if (launchRoom) {
      pendingLaunchRoom = launchRoom;
      activePublicOriginOverride = launchRoom.origin || activePublicOriginOverride;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      if (launchRoom && shouldReloadMainWindowForActiveOrigin()) {
        mainWindow.loadURL(getActivePublicAppUrl());
      }
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
      dispatchPendingLaunchRoom();
    }
  });
}

app.whenReady().then(() => {
  registerProtocolHandler();

  const initialLaunchRoom = parseLaunchRoom(getDeepLinkUrlFromArgv(process.argv));
  if (initialLaunchRoom) {
    pendingLaunchRoom = initialLaunchRoom;
    activePublicOriginOverride = initialLaunchRoom.origin || activePublicOriginOverride;
  }

  app.on("open-url", (event, urlString) => {
    event.preventDefault();
    const launchRoom = parseLaunchRoom(urlString);
    if (launchRoom) {
      pendingLaunchRoom = launchRoom;
      activePublicOriginOverride = launchRoom.origin || activePublicOriginOverride;
      if (shouldReloadMainWindowForActiveOrigin()) {
        mainWindow.loadURL(getActivePublicAppUrl());
      }
      dispatchPendingLaunchRoom();
    }
  });

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
          audio: false,
          enableLocalEcho: false
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
      const response = await fetch(`${getActiveBackendBaseUrl()}/api/rooms/${roomId}/frame`, {
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

  ipcMain.handle("host-browser:start-audio-capture", async () => {
    hostAudioCaptureRequested = true;
    return syncHostAudioCapture();
  });

  ipcMain.handle("host-browser:stop-audio-capture", async () => {
    hostAudioCaptureRequested = false;
    stopHostAudioCapture();
    return { ok: true };
  });

  ipcMain.handle("app:open-deep-link", async (_event, urlString) => {
    const launchRoom = parseLaunchRoom(urlString);
    if (!launchRoom) {
      return { ok: false, reason: "invalid-room-link" };
    }

    pendingLaunchRoom = launchRoom;
    activePublicOriginOverride = launchRoom.origin || activePublicOriginOverride;
    if (shouldReloadMainWindowForActiveOrigin()) {
      await mainWindow.loadURL(getActivePublicAppUrl());
    }
    dispatchPendingLaunchRoom();
    return { ok: true };
  });

  ipcMain.handle("app:get-pending-launch-room", async () => {
    return getPendingLaunchRoomSnapshot();
  });

  ipcMain.handle("app:get-runtime-config", async () => {
    return {
      publicAppUrl: getActivePublicAppUrl(),
      backendBaseUrl: getActiveBackendBaseUrl()
    };
  });

  ipcMain.handle("app:clear-pending-launch-room", async (_event, roomId) => {
    if (!pendingLaunchRoom) {
      return { ok: true, cleared: false };
    }

    if (roomId && pendingLaunchRoom.roomId && String(roomId).toUpperCase() !== String(pendingLaunchRoom.roomId).toUpperCase()) {
      return { ok: true, cleared: false };
    }

    pendingLaunchRoom = null;
    return { ok: true, cleared: true };
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopCaptureLoop();
  stopHostAudioCapture();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
