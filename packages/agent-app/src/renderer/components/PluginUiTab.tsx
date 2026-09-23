/**
 * EXT-10 Plugin UI: a plugin app's own HTML rendered in `<iframe sandbox="allow-scripts">` from its isolated
 * `muster-plugin://<token>/` origin (served by main with a no-network CSP). Scripts run in an opaque origin with no
 * access to Muster, Node or the preload bridge; the only way out is the allowlisted postMessage bridge below.
 */
import React, {useEffect, useRef, useState} from 'react';
import {invoke} from '../bridge';
import {activeChat, getState, openBrowserTab, pushNotice, setComposerDraft, type WorkspaceTab} from '../store';
import {pluginUiLimiter, pluginUiRequest, type PluginUiHostMessage} from '../../shared/plugin-ui-bridge';
import {ResourceState} from './ResourceState';
import './plugin-ui.css';

export function PluginUiTab({tab}: {tab: WorkspaceTab}): React.ReactElement {
  const [frame, setFrame] = useState<{url: string; title: string} | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const ref = useRef<HTMLIFrameElement>(null);
  const load = () => {
    setError(null); setFrame(null);
    void invoke('plugins.ui.open', {pluginId: tab.pluginId!, app: tab.appName!}).then(setFrame, cause => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  useEffect(load, [tab.pluginId, tab.appName]);
  useEffect(() => {
    if (!frame) return;
    const allow = pluginUiLimiter();
    const onMessage = (event: MessageEvent) => {
      // Only this tab's own frame, whose sandboxed origin is opaque ("null").
      if (!ref.current || event.source !== ref.current.contentWindow || event.origin !== 'null') return;
      const request = pluginUiRequest(event.data);
      if (!request || !allow(request.type)) return;
      const label = tab.appName ?? 'Plugin';
      switch (request.type) {
        case 'muster:ready': {
          const reply: PluginUiHostMessage = {type: 'muster:context', theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', plugin: tab.title, app: label, ...(activeChat() ? {chatTitle: activeChat()!.title} : {})};
          ref.current.contentWindow?.postMessage(reply, '*');
          return;
        }
        case 'muster:resize': setHeight(request.height); return;
        case 'muster:notify': pushNotice(`${label}: ${request.message}`, {kind: 'info'}); return;
        case 'muster:openLink': openBrowserTab(request.url); return;
        case 'muster:insertPrompt': {
          const chat = activeChat();
          if (!chat) { pushNotice(`${label} wanted to add text to a prompt; open a chat first.`, {kind: 'info'}); return; }
          const current = getState().composerDrafts[chat.id]?.text ?? chat.draft ?? '';
          setComposerDraft(chat.id, current ? `${current}\n${request.text}` : request.text);
          pushNotice(`${label} added text to your prompt. Review it before sending.`, {kind: 'info'});
          return;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame, tab.appName, tab.title]);
  if (error) return <ResourceState kind="error" message="Plugin UI unavailable" detail={error} onRetry={load}/>;
  if (!frame) return <ResourceState kind="loading" label="Opening plugin UI…"/>;
  return <div className="plugin-ui">
    <p className="plugin-ui-note">Runs isolated: no network, no access to Muster or your files. It can show notices, open links in the browser tab and suggest prompt text.</p>
    <iframe ref={ref} className="plugin-ui-frame" title={frame.title} src={frame.url} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="" style={height ? {height} : undefined}/>
  </div>;
}
