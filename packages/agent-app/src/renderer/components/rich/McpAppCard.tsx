/**
 * #844 MCP Apps: the interactive UI an MCP tool declared (a `ui://` resource, spec 2026-01-26), drawn under its tool row like a
 * render_html page. It is served scripts-only from its own `muster-report://` origin with no network until the person allows the
 * hosts it declared (Allow for this page). It talks to Muster only through the MCP Apps bridge: it gets the tool's input and
 * result, may call tools on its own server (the runtime applies the chat's access level and approvals), may ask to open a link
 * (in the in-app browser, only on a click) and may put text in the composer (never sent). If it cannot be opened, the tool's
 * text result is shown instead.
 */
import React, {useEffect, useRef, useState} from 'react';
import {createMcpAppBridge, type McpAppBridge, type McpAppView} from '../../../shared/mcp-apps';
import {invoke} from '../../bridge';
import {useHtmlRenderTheme} from '../../htmlRenderTheme';
import {getState, notifyError, openBrowserTab, setComposerDraft} from '../../store';
import {isWebHost} from '../../webHost';
import {RichBlock} from '../RichBlock';
import {SandboxedHtml} from '../SandboxedHtml';
import {inlinePageHeight} from './pageTools';
import '../rich-block.css';

const INLINE_MIN = 80, INLINE_MAX = 960;

export interface McpAppCardProps {
  chatId: string;
  /** The tool row. */
  itemId: string;
  /** The row's subject ("board / show_board"), shown until the app is open. */
  title: string;
  /** The tool's text result: shown when the app cannot be opened. */
  fallback: string;
}

/** The text goes after anything already typed; nothing is sent. */
function addToComposer(chatId: string, text: string): void {
  const state = getState(), current = state.composerDrafts[chatId]?.text ?? state.snapshot?.chats.find(chat => chat.id === chatId)?.draft ?? '';
  setComposerDraft(chatId, current.trim() ? `${current.replace(/\s+$/, '')}\n\n${text}` : text);
}

export default function McpAppCard({chatId, itemId, title: rowTitle, fallback}: McpAppCardProps): React.ReactElement {
  const [app, setApp] = useState<McpAppView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const [allowing, setAllowing] = useState(false);
  const theme = useHtmlRenderTheme();
  const appRef = useRef<McpAppView | null>(null); appRef.current = app;
  const themeRef = useRef(theme); themeRef.current = theme;
  /** One bridge per served document: a reload (after Allow) starts a fresh handshake. */
  const bridge = useRef<{revision: number; bridge: McpAppBridge} | null>(null);
  const title = app?.title ?? rowTitle;
  // A theme switch reaches an initialized app as host-context-changed; the frame is not reloaded.
  useEffect(() => { bridge.current?.bridge.contextChanged({theme: theme.appearance}); }, [theme.appearance]);

  if (failed || isWebHost()) return <div className="mcp-app-fallback" role="note">
    <p className="mcp-app-fallback-note">{failed ? `Couldn’t open this app, so its text result is shown. ${failed}` : 'This app opens in the Muster desktop app; its text result is shown.'}</p>
    {fallback ? <pre className="tool-row-excerpt">{fallback}</pre> : null}
  </div>;

  const bridgeFor = (reply: (message: unknown) => void): McpAppBridge | undefined => {
    const view = appRef.current;
    if (!view) return undefined;
    if (bridge.current?.revision !== revision) {
      bridge.current?.bridge.close();
      bridge.current = {revision, bridge: createMcpAppBridge({
        post: message => reply(message), toolInput: view.toolInput, toolResult: view.toolResult,
        callTool: (name, args) => invoke('mcp.apps.callTool', {chatId, itemId, name, arguments: args}),
        openLink: url => openBrowserTab(url),
        toComposer: text => addToComposer(chatId, text),
        onSize: value => setHeight(value),
        hostContext: () => ({theme: themeRef.current.appearance, displayMode: 'inline', availableDisplayModes: ['inline'], toolInfo: {tool: {name: view.tool}},
          containerDimensions: {maxHeight: INLINE_MAX}, platform: 'desktop', locale: typeof navigator !== 'undefined' ? (navigator as Navigator).language : undefined}),
      })};
    }
    return bridge.current.bridge;
  };
  const allow = async () => {
    setAllowing(true);
    try { await invoke('mcp.apps.allowNetwork', {chatId, itemId}); setRevision(value => value + 1); }
    catch (cause) { notifyError(cause); }
    finally { setAllowing(false); }
  };
  const inlineHeight = inlinePageHeight(height, INLINE_MIN, INLINE_MAX);
  const askNetwork = !!app && app.networkRequested && !app.networkAllowed;
  return <RichBlock kind="report" kindLabel="App" title={title} status="ready" variant="inline" fullscreen={false} description={`App from ${title}`}>
    {context => <>
      {askNetwork && context.mode === 'inline' && <div className="rich-network" role="note">
        <span>This app wants to load content from {[...new Set([...app!.domains.connect, ...app!.domains.resource])].map(host => host.replace(/^https:\/\//, '')).join(', ')}. It is shown without it.</span>
        <button type="button" disabled={allowing} onClick={() => void allow()}>Allow for this page</button>
      </div>}
      <div className="rich-report" data-mode={context.mode} style={inlineHeight ? {['--rich-report-height' as string]: `${inlineHeight}px`} : undefined}>
        {context.suspended ? null : <div className="rich-report-zoom">
          <SandboxedHtml key={revision} html="" mcpApp={{chatId, itemId}} revision={revision} lazy title={`${title} (app)`} className="rich-report-sandbox" debounceMs={0}
            onHeight={setHeight} onApp={setApp} onError={setFailed}
            onFrameMessage={(data, frame) => void bridgeFor(frame.reply)?.receive(data, {userActive: frame.userActive})}/>
        </div>}
      </div>
    </>}
  </RichBlock>;
}
