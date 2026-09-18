import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AgentBridge, AgentEvent } from '../shared/protocol.ts';

/** Minimal typed bridge. Main is the authority: it re-validates the sender,
 *  the channel, and the command name; this surface exposes nothing else. */
const bridge: AgentBridge = {
  invoke(command, input) {
    return ipcRenderer.invoke('muster:invoke', command, input);
  },
  subscribe(listener) {
    const wrapped = (_event: IpcRendererEvent, event: AgentEvent) => listener(event);
    ipcRenderer.on('muster:event', wrapped);
    return () => {
      ipcRenderer.removeListener('muster:event', wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('muster', bridge);
