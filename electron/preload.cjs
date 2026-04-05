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
  uploadRoomFrame: (payload) => ipcRenderer.invoke("host-browser:upload-frame", payload),
  openDeepLink: (url) => ipcRenderer.invoke("app:open-deep-link", url),
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
  onLaunchRoom: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("app:launch-room", listener);
    return () => ipcRenderer.removeListener("app:launch-room", listener);
  }
});
