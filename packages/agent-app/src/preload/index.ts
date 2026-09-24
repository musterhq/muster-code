import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AgentBridge, AgentEvent } from '../shared/protocol.ts';
import { isMenuAction, MENU_CHANNEL, MENU_CLOSE_CHANNEL, type MenuBridge } from '../shared/menu-protocol.ts';

/** One IPC listener multiplexes every renderer subscription; adding an
 *  ipcRenderer listener per subscriber leaked (MaxListenersExceededWarning). */
const eventListeners = new Set<(event: AgentEvent) => void>();
let dispatcherInstalled = false;
function ensureEventDispatcher(): void {
  if (dispatcherInstalled) return;
  dispatcherInstalled = true;
  ipcRenderer.on('muster:event', (_event: IpcRendererEvent, event: AgentEvent) => {
    for (const listener of [...eventListeners]) {
      try { listener(event); } catch (error) { console.error('muster:event listener failed', error); }
    }
  });
}

/** Minimal typed bridge. Main is the authority: it re-validates the sender,
 *  the channel, and the command name; this surface exposes nothing else. */
const bridge: AgentBridge = {
  invoke(command, input) {
    return ipcRenderer.invoke('muster:invoke', command, input);
  },
  subscribe(listener) {
    eventListeners.add(listener);
    ensureEventDispatcher();
    return () => {
      eventListeners.delete(listener);
    };
  },
};

/** Native menu intents. Only known action names cross into the page. */
const menu: MenuBridge = {
  onAction(listener) {
    const wrapped = (_event: IpcRendererEvent, action: unknown) => { if (isMenuAction(action)) listener(action); };
    ipcRenderer.on(MENU_CHANNEL, wrapped);
    return () => { ipcRenderer.removeListener(MENU_CHANNEL, wrapped); };
  },
  closeWindow() {
    ipcRenderer.send(MENU_CLOSE_CHANNEL);
  },
};

contextBridge.exposeInMainWorld('muster', bridge);
contextBridge.exposeInMainWorld('musterMenu', menu);
