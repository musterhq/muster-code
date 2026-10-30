/** The scenes only the new code has: a render_html tool row (the real ToolCard), network opt-in, full screen with zoom and the
 *  local server cards. Imports harness.tsx first so its stub and scenes exist. Not shipped. */
import React from 'react';
import {handlers, scenes} from './harness';
import {ToolCard} from '../../src/renderer/components/ToolCard';
import {LocalServerCards} from '../../src/renderer/components/LocalServerCards';
import {DASHBOARD, NETWORK_PAGE} from './fixtures';

const pages: Record<string, {html: string; title: string; networkRequested: boolean; networkAllowed: boolean}> = {
  ['d'.repeat(32)]: {html: DASHBOARD, title: 'Checkout funnel, last 30 days', networkRequested: false, networkAllowed: false},
  ['e'.repeat(32)]: {html: NETWORK_PAGE, title: 'Live crypto prices', networkRequested: true, networkAllowed: false},
};
handlers['htmlRenders.open'] = async input => {
  const page = pages[input.id]!;
  const served = await (await fetch('/register', {method: 'POST', body: JSON.stringify({html: page.html, scripts: true, themed: true, network: page.networkAllowed})})).json();
  return {...served, page: {id: input.id, createdAt: '', ...page}};
};
handlers['processes.ports'] = input => ({chatId: input.chatId, supported: true, scannedAt: '', ports: [
  {id: 'listener:1', port: 5173, address: '*', name: 'node', owner: 'agent', source: {kind: 'agent'}, web: true},
  {id: 'listener:2', port: 9229, address: '127.0.0.1', name: 'node', owner: 'agent', source: {kind: 'agent'}, web: false},
]});

const row = (id: string, title: string) => ({id: `t-${id}`, chatId: 'c1', kind: 'tool' as const, text: '', status: 'completed', createdAt: '2026-10-18T10:00:00Z',
  data: {type: 'mcpToolCall', server: 'muster_browser', tool: 'render_html', arguments: {title, html: '…'}, result: {content: [{type: 'text', text: `Shown to the user inline as “${title}” (muster-html:${id}).`}]}}});

scenes.render = () => <div className="harness-col"><p className="harness-text">I built the funnel dashboard from the last 30 days of checkout events.</p><ToolCard item={row('d'.repeat(32), 'Checkout funnel, last 30 days')}/><p className="harness-text">Orders dipped in week 3 while sessions grew, so the drop is in payment, not traffic.</p></div>;
scenes.network = () => <div className="harness-col"><ToolCard item={row('e'.repeat(32), 'Live crypto prices')}/></div>;
scenes.servers = () => <div className="harness-col harness-bottom"><p className="harness-text">The dev server is up on port 5173.</p><LocalServerCards chatId="c1"/><div className="harness-composer">Ask for follow-up changes</div></div>;
