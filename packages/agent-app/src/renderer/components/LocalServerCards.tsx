/**
 * #html-preview: the dev servers this conversation started, offered above the composer: "Preview" streams it to the live
 * mini player through the chat's agent browser tab, "Open" opens it in the right pane's browser. Adapted from T3 Code's
 * local-server cards (MIT; see THIRD-PARTY-NOTICES.md): only listeners this chat's own shells, commands and agent processes
 * started are listed (S3-E attribution), and only those that answer with a web page. Uses the existing port poller (4 s,
 * backing off to 30 s, paused while the window is hidden), so an idle chat costs nothing.
 */
import React, {useState} from 'react';
import {ExternalLink, PictureInPicture2, Radio, X} from 'lucide-react';
import type {ListeningPort} from '../../shared/process-protocol';
import {invoke} from '../bridge';
import {portURL, useListeningPorts} from '../processSummary';
import {notifyError, openBrowserTab} from '../store';
import {Tip} from './Tooltip';
import './local-server-cards.css';

const MAX_CARDS = 3;
/** Dismissed per chat for this session; a server that restarts on a new port is offered again. */
const dismissed = new Map<string, Set<string>>();

export function webServers(ports: readonly ListeningPort[], hidden: ReadonlySet<string>): ListeningPort[] {
  const seen = new Set<number>();
  return ports.filter(port => port.web === true && !hidden.has(port.id) && !seen.has(port.port) && (seen.add(port.port), true)).slice(0, MAX_CARDS);
}

export function LocalServerCards({chatId}: {chatId: string}): React.ReactElement | null {
  const {ports} = useListeningPorts(chatId);
  const [, bump] = useState(0);
  const hidden = dismissed.get(chatId) ?? new Set<string>();
  const servers = webServers(ports, hidden);
  if (!servers.length) return null;
  const hide = (id: string) => { const set = dismissed.get(chatId) ?? new Set<string>(); set.add(id); dismissed.set(chatId, set); bump(value => value + 1); };
  return <div className="local-servers" role="list" aria-label="Local servers">
    {servers.map(server => {
      const url = portURL(server), label = url.replace(/^https?:\/\//, '');
      const by = server.owner === 'agent' ? 'Started by the agent' : server.source.kind === 'terminal' ? 'Started in a terminal' : 'Started by a command';
      return <div key={server.id} className="local-server" role="listitem" title={`${by} · ${server.name}`}>
        <Radio size={13} className="local-server-live" aria-hidden="true"/>
        <span className="local-server-text"><span className="local-server-label">Local server</span><span className="local-server-url">{label}</span>{server.name && <span className="local-server-name">{server.name}</span>}</span>
        <Tip label="Preview in the mini player"><button type="button" className="local-server-action" onClick={() => void invoke('previews.open', {chatId, url}).catch(notifyError)}><PictureInPicture2 size={13} aria-hidden="true"/>Preview</button></Tip>
        <Tip label="Open in the browser pane"><button type="button" className="local-server-action" onClick={() => openBrowserTab(url)}><ExternalLink size={13} aria-hidden="true"/>Open</button></Tip>
        <Tip label="Dismiss"><button type="button" className="local-server-dismiss" aria-label={`Dismiss ${label}`} onClick={() => hide(server.id)}><X size={12} aria-hidden="true"/></button></Tip>
      </div>;
    })}
  </div>;
}
