/**
 * The preload bridge.
 *
 * Exposes exactly the calls in `DesktopApi` and nothing else. No `require`, no
 * `ipcRenderer`, no `process` — the renderer gets a plain object of async
 * functions, which is the entire surface a compromised renderer could reach.
 */

import { contextBridge, ipcRenderer } from "electron";

import { CHANNELS, type DesktopApi, type ShellState } from "../shared/ipc.ts";

const api: DesktopApi = {
  resolve: (query, options) => ipcRenderer.invoke(CHANNELS.resolve, query, options),

  openCard: (card) => ipcRenderer.invoke(CHANNELS.openCard, card),
  navigate: (url) => ipcRenderer.invoke(CHANNELS.navigate, url),

  newTab: (url) => ipcRenderer.invoke(CHANNELS.newTab, url),
  closeTab: (id) => ipcRenderer.invoke(CHANNELS.closeTab, id),
  selectTab: (id) => ipcRenderer.invoke(CHANNELS.selectTab, id),
  goBack: () => ipcRenderer.invoke(CHANNELS.goBack),
  goForward: () => ipcRenderer.invoke(CHANNELS.goForward),
  reload: () => ipcRenderer.invoke(CHANNELS.reload),
  showCards: () => ipcRenderer.invoke(CHANNELS.showCards),

  getRules: () => ipcRenderer.invoke(CHANNELS.getRules),
  block: (domain) => ipcRenderer.invoke(CHANNELS.block, domain),
  unblock: (domain) => ipcRenderer.invoke(CHANNELS.unblock, domain),
  pin: (domain) => ipcRenderer.invoke(CHANNELS.pin, domain),
  unpin: (domain) => ipcRenderer.invoke(CHANNELS.unpin, domain),

  getHistory: (limit) => ipcRenderer.invoke(CHANNELS.getHistory, limit),
  getFavourites: () => ipcRenderer.invoke(CHANNELS.getFavourites),
  toggleFavourite: (entry) => ipcRenderer.invoke(CHANNELS.toggleFavourite, entry),
  clearAllData: () => ipcRenderer.invoke(CHANNELS.clearAllData),

  getByokStatus: () => ipcRenderer.invoke(CHANNELS.getByokStatus),
  setByok: (settings) => ipcRenderer.invoke(CHANNELS.setByok, settings),

  onShellState: (listener) => {
    const handler = (_event: unknown, state: ShellState) => listener(state);
    ipcRenderer.on(CHANNELS.shellState, handler);
    return () => {
      ipcRenderer.off(CHANNELS.shellState, handler);
    };
  },
};

contextBridge.exposeInMainWorld("jab", api);
