const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopHost", {
  isDesktop: true,
  openHostBrowser: () => ipcRenderer.invoke("host-browser:open"),
  navigateHostBrowser: (url) => ipcRenderer.invoke("host-browser:navigate", url),
  refreshHostBrowser: () => ipcRenderer.invoke("host-browser:refresh"),
  goBackHostBrowser: () => ipcRenderer.invoke("host-browser:back"),
  goForwardHostBrowser: () => ipcRenderer.invoke("host-browser:forward"),
  sendHostBrowserMouseEvent: (payload) => ipcRenderer.invoke("host-browser:mouse-event", payload),
  sendHostBrowserKeyEvent: (payload) => ipcRenderer.invoke("host-browser:key-event", payload),
  startHostBrowserAudioCapture: () => ipcRenderer.invoke("host-browser:start-audio-capture"),
  stopHostBrowserAudioCapture: () => ipcRenderer.invoke("host-browser:stop-audio-capture"),
  uploadRoomFrame: (payload) => ipcRenderer.invoke("host-browser:upload-frame", payload),
  openDeepLink: (url) => ipcRenderer.invoke("app:open-deep-link", url),
  getPendingLaunchRoom: () => ipcRenderer.invoke("app:get-pending-launch-room"),
  getRuntimeConfig: () => ipcRenderer.invoke("app:get-runtime-config"),
  clearPendingLaunchRoom: (roomId) => ipcRenderer.invoke("app:clear-pending-launch-room", roomId),
  onHostBrowserState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("host-browser:state", listener);
    return () => ipcRenderer.removeListener("host-browser:state", listener);
  },
  onHostBrowserFrame: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("host-browser:frame", listener);
    return () => ipcRenderer.removeListener("host-browser:frame", listener);
  },
  onHostBrowserAudioChunk: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("host-browser:audio-chunk", listener);
    return () => ipcRenderer.removeListener("host-browser:audio-chunk", listener);
  },
  onLaunchRoom: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("app:launch-room", listener);
    return () => ipcRenderer.removeListener("app:launch-room", listener);
  }
});
