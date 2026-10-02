// The connect flow of Settings › Integrations › Muster Server, state by state, from the real renderer in headless Chrome (numbered).
//   UNIFY_DATA=<dir with shots-data-a.json, shots-data-b.json> SHOTS_FILE=scripts/readme-shots/unify-connect-shots.mjs SHOTS_TMP=<dir> \
//     node scripts/readme-shots/shoot.mjs --probe 01-not-connected 02-local-found ...
import {readFileSync} from 'node:fs';
import path from 'node:path';

const dir = process.env.UNIFY_DATA;
const read = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
const A = read('shots-data-a.json'), B = read('shots-data-b.json');
const OFF = {mode: 'off', baseUrl: 'http://127.0.0.1:3100', hasToken: false, secureStorage: true, companyId: null, backend: null, compatibility: null, user: null, signedIn: null, signInNotice: null, serverVersion: null, connectedAt: null, signIn: []};
const live = (view, extra = {}) => ({...view, live: 'socket', reconnect: false, session: 'active', ...extra});

/** Fake answers on top of the README bridge. `state` picks the connection; addresses decide what a probe finds. */
const setup = (state) => async (ctx) => {
  await ctx.evaluate(`
    const S = ${JSON.stringify(state)}, h = window.__mockHandlers;
    let config = S.config, signin = {phase: 'idle'};
    const HOSTED = {ok: false, stage: 'auth', backend: 'paperclip', compatibility: 'Paperclip-compatible', signIn: ['browser'], message: 'needs sign-in', baseUrl: 'https://team.example.com'};
    h['paperclip.config.get'] = () => config;
    h['paperclip.signin.status'] = () => signin;
    h['paperclip.test'] = ({mode, baseUrl, token}) => {
      if (mode === 'local') return S.local ?? {ok: false, stage: 'network', message: 'No server is answering on this Mac.'};
      if (token) return token === 'good-token' ? {ok: true, stage: 'ok', backend: 'muster-server', companies: [{id: 'c', name: 'Acme', prefix: ''}], message: 'ok'} : {ok: false, stage: 'auth', backend: 'muster-server', message: 'refused'};
      if (!baseUrl) return {ok: true, stage: 'ok', companies: S.companies ?? [], message: 'ok'};
      if (/gone/.test(baseUrl)) return {ok: false, stage: 'network', message: 'raw'};
      if (/portal/.test(baseUrl)) return {ok: false, stage: 'service', message: 'raw'};
      return HOSTED;
    };
    h['paperclip.signin.start'] = ({baseUrl}) => (signin = {phase: 'waiting', baseUrl, approvalUrl: baseUrl + '/connect/abc', expiresAt: new Date(Date.now() + 540000).toISOString()});
    h['paperclip.signin.cancel'] = () => (signin = S.endWith === 'expired' ? {phase: 'expired', baseUrl: signin.baseUrl} : {phase: 'cancelled', baseUrl: signin.baseUrl});
    h['musterServer.signInWindow'] = () => ({opened: true});
    h['paperclip.disconnect'] = () => ({config: config = ${JSON.stringify(OFF)}, revoked: true});
    if (S.snapshot) h['paperclip.snapshot'] = () => ({...S.snapshot, fetchedAt: new Date().toISOString()});
    h['paperclip.watch'] = () => ({live: 'socket'});
    h['paperclip.inbox.dismissed'] = () => ({items: []});
    window.__emit({type: 'projectsWorkspaceChanged', scopes: ['config', 'tasks', 'runs', 'agents', 'inbox'], taskIds: []});
  `);
  await ctx.sleep(500);
  await ctx.store(`s.openAppSettings('integrations')`);
  await ctx.sleep(1600);
};
const typeAddress = async (ctx, text) => { await ctx.evaluate(`document.querySelector('input[type=url]').focus()`); await ctx.type(text); await ctx.sleep(300); };
const clickButton = (ctx, label) => ctx.evaluate(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!b)throw new Error('no button ${label}');b.click()`);
const off = {config: OFF};

export const SHOTS = [
  {name: '01-not-connected', local: true, opts: {}, async run(ctx) { await setup(off)(ctx); }},
  {name: '02-local-found', local: true, opts: {}, async run(ctx) { await setup({config: OFF, local: {ok: true, stage: 'ok', backend: 'paperclip', version: '2026.1001.0', baseUrl: 'http://127.0.0.1:3100', companies: [], message: 'ok'}})(ctx); }},
  {name: '03-address-typed', local: true, opts: {}, async run(ctx) { await setup(off)(ctx); await typeAddress(ctx, 'https://team.example.com'); }},
  {name: '04-connecting', local: true, opts: {}, async run(ctx) { await setup(off)(ctx); await typeAddress(ctx, 'https://team.example.com'); await clickButton(ctx, 'Connect'); await ctx.sleep(700); }},
  {name: '05-connected-live', local: true, opts: {}, async run(ctx) { await setup({config: live({...B.view, baseUrl: B.view.baseUrl}), snapshot: B.snap, companies: []})(ctx); }},
  {name: '06-connected-fallback-reconnect', local: true, opts: {}, async run(ctx) { await setup({config: {...A.view, mode: 'custom', baseUrl: 'https://team.example.com', hasToken: true, signedIn: {name: 'Test Founder', email: 'founder@example.com'}, live: 'poll', reconnect: true, session: 'expired'}, snapshot: A.snap})(ctx); }},
  {name: '07-token-disclosure', local: true, opts: {}, async run(ctx) { await setup(off)(ctx); await typeAddress(ctx, 'https://api.example.com'); await ctx.evaluate(`document.querySelectorAll('details.ws-connection-more')[0].open=true`); await ctx.sleep(400); await ctx.evaluate(`document.querySelector('input[type=password]').focus()`); await ctx.type('mst_pasted_token_value'); await ctx.sleep(300); }},
  {name: '08-error-unreachable', local: true, opts: {}, async run(ctx) { await setup(off)(ctx); await typeAddress(ctx, 'https://gone.example.com'); await clickButton(ctx, 'Connect'); await ctx.sleep(500); }},
  {name: '09-error-not-a-server', local: true, opts: {}, async run(ctx) { await setup(off)(ctx); await typeAddress(ctx, 'https://portal.example.com'); await clickButton(ctx, 'Connect'); await ctx.sleep(500); }},
  {name: '10-error-cancelled', local: true, opts: {}, async run(ctx) { await setup(off)(ctx); await typeAddress(ctx, 'https://team.example.com'); await clickButton(ctx, 'Connect'); await ctx.sleep(500); await clickButton(ctx, 'Cancel'); await ctx.sleep(500); }},
  {name: '11-error-expired', local: true, opts: {}, async run(ctx) { await setup({config: OFF, endWith: 'expired'})(ctx); await typeAddress(ctx, 'https://team.example.com'); await clickButton(ctx, 'Connect'); await ctx.sleep(500); await clickButton(ctx, 'Cancel'); await ctx.sleep(500); }},
  {name: '12-connected-details', local: true, opts: {}, async run(ctx) { await setup({config: live({...A.view, mode: 'custom', baseUrl: 'https://team.example.com', hasToken: true, signedIn: {name: 'Test Founder', email: 'founder@example.com'}, serverVersion: '2026.1001.0'}), snapshot: A.snap, companies: []})(ctx); await ctx.evaluate(`document.querySelector('details.ws-connection-more').open=true`); await ctx.sleep(400); }},
];
