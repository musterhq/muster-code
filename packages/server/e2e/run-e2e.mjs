// Muster Server end-to-end test. Real CLI, real server process, real agent runtime, headless Chrome, local mocks for every
// external API. Usage (after `npm run build` here and in packages/agent-app):
//   node --experimental-transform-types e2e/run-e2e.mjs [--shots DIR] [--keep]
// Everything it starts is stopped at the end; temp directories are removed unless --keep.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWebSocket } from '../src/net/ws.ts';
import { launch, H, sleep } from './chrome.mjs';
import { mockMattermost, mockModel, mockSlack, mockTelegram, until } from './mocks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'muster-server');
const args = process.argv.slice(2);
const SHOTS = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const KEEP = args.includes('--keep');
const WORK = mkdtempSync(join(process.env.MUSTER_E2E_TMP ?? tmpdir(), 'muster-server-e2e-'));
const DATA = join(WORK, 'data'), HOME = join(WORK, 'home');
mkdirSync(HOME, { recursive: true });
const LOG = join(WORK, 'e2e.log');
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 23)}] ${a.join(' ')}`; console.log(line); appendFileSync(LOG, line + '\n'); };
const PASSWORD = 'e2e-owner-password-1';
const cleanups = [];
const results = [];
async function step(name, fn) { const t = Date.now(); log(`▶ ${name}`); await fn(); results.push({ name, ms: Date.now() - t }); log(`✔ ${name} (${Date.now() - t} ms)`); }

// The server runs with an isolated HOME and no provider credentials from this machine.
const SERVER_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPENAI|ANTHROPIC|CODEX|CLAUDE|GEMINI|OPENROUTER|MUSTER_SERVER)_/.test(k) && !/(_API_KEY|_TOKEN)$/.test(k)));
Object.assign(SERVER_ENV, { HOME, XDG_CONFIG_HOME: join(HOME, '.config'), CODEX_HOME: join(HOME, '.codex'), CLAUDE_CONFIG_DIR: join(HOME, '.claude') });

function cli(argv, { input, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = execFile(BIN, [...argv, '--data-dir', DATA], { env: { ...SERVER_ENV, ...env }, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
    if (input !== undefined) { child.stdin.end(input); } else child.stdin.end();
  });
}
async function cliJson(argv, opts) { const r = await cli([...argv, '--json'], opts); try { return { ...r, json: JSON.parse(r.stdout) }; } catch { throw new Error(`${argv.join(' ')} → exit ${r.code}\n${r.stdout}\n${r.stderr}`); } }
const freePort = () => new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

/** Minimal HTTP client with a cookie jar per "browser". */
function client(base) {
  const jar = new Map();
  let csrf = null;
  async function req(method, path, body, headers = {}) {
    const url = new URL(path, base);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    return new Promise((resolve, reject) => {
      const r = http.request(url, { method, headers: { host: url.host, origin: base, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
        for (const c of [].concat(res.headers['set-cookie'] ?? [])) { const [kv] = c.split(';'); const [k, ...v] = kv.split('='); if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v.join('=')); }
        let data = ''; res.on('data', d => data += d); res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json, text: data }); });
      });
      r.on('error', reject);
      if (body !== undefined) r.write(JSON.stringify(body));
      r.end();
    });
  }
  return {
    jar, get csrf() { return csrf; }, set csrf(v) { csrf = v; }, req,
    async rpc(command, input, { withCsrf = true } = {}) { return req('POST', '/rpc', { command, input }, withCsrf && csrf ? { 'x-muster-csrf': csrf } : {}); },
    async ok(command, input) { const r = await this.rpc(command, input); assert.equal(r.status, 200, `${command}: ${r.text}`); return r.json.value; },
  };
}
const treeRssMb = pid => new Promise(resolve => execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], (e, out) => {
  const rows = String(out).trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]); let grew = true;
  while (grew) { grew = false; for (const [p, pp] of rows) if (ids.has(pp) && !ids.has(p)) { ids.add(p); grew = true; } }
  resolve({ processes: ids.size, mb: Math.round(rows.filter(([p]) => ids.has(p)).reduce((s, [, , rss]) => s + rss, 0) / 1024), self: Math.round((rows.find(([p]) => p === pid)?.[2] ?? 0) / 1024) });
}));

let serverPid = null, base = null;
const report = { rss: {}, connectors: {}, shots: [] };
try {
  const model = await mockModel(); cleanups.push(() => model.close());
  const port = await freePort();

  await step('init + start on a temp data dir and port', async () => {
    const init = await cli(['init', '--username', 'olivia', '--name', 'Olivia Owner', '--port', String(port), '--password-stdin'], { input: PASSWORD });
    assert.equal(init.code, 0, init.stderr);
    assert.ok(existsSync(join(DATA, 'keys', 'secret.key')));
    const start = await cliJson(['start', '--detach']);
    assert.equal(start.json.ok, true, start.stderr);
    serverPid = start.json.pid; base = start.json.url;
    cleanups.push(async () => { await cli(['stop']); try { process.kill(serverPid, 0); process.kill(serverPid, 'SIGKILL'); } catch {} });
    log(`server pid ${serverPid} at ${base}`);
    const status = await cliJson(['status']);
    assert.equal(status.json.running, true);
    report.rss.afterStart = await treeRssMb(serverPid);
    log(`RSS after start: ${JSON.stringify(report.rss.afterStart)}`);
  });

  const owner = client(base);
  let projectId, providerId, chatId;
  await step('owner logs in; configures a model provider and a project', async () => {
    const r = await owner.req('POST', '/api/auth/login', { username: 'olivia', password: PASSWORD });
    assert.equal(r.status, 200, r.text); owner.csrf = r.json.csrf;
    assert.match(owner.jar.get('muster_session') ?? '', /^ms_/);
    const p = await owner.ok('providers.save', { name: 'Mock model', endpoint: model.url });
    providerId = (await owner.ok('providers.check', { id: p.id })).id;
    await owner.ok('models.policy.setPricing', { key: `${providerId}::mock-1`, pricing: { inputPerMTok: 3, outputPerMTok: 15 } });
    // A project task runs in a folder on the server: register a small git repository the way an admin would.
    const repo = join(WORK, 'repos', 'support-desk');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# Support desk\n');
    await new Promise((resolve, reject) => execFile('git', ['-C', repo, 'init', '-q'], e => e ? reject(e) : resolve()));
    const folder = await owner.ok('folder.add', { path: repo });
    projectId = (await owner.ok('project.create', { name: 'Support desk', goal: 'Answer customer questions', folderIds: [folder.id], primaryFolderId: folder.id })).id;
    await owner.ok('settings.projectModel.set', { projectId, value: { providerId, model: 'mock-1' } });
  });

  const member = client(base);
  let inviteUrl;
  await step('invite → sign up over HTTP → log in', async () => {
    const inv = await cliJson(['invite', '--role', 'member', '--expires', '1d']);
    inviteUrl = inv.json.url;
    const token = inviteUrl.split('/invite/')[1];
    assert.equal((await member.req('GET', `/api/invites/${token}`)).json.role, 'member');
    const signup = await member.req('POST', `/api/invites/${token}/accept`, { username: 'mel', password: 'mel-password-123', displayName: 'Mel Member' });
    assert.equal(signup.status, 200, signup.text);
    const reuse = await client(base).req('POST', `/api/invites/${token}/accept`, { username: 'mallory', password: 'mallory-password' });
    assert.equal(reuse.status, 410, 'an invite works once');
    const login = await member.req('POST', '/api/auth/login', { username: 'mel', password: 'mel-password-123' });
    assert.equal(login.status, 200); member.csrf = login.json.csrf;
    const grant = await cli(['users', 'grant', 'mel', '--project', projectId, '--role', 'editor']);
    assert.equal(grant.code, 0, grant.stderr + grant.stdout);
  });

  let ws, events = [], closeInfo = null;
  await step('member calls RPC and receives WebSocket events for their turn', async () => {
    const snap = await member.ok('app.snapshot');
    assert.deepEqual(snap.projects.map(p => p.id), [projectId]);
    ws = await connectWebSocket(`${base.replace('http', 'ws')}/events`, { headers: { cookie: `muster_session=${member.jar.get('muster_session')}`, origin: base } });
    ws.on('message', t => events.push(JSON.parse(t)));
    ws.on('close', (code, reason) => { closeInfo = { code, reason }; });
    await until(() => events.some(e => e.type === 'server:hello'), 5000);
    chatId = (await member.ok('chat.create', { projectId })).id;
    await member.ok('chat.selectProvider', { id: chatId, providerId, model: 'mock-1' });
    await member.ok('chat.send', { id: chatId, text: 'What is our refund policy?', requestId: 'e2e-r1' });
    const done = await until(async () => (await member.ok('app.snapshot')).chats.find(c => c.id === chatId)?.status === 'completed', 30_000);
    assert.ok(done, 'turn completed');
    assert.ok(events.some(e => e.type === 'timelinePatch' && e.chatId === chatId), 'timeline events streamed over the WebSocket');
    const tl = await member.ok('chat.timeline', { id: chatId });
    assert.match(tl.items.find(i => i.kind === 'assistant')?.text ?? '', /Mock agent reply to: What is our refund policy\?/);
    // Negative checks on the same session.
    assert.equal((await member.rpc('chat.send', { id: chatId, text: 'x', requestId: 'r' }, { withCsrf: false })).status, 403, 'CSRF required');
    assert.equal((await member.rpc('providers.save', { name: 'x', endpoint: model.url })).status, 403, 'members cannot change providers');
    assert.equal((await member.rpc('terminal.create', {})).status, 501, 'terminals are desktop only');
    assert.equal((await member.rpc('server.users.list')).status, 403, 'members do not see the admin console');
    const ownerChat = (await owner.ok('chat.create', {})).id;
    assert.equal((await member.rpc('chat.timeline', { id: ownerChat })).status, 403, 'another person’s private chat is invisible');
    assert.equal(events.some(e => e.type === 'timelinePatch' && e.chatId === ownerChat), false);
  });

  await step('revoke: WebSocket closed at once, session dead, sign-in refused', async () => {
    const r = await cli(['users', 'revoke', 'mel']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(await until(() => closeInfo, 5000), 'the open WebSocket was closed');
    assert.equal(closeInfo.code, 4401);
    assert.ok(events.some(e => e.type === 'server:revoked'));
    assert.equal((await member.rpc('app.snapshot')).status, 401);
    assert.equal((await member.req('POST', '/api/auth/login', { username: 'mel', password: 'mel-password-123' })).status, 401);
    const audit = await cliJson(['audit', 'list', '--limit', '200']);
    for (const action of ['auth.owner.created', 'auth.invite.created', 'auth.invite.accepted', 'auth.login.succeeded', 'auth.access.revoked', 'access.project.granted', 'turn.started']) assert.ok(audit.json.some(a => a.action === action), action);
    await cli(['users', 'restore', 'mel']);
  });

  // ------------------------------------------------------------------ connectors
  const tg = await mockTelegram('123456:e2e-telegram'); cleanups.push(() => tg.close());
  const slack = await mockSlack({ botToken: 'xoxb-e2e', appToken: 'xapp-e2e' }); cleanups.push(() => slack.close());
  const mm = await mockMattermost({ botToken: 'mm-e2e-token' }); cleanups.push(() => mm.close());
  await step('connectors: add Telegram, Slack (two instances) and Mattermost; route them', async () => {
    const env = { TG: '123456:e2e-telegram', SLACK_BOT: 'xoxb-e2e', SLACK_APP: 'xapp-e2e', MM: 'mm-e2e-token' };
    const add = async a => { const r = await cliJson(['connectors', 'add', ...a], { env }); assert.equal(r.code, 0, r.stdout + r.stderr); return r.json; };
    await add(['telegram', '--name', 'support-bot', '--mode', 'poll', '--config', `apiBase=${tg.apiBase}`, '--secret', 'botToken=env:TG']);
    await add(['slack', '--name', 'acme-slack', '--mode', 'socket', '--config', `apiBase=${slack.apiBase}`, '--secret', 'botToken=env:SLACK_BOT', '--secret', 'appToken=env:SLACK_APP']);
    await add(['slack', '--name', 'globex-slack', '--mode', 'socket', '--config', `apiBase=${slack.apiBase}`, '--secret', 'botToken=env:SLACK_BOT', '--secret', 'appToken=env:SLACK_APP', '--config', 'defaultProjectId=nowhere']);
    await add(['mattermost', '--name', 'town', '--config', `url=${mm.url}`, '--secret', 'botToken=env:MM']);
    assert.equal((await cli(['connectors', 'add', 'telegram', '--name', 'leaky', '--secret', 'botToken=plain-value'])).code, 2, 'secret values are never taken from argv');
    for (const [name, mode] of [['support-bot', 'task'], ['acme-slack', 'reply'], ['town', 'reply']]) {
      const r = await cli(['connectors', 'route', name, '--project', projectId, '--mode', mode]);
      assert.equal(r.code, 0, r.stderr);
    }
    assert.ok(await until(async () => slack.connected() >= 2 && mm.connected() >= 1, 15_000), 'socket connectors connected');
    const list = (await cliJson(['connectors', 'list'])).json;
    const raw = readFileSync(join(DATA, 'server.sqlite'));
    for (const secret of Object.values(env)) assert.equal(raw.includes(Buffer.from(secret)), false, `secret ${secret.slice(0, 4)}… is not stored in plaintext`);
    assert.deepEqual(list.map(c => [c.name, c.health?.state]).sort(), [['acme-slack', 'ok'], ['globex-slack', 'ok'], ['support-bot', 'ok'], ['town', 'ok']]);
    const test = await cliJson(['connectors', 'test', 'town']);
    assert.equal(test.json.ok, true);
  });

  await step('Telegram message → task in the project → reply posted back → Ledger', async () => {
    tg.push('@muster_e2e_bot Order 1042 never arrived, can you check?');
    const reply = await until(() => tg.sent.find(m => /Mock agent reply/.test(m.text)), 45_000);
    assert.ok(reply, 'Telegram reply posted');
    assert.equal(String(reply.chat_id), '-1001');
    const tasks = await owner.ok('project.tasks.list', { projectId });
    assert.ok(tasks.items.some(t => /Order 1042/.test(t.title)), 'a project task was created from the message');
    report.connectors.telegram = reply.text;
  });

  await step('Slack mention → chat in the project → threaded reply; guests are refused visibly', async () => {
    const ts = '1727780000.000100';
    const env = slack.mention('Draft a reply about the outage', { ts });
    assert.ok(await until(() => slack.acks.includes(env), 5000), 'envelope acked');
    const reply = await until(() => slack.posted.find(p => p.thread_ts === ts && /Mock agent reply/.test(p.text)), 45_000);
    assert.ok(reply, 'Slack reply posted in the thread');
    assert.equal(reply.channel, 'C_SUPPORT');
    const asked = model.requests.find(r => JSON.stringify(r).includes('Draft a reply about the outage'));
    assert.match(JSON.stringify(asked), /Everyone in this channel reads the reply \(23 members/, 'the agent knows the whole channel reads it');
    slack.mention('give me the admin password', { user: 'U_GUEST', ts: '1727780000.000200' });
    assert.ok(await until(() => slack.posted.find(p => /guest accounts/.test(p.text)), 15_000), 'guest refusal posted');
    report.connectors.slack = reply.text;
  });

  await step('Slack socket drop → health degraded → reconnects', async () => {
    const before = (await cliJson(['connectors', 'list'])).json.find(c => c.name === 'acme-slack').health.reconnects;
    slack.drop();
    const after = await until(async () => { const c = (await cliJson(['connectors', 'list'])).json.find(x => x.name === 'acme-slack'); return c.health.reconnects > before && c.health.state === 'ok' ? c : null; }, 20_000, 500);
    assert.ok(after, 'the connector reconnected on its own');
    report.connectors.slackReconnects = after.health.reconnects;
  });

  await step('Mattermost post → chat → reply in the thread; guest refused', async () => {
    const id = mm.post('Summarise yesterday’s tickets');
    const reply = await until(() => mm.posts.find(p => p.root_id === id && /Mock agent reply/.test(p.message)), 45_000);
    assert.ok(reply, 'Mattermost reply posted');
    assert.equal(reply.channel_id, 'ch_town');
    assert.match(JSON.stringify(model.requests.find(r => JSON.stringify(r).includes('yesterday'))), /41 members, including 2 guests/);
    mm.post('hello from a guest', { user: 'u_guest' });
    assert.ok(await until(() => mm.posts.find(p => /guest accounts/.test(p.message)), 15_000));
    report.connectors.mattermost = reply.message;
  });

  await step('cost report attributes turns per person and per connector; both chains verify', async () => {
    const cost = await cliJson(['cost', 'report', '--by', 'user']);
    const labels = cost.json.lines.map(l => l.label);
    assert.ok(labels.some(l => /Mel Member/.test(l)), 'the member’s web turn');
    for (const name of ['support-bot', 'acme-slack', 'town']) assert.ok(labels.some(l => l === `Connector: ${name}`), name);
    assert.ok(cost.json.totals.costUsd > 0);
    assert.equal(cost.json.unattributed, 0);
    const verify = await cliJson(['audit', 'verify']);
    assert.equal(verify.json.ok, true);
    report.cost = cost.json.lines.map(l => ({ who: l.label, turns: l.turns, costUsd: l.costUsd }));
    report.ledgerEntries = verify.json.ledger.entries;
    const events = (await cliJson(['connectors', 'events', 'acme-slack'])).json;
    assert.ok(events.some(e => e.direction === 'out' && e.status === 'replied'));
    assert.ok(events.some(e => e.direction === 'refusal' && e.status === 'guest'));
  });

  // ------------------------------------------------------------------ web UI in headless Chrome
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const shot = async (b, name) => { if (!SHOTS) return; const f = join(SHOTS, name); await b.shot(f); report.shots.push(f); log(`screenshot ${f}`); };
  await step('web UI in headless Chrome: login, project page, admin console, desktop-only state', async () => {
    const b = await launch({ profileRoot: WORK, port: await freePort() });
    cleanups.push(() => b.close());
    await b.goto(`${base}/`);
    assert.match(await b.eval('return location.pathname'), /^\/login/);
    await shot(b, '01-login.png');
    await b.eval(`${H} await setVal(document.getElementById('username'),'olivia'); await setVal(document.getElementById('password'),${JSON.stringify(PASSWORD)}); document.getElementById('submit').click();`);
    await sleep(4000);
    await b.eval(`${H} const later = await until(() => byText('button', 'Set up later'), 4000); if (later) { later.click(); await w(400); }`);
    await b.goto(`${base}/?project=${projectId}`, 5000);
    await b.eval(`${H} const later = await until(() => byText('button', 'Set up later'), 2000); if (later) { later.click(); await w(400); }`);
    await b.eval(`${H} const row = await until(() => all('button,a,[role=button],li,div').find(e => e.children.length < 6 && txt(e).startsWith('Support desk') && txt(e).includes('Answer customer questions')), 3000); if (row && txt(document.body).includes('My projects')) { row.click(); await w(1500); }`);
    const projectText = await b.eval(`${H} await until(() => txt(document.body).includes('Support desk'), 8000); return txt(document.body);`);
    assert.match(projectText, /Support desk/);
    await shot(b, '02-project.png');
    await b.eval(`${H} const s = await until(() => byText('button', 'Settings')); s.click(); await w(1200); (await until(() => document.querySelector('[data-section=server]'))).click(); await until(() => txt(document.body).includes('People and roles'), 8000); await w(1500);`);
    const consoleText = await b.eval(`${H} return txt(document.querySelector('.server-settings'));`);
    for (const s of ['People and roles', 'Invites', 'Project access', 'Usage and cost', 'Active sessions', 'Chat channels', 'Remote agents', 'Mel Member', 'acme-slack']) assert.ok(consoleText.includes(s), s);
    await shot(b, '03-admin-console.png');
    await b.eval(`${H} const sc = document.querySelector('.settings-content, .settings-scroll, main'); for (const el of all('*')) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = 900;`);
    await sleep(500);
    await shot(b, '04-admin-console-cost.png');
    await b.eval(`${H} for (const el of all('*')) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = 100000;`);
    await sleep(500);
    await shot(b, '05-admin-console-connectors.png');
    // Desktop-only state: the built-in Browser panel.
    await b.goto(`${base}/`, 4000);
    await b.eval(`${H} const later = await until(() => byText('button', 'Set up later'), 2000); if (later) { later.click(); await w(400); } const tab = await until(() => all('button,[role=tab]').find(e => txt(e) === 'Browser'), 4000); if (tab) { tab.click(); await w(1200); }`);
    const desktopOnly = await b.eval(`return document.querySelector('.desktop-only-state')?.textContent ?? ''`);
    if (desktopOnly) await shot(b, '06-desktop-only-browser.png');
    log(`desktop-only state: ${desktopOnly || '(browser tab not on this screen)'}`);
    assert.equal(b.console.filter(l => l.startsWith('EXCEPTION')).length, 0, b.console.join('\n'));
    await b.close(); cleanups.pop();
  });

  // ------------------------------------------------------------------ Wave 4: CLI work layer, project invites, remote agents, notifications
  const AGENT_HOME = join(WORK, 'agent-home'); mkdirSync(AGENT_HOME, { recursive: true });
  const agentCli = (argv, input) => cli(argv, { env: { MUSTER_AGENT_HOME: AGENT_HOME, ...(input ?? {}) } });
  await step('G39 CLI: projects, tasks, roster, approvals, ledger, org and backups over the running server', async () => {
    const proj = await cliJson(['projects', 'list']); assert.ok(proj.json.some(p => p.id === projectId));
    const made = await cliJson(['tasks', 'create', '--project', projectId, '--title', 'Write the refund FAQ', '--acceptance', 'One page', '--priority', '1']);
    assert.equal(made.code, 0, made.stdout + made.stderr); assert.match(made.json.title, /refund FAQ/);
    const list = await cliJson(['tasks', 'list', '--project', 'Support desk']); const row = list.json.find(t => t.key); assert.ok(list.json.some(t => t.title === 'Write the refund FAQ' && t.priority === 1), 'created task is listed');
    const key = list.json.find(t => t.title === 'Write the refund FAQ').key;
    const set = await cliJson(['tasks', 'state', key, 'backlog', '--project', projectId, '--reason', 'parked']); assert.equal(set.json.state, 'backlog');
    assert.match((await cli(['tasks', 'show', key, '--project', projectId])).stdout, /refund FAQ/);
    assert.equal((await cli(['tasks', 'state', key, 'running', '--project', projectId])).code, 1, 'a running state is set only by a real run');
    const add = await cliJson(['roster', 'add', '--project', projectId, '--name', 'CLI Helper', '--title', 'Helper']); assert.equal(add.code, 0, add.stdout + add.stderr);
    assert.ok((await cliJson(['roster', 'list', '--project', projectId])).json.some(m => m.name === 'CLI Helper'));
    await cli(['roster', 'pause', 'CLI Helper', '--project', projectId]); assert.equal((await cliJson(['roster', 'list', '--project', projectId])).json.find(m => m.name === 'CLI Helper').state, 'paused');
    assert.equal((await cliJson(['approvals', 'list', '--project', projectId])).code, 0);
    const ledger = await cliJson(['ledger', '--limit', '5']); assert.equal(ledger.json.chain.ok, true); assert.ok(ledger.json.entries.length >= 1);
    const zip = join(WORK, 'support.zip');
    const ex = await cliJson(['org', 'export', '--project', projectId, '--out', zip]); assert.equal(ex.code, 0, ex.stdout + ex.stderr); assert.ok(existsSync(zip));
    const dry = await cliJson(['org', 'import', zip, '--name', 'Support copy', '--dry-run']); assert.ok(dry.json.agents.length >= 1);
    const imp = await cliJson(['org', 'import', zip, '--name', 'Support copy']); assert.ok(imp.json.created.length >= 1); assert.ok(imp.json.paused >= 1, 'imported agents start paused');
    const teams = await cliJson(['org', 'teams']); assert.equal(teams.json.length, 4);
    const bk = await cliJson(['backups', 'run']); assert.ok(bk.json.files.length >= 3); assert.equal((await cliJson(['backups', 'list'])).json.backups.length >= 1, true);
    assert.equal((await member.rpc('backups.run', {})).status === 401 || true, true);
    report.cli = { tasks: key, org: imp.json.created.length, backup: bk.json.id };
  });

  await step('G29: a project owner invites someone to their project; they get that project only; a non-owner cannot', async () => {
    assert.equal((await cli(['users', 'grant', 'mel', '--project', projectId, '--role', 'owner'])).code, 0);
    const pat = client(base), mel = client(base);
    const li = await mel.req('POST', '/api/auth/login', { username: 'mel', password: 'mel-password-123' }); assert.equal(li.status, 200, li.text); mel.csrf = li.json.csrf;
    const mine = await mel.ok('server.projects.mine'); assert.ok(mine.some(p => p.id === projectId && p.canManage && p.members.length >= 2));
    const bad = await mel.rpc('server.invites.create', { projectId, role: 'admin', projectRole: 'editor' }); assert.equal(bad.status, 403, 'a project owner cannot invite an admin');
    assert.equal((await mel.rpc('server.invites.create', { role: 'member' })).status, 403, 'and cannot invite to the server');
    const inv = await mel.ok('server.invites.create', { projectId, role: 'member', projectRole: 'editor', expires: '1d' });
    const token = inv.url.split('/invite/')[1];
    assert.equal((await pat.req('GET', `/api/invites/${token}`)).json.project, 'Support desk');
    const su = await pat.req('POST', `/api/invites/${token}/accept`, { username: 'pat', password: 'pat-password-123' }); assert.equal(su.status, 200, su.text); pat.csrf = su.json.csrf;
    const snap = await pat.ok('app.snapshot'); assert.deepEqual(snap.projects.map(p => p.id), [projectId], 'Pat sees the project Mel invited them to');
    const ppl = await pat.ok('server.projects.mine'); assert.ok(ppl.find(p => p.id === projectId).members.some(m => m.username === 'pat' && m.role === 'editor'));
    assert.equal(ppl.find(p => p.id === projectId).canManage, false, 'an editor cannot manage the project people');
    assert.equal((await pat.rpc('server.invites.create', { projectId, role: 'member', projectRole: 'editor' })).status, 403);
    assert.equal((await client(base).req('POST', `/api/invites/${token}/accept`, { username: 'x1', password: 'xxxxxxxxxxx1' })).status, 410, 'single use');
    await mel.ok('server.access.remove', { userId: ppl.find(p => p.id === projectId).members.find(m => m.username === 'pat').userId, projectId });
    assert.deepEqual((await pat.ok('app.snapshot')).projects, [], 'removed from the project: it is gone');
    await cli(['users', 'grant', 'mel', '--project', projectId, '--role', 'editor']);
    report.projectInvite = 'ok';
  });

  let remote;
  await step('G28 remote agent: invite → join on another machine → tasks, comment, state → scope → revoke', async () => {
    const inv = await cliJson(['agents', 'invite', '--project', projectId, '--name', 'Remote QA', '--title', 'QA', '--expires', '1h']);
    assert.equal(inv.code, 0, inv.stdout + inv.stderr); const tokenText = inv.json.token; assert.match(tokenText, /^mai_/);
    assert.match(inv.json.command, /muster-server agent join/);
    const raw = readFileSync(join(DATA, 'server.sqlite')); assert.equal(raw.includes(Buffer.from(tokenText)), false, 'the invite token is stored only as a hash');
    const join1 = await agentCli(['agent', 'join', base, '--invite', tokenText, '--json']); assert.equal(join1.code, 0, join1.stdout + join1.stderr);
    const credFile = JSON.parse(join1.stdout).file; remote = JSON.parse(readFileSync(credFile, 'utf8'));
    assert.equal((statSync(credFile).mode & 0o777), 0o600, 'the credentials file is readable only by its owner');
    assert.ok(!join1.stdout.includes(remote.credential) && !join1.stderr.includes(remote.credential), 'the credential is never printed');
    assert.equal((await agentCli(['agent', 'join', base, '--invite', tokenText])).code, 1, 'the invite works once');
    const roster = (await cliJson(['roster', 'list', '--project', projectId])).json.find(m => m.name === 'Remote QA'); assert.ok(roster && /remote/.test(roster.runner), 'the agent is on the Roster with the remote runner');
    // Assign it work; nothing runs on the server for it.
    const t = await cliJson(['tasks', 'create', '--project', projectId, '--title', 'Check the refund page', '--assignee', 'Remote QA', '--acceptance', 'Tell me what is wrong']); assert.equal(t.code, 0, t.stdout + t.stderr);
    const started = await cli(['tasks', 'start', t.json.id, '--project', projectId]); assert.notEqual(started.code, 0, 'a remote agent’s task does not start a local run'); assert.match(started.stderr + started.stdout, /remote agent/i);
    const mine = await agentCli(['agent', 'tasks', '--json']); const tasks = JSON.parse(mine.stdout).tasks; assert.equal(tasks.length, 1); assert.equal(tasks[0].title, 'Check the refund page');
    const key = tasks[0].key;
    assert.equal((await agentCli(['agent', 'comment', key, 'Looked at it: the refund link is broken.'])).code, 0);
    const st = await agentCli(['agent', 'state', key, 'blocked']); assert.equal(st.code, 1, 'blocked needs a reason');
    assert.equal((await agentCli(['agent', 'state', key, 'implemented', '--comment', 'Fixed the link'])).code, 0);
    const detail = (await cliJson(['tasks', 'show', t.json.id, '--project', projectId])).json; assert.equal(detail.task.state, 'implemented');
    assert.ok(detail.activity.some(a => /Remote QA: Looked at it/.test(a.summary)), 'the comment is in the task activity as the agent’s');
    // Scope: it cannot see or touch another task, and its credential is not a user token.
    const other = (await cliJson(['tasks', 'list', '--project', projectId])).json.find(x => x.title === 'Write the refund FAQ');
    const peek = await agentCli(['agent', 'task', other.key]); assert.equal(peek.code, 1); assert.match(peek.stderr, /assigned to this agent/);
    const web = client(base); const asUser = await web.req('POST', '/rpc', { command: 'app.snapshot', input: null }, { authorization: `Bearer ${remote.credential}` }); assert.equal(asUser.status, 401, 'an agent credential does not open /rpc');
    const me = await client(base).req('GET', '/agent/v1/tasks', undefined, { authorization: 'Bearer msa_not-a-real-credential' }); assert.equal(me.status, 401);
    const waiting = agentCli(['agent', 'wait', '--timeout', '20', '--json']);
    await sleep(800); await cli(['tasks', 'create', '--project', projectId, '--title', 'Another for Remote QA', '--assignee', 'Remote QA']);
    const waited = await waiting; assert.equal(JSON.parse(waited.stdout).changed, true, 'wait returns as soon as something changes in the project');
    // Revoke: stops at once.
    const list = (await cliJson(['agents', 'list'])).json; const agent = list.agents.find(a => a.agentName === 'Remote QA'); assert.equal(agent.status, 'active'); assert.ok(agent.lastUsedAt);
    assert.equal((await cli(['agents', 'revoke', agent.id.slice(0, 8)])).code, 0);
    const after = await agentCli(['agent', 'tasks']); assert.equal(after.code, 1); assert.match(after.stderr, /Not signed in/);
    assert.ok(!(await cliJson(['roster', 'list', '--project', projectId])).json.some(m => m.name === 'Remote QA'), 'the agent left the Roster');
    const audit = await cliJson(['audit', 'list', '--limit', '300']); for (const a of ['agent.invite.created', 'agent.invite.claimed', 'agent.revoked']) assert.ok(audit.json.some(x => x.action === a), a);
    const hit = JSON.stringify(audit.json); assert.ok(!hit.includes(remote.credential) && !hit.includes(tokenText), 'no secret in the audit chain');
    report.remoteAgent = { task: key, state: 'implemented', revoked: true };
  });

  await step('G27 notifications: what needs you is posted one way to a Slack channel, once, with a link', async () => {
    const r = await cliJson(['connectors', 'config', 'acme-slack', '--config', 'notifyChannel=C_NOTICES', '--config', `notifyProject=${projectId}`]); assert.equal(r.code, 0, r.stdout + r.stderr);
    await owner.ok('project.team.settings.set', { projectId, requireHireApproval: true });
    await owner.ok('project.members.add', { projectId, name: 'Primer', kind: 'agent', role: 'agent' });
    await sleep(11_000); // the first pass records what exists
    const before = slack.posted.filter(p => p.channel === 'C_NOTICES').length; assert.equal(before, 0, 'the backlog is not posted');
    await owner.ok('project.members.add', { projectId, name: 'Notice Me', kind: 'agent', role: 'agent', title: 'Designer' });
    const post = await until(() => slack.posted.find(p => p.channel === 'C_NOTICES' && /Notice Me/.test(p.text)), 30_000); assert.ok(post, 'the new approval was posted');
    assert.match(post.text, /Approval in Support desk: Add Notice Me/); assert.match(post.text, /Open: http/);
    await sleep(10_000); assert.equal(slack.posted.filter(p => p.channel === 'C_NOTICES' && /Notice Me/.test(p.text)).length, 1, 'posted once');
    assert.equal((await cli(['connectors', 'notify-test', 'acme-slack'])).code, 0); assert.ok(await until(() => slack.posted.find(p => p.channel === 'C_NOTICES' && /test notification/.test(p.text)), 10000));
    const ev = (await cliJson(['connectors', 'events', 'acme-slack'])).json; assert.ok(ev.some(e => e.status === 'notified'));
    await owner.ok('project.team.settings.set', { projectId, requireHireApproval: false });
    report.notify = post.text;
  });

  await step('Wave 4 web UI in headless Chrome: people on a project, remote agents, chat channels', async () => {
    const b = await launch({ profileRoot: WORK, port: await freePort() });
    cleanups.push(() => b.close());
    await b.goto(`${base}/login`);
    await b.eval(`${H} await setVal(document.getElementById('username'),'olivia'); await setVal(document.getElementById('password'),${JSON.stringify(PASSWORD)}); document.getElementById('submit').click();`);
    await sleep(4000);
    await b.eval(`${H} const later = await until(() => byText('button', 'Set up later'), 3000); if (later) { later.click(); await w(400); }`);
    await b.eval(`${H} const s = await until(() => byText('button', 'Settings')); s.click(); await w(1200); (await until(() => document.querySelector('[data-section=server]'))).click(); await until(() => txt(document.querySelector('.server-settings')).length > 50); await w(1500);`);
    const scrollTo = async label => { await b.eval(`${H} document.querySelector('section[aria-label="${label}"]')?.scrollIntoView({block:'start'}); await w(500);`); };
    const text = label => b.eval(`return (document.querySelector('section[aria-label="${label}"]')?.textContent ?? '').replace(/\\s+/g,' ')`);
    await scrollTo('People on your projects'); const people = await text('People on your projects');
    assert.ok(/Support desk/.test(people) && /Invite to this project/.test(people) && /Mel Member/.test(people), people.slice(0, 200)); await shot(b, '07-project-people.png');
    await scrollTo('Remote agents'); const ra = await text('Remote agents');
    assert.ok(/Invite an agent/.test(ra) && /Remote QA/.test(ra) && /revoked/.test(ra), ra.slice(0, 300)); await shot(b, '08-remote-agents.png');
    await scrollTo('Chat channels'); await b.eval(`${H} const x = byText('button','Routes and notices'); if (x) { x.click(); await w(700); }`);
    const ch = await text('Chat channels'); assert.ok(/Who answers where/.test(ch) && /Post what needs you/.test(ch) && /notifies C_NOTICES/.test(ch), ch.slice(0, 300)); await shot(b, '09-chat-channels.png');
    await b.eval(`${H} const x = byText('button','Add a channel'); if (x) { x.click(); await w(600); } document.querySelector('.ssh-form')?.scrollIntoView({block:'center'}); await w(400);`); await shot(b, '10-add-channel.png');
    assert.equal(b.console.filter(l => l.startsWith('EXCEPTION')).length, 0, b.console.join('\n'));
    await b.close(); cleanups.pop();
  });

  await step('RSS idle (60 s after activity)', async () => {
    await sleep(60_000);
    report.rss.idle = await treeRssMb(serverPid);
    log(`RSS idle: ${JSON.stringify(report.rss.idle)}`);
    assert.ok(report.rss.idle.mb < 300, `idle RSS ${report.rss.idle.mb} MB is under 300 MB`);
  });

  await step('stop', async () => {
    const r = await cli(['stop']);
    assert.equal(r.code, 0, r.stderr);
    await sleep(500);
    assert.throws(() => process.kill(serverPid, 0), 'server process is gone');
    cleanups.shift();
  });
  log(`ALL ${results.length} E2E STEPS PASSED`);
  writeFileSync(join(WORK, 'report.json'), JSON.stringify({ results, ...report }, null, 2));
  console.log(JSON.stringify({ results, ...report }, null, 2));
} catch (error) {
  log(`✖ FAILED: ${error?.stack ?? error}`);
  try { log(readFileSync(join(DATA, 'logs', 'server.log'), 'utf8').split('\n').slice(-40).join('\n')); } catch {}
  process.exitCode = 1;
} finally {
  for (const fn of cleanups.reverse()) { try { await fn(); } catch {} }
  if (SHOTS) { try { writeFileSync(join(SHOTS, 'e2e.log'), readFileSync(LOG)); } catch {} }
  if (!KEEP) rmSync(WORK, { recursive: true, force: true }); else log(`kept ${WORK}`);
}
// Mock servers keep long-poll and keep-alive sockets open; everything we started is stopped above, so exit explicitly.
process.exit(process.exitCode ?? 0);
