/** #721: Muster's own computer use, with no other app's plugin installed. The workflow tests drive the shipped
 *  dist/main/computer-mcp.cjs over stdio exactly as Codex does; it runs the shipped native helper against a real app. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {computerRunOptions} from '../src/runtime/domains/computer.ts';
import {claudeLaneAllowed} from '../src/runtime/claude-lane.ts';
import {adapterBrowser} from '../src/runtime/provider.ts';
import {computerAction, computerUseTarget} from '../src/shared/computer-use.ts';

const root = path.join(import.meta.dirname, '..');
const server = path.join(root, 'dist', 'main', 'computer-mcp.cjs');
const helper = path.join(root, 'dist', 'main', 'muster-computer');
const required = process.env.MUSTER_REQUIRE_COMPUTER_E2E === '1';

function mcp(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [server, helper], {stdio: ['pipe', 'pipe', 'inherit'], env: {...process.env, ...env}});
  const waiting = new Map<number, (row: any) => void>();
  readline.createInterface({input: child.stdout}).on('line', line => { const row = JSON.parse(line); waiting.get(row.id)?.(row); waiting.delete(row.id); });
  let next = 0;
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>(resolve => { const id = ++next; waiting.set(id, resolve); child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n'); });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await send('tools/call', {name, arguments: args})).result as {content: Array<{type: string; text?: string; data?: string}>; isError?: boolean};
  return {send, call, close: () => child.stdin.end()};
}
const textOf = (result: {content: Array<{type: string; text?: string}>}) => result.content.filter(row => row.type === 'text').map(row => row.text).join('\n');
const number = (state: string, pattern: RegExp) => Number(state.split('\n').find(line => pattern.test(line))?.match(/\[(\d+)\]/)?.[1] ?? NaN);

/** Builds the fixture app once; undefined when this machine cannot run the desktop workflow. */
function fixture(t: test.TestContext): string | undefined {
  if (process.platform !== 'darwin') { t.skip('macOS only'); return undefined; }
  assert.ok(fs.existsSync(server), 'dist/main/computer-mcp.cjs is built');
  assert.ok(fs.existsSync(helper), 'dist/main/muster-computer is built');
  const probe = execFileSync(helper, {input: '{"id":1,"cmd":"permissions"}\n'}).toString();
  if (!JSON.parse(probe).result.accessibility) { if (required) assert.fail('Accessibility is off for this terminal'); t.skip('Accessibility is not granted to this runner'); return undefined; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-cu-')), bundle = path.join(dir, 'MusterFixture.app');
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), {recursive: true});
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.themuster.fixture.mcp</string><key>CFBundleExecutable</key><string>MusterFixture</string><key>CFBundleName</key><string>MusterFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  execFileSync('swiftc', ['-O', '-o', path.join(bundle, 'Contents', 'MacOS', 'MusterFixture'), path.join(root, 'tests', 'fixtures', 'computer-use', 'fixture-app.swift')]);
  t.after(() => { try { execFileSync('osascript', ['-e', 'quit app id "dev.themuster.fixture.mcp"']); } catch {} fs.rmSync(dir, {recursive: true, force: true}); });
  return bundle;
}

// Spec: MUS-SPEC-14-721E (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-721e)
test('MUS-SPEC-14-721E: an agent drives a desktop app with Muster alone and each step answers with only what changed', {timeout: 120_000}, async t => {
  const app = fixture(t); if (!app) return;
  const client = mcp(); t.after(client.close);
  const init = await client.send('initialize', {protocolVersion: '2025-06-18'});
  assert.equal(init.result.serverInfo.name, 'muster_computer');
  const tools = (await client.send('tools/list')).result.tools.map((tool: {name: string}) => tool.name);
  assert.deepEqual(tools, ['list_apps', 'get_app_state', 'click', 'type_text', 'set_value', 'press_key', 'perform_action', 'scroll', 'screenshot']);

  const first = textOf(await client.call('get_app_state', {app}));
  assert.match(first, /Button "Add one"/); assert.match(first, /Count 0/);
  const button = number(first, /Button "Add one"/);

  const started = Date.now();
  const clicked = await client.call('click', {app, element: button});
  const clickMs = Date.now() - started;
  assert.ok(!clicked.isError, textOf(clicked));
  const delta = textOf(clicked);
  assert.match(delta, /Changed:\n\s*\[\d+\] StaticText value="Count 1"/); assert.ok(!/Count 0/.test(delta), 'a changed element is reported once, as its new line');
  assert.ok(!/^\s*\[\d+\] Button "Add one"/m.test(delta), 'unchanged lines are not repeated');
  assert.match(delta, /^Done \(press\) · Button "Add one"/, 'the answer says which control it pressed');
  assert.ok(clickMs < 3000, `a click with its settled answer took ${clickMs} ms`);
  const step = computerAction({type: 'mcpToolCall', server: 'muster_computer', tool: 'click', arguments: JSON.stringify({app, element: button}), result: JSON.stringify(clicked)});
  assert.equal(step?.label, 'Clicked “Add one” in MusterFixture', 'the transcript names the control and the app, not a number or a path');

  const notes = number(first, /"Notes"/);
  const typed = textOf(await client.call('type_text', {app, element: notes, text: 'hello from Muster'}));
  assert.match(typed, /hello from Muster/);

  const again = textOf(await client.call('click', {app, element: button}));
  assert.match(again, /Count 2/, 'element numbers stay valid across steps');
  const stale = await client.call('click', {app, element: 9999});
  assert.ok(stale.isError, 'an unknown element number is refused, never guessed');
});

// Spec: MUS-SPEC-14-721F (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-721f)
test('MUS-SPEC-14-721F: a read-only chat can look at apps but not change them', {timeout: 120_000}, async t => {
  const app = fixture(t); if (!app) return;
  const client = mcp({MUSTER_COMPUTER_READ_ONLY: '1'}); t.after(client.close);
  await client.send('initialize', {});
  const tools = (await client.send('tools/list')).result.tools.map((tool: {name: string}) => tool.name);
  assert.ok(!tools.includes('click') && !tools.includes('type_text'), tools.join(','));
  const state = textOf(await client.call('get_app_state', {app}));
  const refused = await client.call('click', {app, element: number(state, /Button "Add one"/)});
  assert.ok(refused.isError); assert.match(textOf(refused), /read-only/);
  assert.match(textOf(await client.call('get_app_state', {app})), /Count 0/, 'nothing was clicked');
});

// Spec: MUS-SPEC-14-721G (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-721g)
test('MUS-SPEC-14-721G: every agent chat gets Muster computer use on every MCP route, without forcing router chats onto Codex', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-cu-launch-')), launcher = path.join(dir, 'muster-computer-mcp');
  fs.writeFileSync(launcher, '#!/bin/sh\n');
  const options = computerRunOptions({id: 'c1', mode: 'agent', permissionMode: 'workspace'}, undefined, launcher)!;
  assert.equal(options.configOverrides?.['mcp_servers.muster_computer.command'], launcher);
  assert.equal(options.configOverrides?.['mcp_servers.muster_computer.env.MUSTER_COMPUTER_READ_ONLY'], '0');
  assert.match(options.developerInstructions, /muster_computer/);
  assert.ok(!/signed-in Codex computer-use plugin/.test(options.developerInstructions), 'no dependency on another app\'s plugin');
  const readOnly = computerRunOptions({id: 'c1', mode: 'agent', permissionMode: 'read-only'}, undefined, launcher)!;
  assert.equal(readOnly.configOverrides?.['mcp_servers.muster_computer.env.MUSTER_COMPUTER_READ_ONLY'], '1');
  const claude = adapterBrowser('claude-code-cli', 'agent', options.developerInstructions, options.configOverrides);
  assert.ok(claude.mcpServers?.muster_computer, 'Claude Code chats get it too');
  assert.ok(claudeLaneAllowed('full', options.configOverrides), 'a Full access router chat still runs on its own route');
  assert.equal(computerUseTarget({type: 'mcpToolCall', server: 'muster_computer', tool: 'click'}), 'computer', 'its steps show as computer use in the transcript');
  const missing = computerRunOptions({id: 'c1', mode: 'agent'}, undefined, path.join(dir, 'missing'))!;
  assert.match(missing.developerInstructions, /computer-use plugin/, 'without the helper the old note stays');
  fs.rmSync(dir, {recursive: true, force: true});
});
