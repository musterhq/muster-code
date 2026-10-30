/**
 * Screenshot harness for agent HTML and previews: mounts the real components with the real stylesheet and theme tokens
 * against a bridge stub whose pages are served by shots.mjs exactly as the report origin serves them (same body, same CSP).
 * Builds against either tree (before/after); harness-after.tsx adds the scenes only the new code has. Not shipped.
 */
import React from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {RichFence} from '../../src/renderer/components/RichFence';
import {BrowserTab} from '../../src/renderer/components/BrowserTab';
import {TipProvider} from '../../src/renderer/components/Tooltip';
import {MUSTER_DARK, MUSTER_LIGHT, applyThemeTokens} from '../../src/shared/theme';
import {DASHBOARD} from './fixtures';

type Handler = (input: any) => unknown;
export const handlers: Record<string, Handler> = {};
const register = async (html: string, scripts: boolean, extra: Record<string, unknown> = {}) => {
  const response = await fetch('/register', {method: 'POST', body: JSON.stringify({html, scripts, ...extra})});
  return await response.json() as {url: string; token: string};
};
handlers['reports.open'] = input => register(input.html, input.scripts !== false, {themed: input.themed === true});
const browserState = (owner: string) => ({owner, profileId: 'personal', revision: 1, url: 'http://localhost:5173/', title: 'localhost:5173', loading: false, canGoBack: false, canGoForward: false, visible: true, viewport: 'fill', consoleCount: 0, consoleErrors: 0,
  error: 'Could not load this page (-102): ERR_CONNECTION_REFUSED', loadError: {url: 'http://localhost:5173/', code: -102, description: 'ERR_CONNECTION_REFUSED'}});
handlers['browser.status'] = input => browserState(input.owner);
handlers['browser.open'] = input => browserState(input.owner);
(window as any).muster = {subscribe: () => () => {}, async invoke(command: string, input: any) { const handler = handlers[command]; return handler ? handler(input) : undefined; }};

export function applyTheme(dark: boolean): void {
  const theme = dark ? MUSTER_DARK : MUSTER_LIGHT;
  document.documentElement.setAttribute('data-theme', theme.base);
  applyThemeTokens(document.documentElement, theme);
}

export const scenes: Record<string, () => React.ReactNode> = {
  report: () => <div className="harness-col"><p className="harness-text">Here is the checkout funnel for the last 30 days. Orders dipped in week 3 while sessions grew, so the drop is in payment, not traffic.</p><RichFence kind="report" source={DASHBOARD}/></div>,
  unreachable: () => <div className="harness-pane"><BrowserTab owner="browser:preview" profileId="personal" initialUrl="http://localhost:5173/"/></div>,
};

let root: Root | null = null;
(window as any).harness = {
  show(name: string, dark: boolean) {
    applyTheme(dark);
    root?.unmount(); root = createRoot(document.getElementById('stage')!);
    root.render(<TipProvider>{scenes[name]?.() ?? <p>unknown scene {name}</p>}</TipProvider>);
  },
  has: (name: string) => name in scenes,
};
document.body.dataset.harness = 'ready';
