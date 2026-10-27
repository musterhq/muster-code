// #729: Claude Code skills (~/.claude/skills, <folder>/.claude/skills) and commands (~/.claude/commands, <folder>/.claude/commands)
// show in the skills picker. On a Claude Code run the picked command is sent the way Claude Code takes it (`/<name> <request>`),
// Claude Code expands it and the transcript shows "Ran /<name>"; every other run gets the expansion inlined. MCP servers and
// apps show the mark of the plugin that brings them. These tests drive the real service, provider adapter, the router's Claude
// Code lane and the Claude Code adapter with a fake `claude` executable and a temporary home; no network.
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, mkdir, rm, writeFile, chmod, readFile, realpath, symlink, unlink, stat} from 'node:fs/promises';
import {existsSync, promises as fsPromises} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID, randomFillSync} from 'node:crypto';
import {crc32, deflateSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter, type CoreClient} from '../src/runtime/provider.ts';
import {createClaudeLane} from '../src/runtime/claude-lane.ts';
import {claudeCodeAdapter} from '../src/runtime/adapters/claude-code.ts';
import {registerChatTokenIssuer} from '../src/runtime/governance/chat-binding.ts';
import {BACKGROUND_MCP} from '../src/runtime/background-agent-tools.ts';
import {extensionsOptions} from '../src/runtime/domains/extensions.ts';
import {discoverSkills, resolveAttachedSkill} from '../src/runtime/plugin-library.ts';
import {qualifiedSkillName} from '../src/shared/domains/extensions-protocol.ts';
import {mcpMark, mcpServerNames, mcpToolLabel} from '../src/renderer/mcpIcons.ts';
import {classifyTool} from '../src/renderer/components/toolPresentation.ts';
import type {ProviderInstance} from '../src/runtime/provider-instances.ts';
import type {Chat, PluginEntry, SkillEntry, TimelineItem} from '../src/shared/protocol.ts';

interface Launch {argv: string[]; prompt: string}

/** A stand-in for `claude` 2.1: a message that opens with `/<name>` is a command, which it reports back with
 *  `--replay-user-messages` as `<command-name>`/`<command-args>` before answering, as the real CLI does. */
function fakeClaude(log: string): string {
  return `
const fs = require('node:fs');
const argv = process.argv.slice(2);
const at = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const session = at('--resume') || at('--session-id');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const line = buffer.split('\\n').find(entry => entry.trim());
  if (!line || !buffer.includes('\\n')) return;
  process.stdin.removeAllListeners('data');
  const message = JSON.parse(line).message;
  const prompt = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\\n');
  const previous = fs.existsSync(${JSON.stringify(log)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(log)}, 'utf8')) : [];
  previous.push({argv, prompt});
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(previous));
  const out = event => process.stdout.write(JSON.stringify(event) + '\\n');
  out({type: 'system', subtype: 'init', session_id: session, model: at('--model'), tools: ['Bash'], cwd: process.cwd()});
  const command = /^\\/(\\S+)(?:\\s+([\\s\\S]*))?$/.exec(prompt);
  if (command && argv.includes('--replay-user-messages')) out({type: 'user', isReplay: true, session_id: session, message: {role: 'user', content: '<command-message>' + command[1] + '</command-message>\\n<command-name>/' + command[1] + '</command-name>\\n<command-args>' + (command[2] || '') + '</command-args>'}});
  const answer = command ? command[1].toUpperCase() + '-OK [' + (command[2] || '') + ']' : 'plain answer';
  out({type: 'assistant', message: {id: 'msg_' + previous.length, type: 'message', role: 'assistant', model: at('--model'), content: [{type: 'text', text: answer}], usage: {input_tokens: 5, output_tokens: 3}}, parent_tool_use_id: null, session_id: session});
  out({type: 'result', subtype: 'success', is_error: false, result: answer, session_id: session, usage: {input_tokens: 5, output_tokens: 3}});
  process.exit(0);
});
`;
}

/** A home with Claude Code's own layout: a skill, a command, a nested command and a synced folder that is not a skill;
 *  a project folder with its own command and skill; and a second folder without any. */
async function claudeHome(root: string): Promise<{home: string; project: string; other: string}> {
  const home = join(root, 'home'), project = join(root, 'project'), other = join(root, 'other');
  await mkdir(join(home, '.claude', 'skills', 'foo'), {recursive: true});
  await writeFile(join(home, '.claude', 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: Formats the release notes\n---\nFOO-SKILL-BODY: write the notes as a table.\n');
  await mkdir(join(home, '.claude', 'skills', 'synced', 'cache'), {recursive: true});
  await writeFile(join(home, '.claude', 'skills', 'synced', 'cache', 'notes.txt'), 'not a skill');
  await mkdir(join(home, '.claude', 'commands', 'fe'), {recursive: true});
  await writeFile(join(home, '.claude', 'commands', 'bar.md'), '---\ndescription: Checks a change before review\nargument-hint: <what to check>\n---\nBAR-BODY: check $ARGUMENTS carefully.\n');
  await writeFile(join(home, '.claude', 'commands', 'fe', 'comp.md'), 'Build the $0 component with $1 styling.\n');
  await mkdir(join(project, '.claude', 'commands'), {recursive: true});
  await writeFile(join(project, '.claude', 'commands', 'ship.md'), 'Ship it: run the release checklist.\n');
  await mkdir(join(project, '.claude', 'skills', 'house-style'), {recursive: true});
  await writeFile(join(project, '.claude', 'skills', 'house-style', 'SKILL.md'), '---\nname: house-style\ndescription: Our writing style\n---\nHOUSE-STYLE-BODY\n');
  await mkdir(other, {recursive: true});
  return {home, project: await realpath(project), other: await realpath(other)};
}

async function harness(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-729-'));
  const tree = await claudeHome(dataDir);
  const saved = {home: process.env.HOME, browser: process.env.MUSTER_BROWSER_MCP_LAUNCHER, background: process.env.MUSTER_BACKGROUND_MCP_LAUNCHER};
  process.env.HOME = tree.home;
  const launcher = join(dataDir, 'launcher.sh');
  await writeFile(launcher, '#!/bin/sh\nexit 0\n'); await chmod(launcher, 0o700);
  process.env.MUSTER_BROWSER_MCP_LAUNCHER = launcher; process.env.MUSTER_BACKGROUND_MCP_LAUNCHER = launcher;
  extensionsOptions.codexCache = join(dataDir, 'no-codex-cache'); extensionsOptions.claudeMarketplaces = join(dataDir, 'no-claude-marketplaces');
  const unissue = registerChatTokenIssuer(BACKGROUND_MCP, id => `token-for-${id}`);
  const log = join(dataDir, 'claude-launches.json'), binary = join(dataDir, 'claude.cjs');
  await writeFile(binary, `#!/usr/bin/env node\n${fakeClaude(log)}`); await chmod(binary, 0o700);
  const fetchImpl = (async () => new Response('{}', {status: 404})) as typeof fetch;
  const codex: Array<Record<string, unknown>> = [];
  const core: CoreClient = {
    CODEX_RUN_LIFECYCLE_VERSION: 1,
    async runCodexAppServer(input) { codex.push(input); return {status: 'completed', finalMessage: 'codex answer', threadId: `codex-thread-${codex.length}`, turnId: 'turn', dispatchState: 'dispatched'}; },
    async callCodexConversation() { return {}; }, async interruptActiveCodexTurn() { return true; }, clearCodexAppServerSessions() {},
  };
  const code = claudeCodeAdapter({binary, env: {...process.env}});
  const lane = createClaudeLane({endpoint: 'https://router.test/v1', headers: async () => ({authorization: 'Bearer test-token'}), label: 'Router', fetch: fetchImpl, claudeCode: () => code});
  const route: ProviderInstance = {
    info: {id: 'gw', name: 'Gateway', driver: 'codex-app-server', available: true, bindingId: 'gw-binding', identityMasked: 'hidden', codex: {modelProvider: 'gw', kind: 'gateway'},
      models: ['cc/claude-opus-5-5', 'gpt-5.6-terra'].map(id => ({id, name: id}))},
    command: '/unused', env: {}, sessionsRoot: join(dataDir, 'sessions'), claudeLane: lane,
  };
  const provider = createProviderAdapter({core, instances: () => [route]});
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => {
    unissue(); await service.dispose(); provider.dispose();
    extensionsOptions.codexCache = undefined; extensionsOptions.claudeMarketplaces = undefined;
    for (const [name, value] of [['HOME', saved.home], ['MUSTER_BROWSER_MCP_LAUNCHER', saved.browser], ['MUSTER_BACKGROUND_MCP_LAUNCHER', saved.background]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(dataDir, {recursive: true, force: true});
  });
  const items = async (chatId: string): Promise<TimelineItem[]> => (await service.invoke('chat.timeline', {id: chatId})).items;
  const snapshot = async (chatId: string): Promise<Chat> => (await service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === chatId)!;
  const folders = new Map<string, string>();
  return {
    service, codex, tree, items, snapshot,
    async launches(): Promise<Launch[]> { return existsSync(log) ? JSON.parse(await readFile(log, 'utf8')) as Launch[] : []; },
    async folderId(path: string): Promise<string> { if (!folders.has(path)) folders.set(path, (await service.invoke('folder.add', {path})).id); return folders.get(path)!; },
    async chat(model: string, path: string): Promise<Chat> {
      const created = await service.invoke('chat.create', {folderId: await this.folderId(path)});
      await service.invoke('chat.selectProvider', {id: created.id, providerId: 'gw', model});
      await service.invoke('chat.setPermissionMode', {id: created.id, permissionMode: 'full', acknowledgeFullAccess: true});
      return snapshot(created.id);
    },
    async skills(path: string): Promise<SkillEntry[]> { return service.invoke('plugins.list', {folderPaths: [path]}); },
    async send(chatId: string, text: string, skillIds: string[]): Promise<void> {
      const before = (await items(chatId)).filter(item => item.kind === 'user').length;
      await service.invoke('chat.send', {id: chatId, text, requestId: randomUUID(), skillIds});
      for (let i = 0; i < 1500; i++) {
        const chat = await snapshot(chatId);
        if ((await items(chatId)).filter(item => item.kind === 'user').length > before && chat.status !== 'running' && chat.status !== 'stopping') return;
        await delay(10);
      }
      assert.fail('the turn did not settle');
    },
  };
}
type H = Awaited<ReturnType<typeof harness>>;
const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const pick = (skills: SkillEntry[], name: string, kind?: 'skill' | 'command') => { const hit = skills.find(entry => entry.name === name && (!kind || entry.claude === kind)); assert.ok(hit, `${name} is listed; got ${skills.map(entry => entry.name).join(', ')}`); return hit; };

// Spec: MUS-SPEC-14-729A (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729a)
test('the skills picker lists Claude Code skills and commands from ~/.claude with their descriptions, nested commands as fe:comp, and skips folders that are not skills', async t => {
  const h: H = await harness(t);
  const skills = await h.skills(h.tree.other);
  const foo = pick(skills, 'foo'), bar = pick(skills, 'bar'), comp = pick(skills, 'fe:comp');
  assert.equal(foo.claude, 'skill'); assert.equal(foo.shortDescription, 'Formats the release notes');
  assert.equal(bar.claude, 'command'); assert.equal(bar.shortDescription, 'Checks a change before review'); assert.equal(bar.argumentHint, '<what to check>');
  assert.equal(comp.claude, 'command'); assert.equal(comp.shortDescription, 'Build the $0 component with $1 styling.', 'a command without front matter is described by its first line');
  for (const entry of [foo, bar, comp]) assert.match(entry.provenance, /~\/\.claude\/(skills|commands)/, `${entry.name} says it comes from ~/.claude`);
  assert.ok(!skills.some(entry => entry.name === 'synced' || entry.name === 'cache'), 'a folder without SKILL.md is not a skill');
});

// Spec: MUS-SPEC-14-729B (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729b)
test('a picked command on a Claude Code chat is sent as /bar with the request as its arguments, Claude Code expands it, and the transcript shows "Ran /bar the login flow"', async t => {
  const h: H = await harness(t);
  const chat = await h.chat('cc/claude-opus-5-5', h.tree.project);
  const bar = pick(await h.skills(h.tree.project), 'bar', 'command');
  await h.send(chat.id, '/bar the login flow', [bar.id]);
  const after = await h.snapshot(chat.id);
  assert.equal(after.status, 'completed', after.error ?? 'the turn did not complete');
  assert.equal(h.codex.length, 0, 'the Codex client never ran');
  const [run] = await h.launches();
  assert.ok(run, 'Claude Code ran the turn');
  assert.equal(run.prompt, '/bar the login flow', 'the message is exactly the command and its arguments');
  assert.ok(run.argv.includes('--replay-user-messages'), 'Claude Code reports the command it expanded');
  assert.doesNotMatch(flag(run.argv, '--append-system-prompt') ?? '', /BAR-BODY|command-instructions/, 'Muster does not inline the command too');
  const items = await h.items(chat.id);
  const row = items.find(item => item.kind === 'tool' && item.data?.type === 'claudeCommand');
  assert.ok(row, 'the command shows as a tool row');
  const shown = classifyTool(row.data);
  assert.equal(`${shown.verb} ${shown.subject}`, 'Ran /bar the login flow', 'the row reads like the command that was typed');
  assert.equal(shown.slash, true, 'a command row carries the slash glyph');
  assert.equal(row.data?.arguments, 'the login flow');
  assert.equal(row.data?.output, 'BAR-BODY: check the login flow carefully.', 'the row opens to what the command expanded to');
  assert.ok(items.some(item => item.kind === 'assistant' && item.text === 'BAR-OK [the login flow]'), 'the answer follows');
  assert.equal(items.filter(item => item.kind === 'tool' && item.data?.type === 'claudeCommand').length, 1, 'one row per run');
});

// Spec: MUS-SPEC-14-729H (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729h)
test('a picked Claude Code skill on a Claude Code chat is invoked by name too and reads "Used foo skill"', async t => {
  const h: H = await harness(t);
  const chat = await h.chat('cc/claude-opus-5-5', h.tree.project);
  const foo = pick(await h.skills(h.tree.project), 'foo', 'skill');
  await h.send(chat.id, 'Draft the notes $foo', [foo.id]);
  const [run] = await h.launches();
  assert.equal(run?.prompt, '/foo Draft the notes');
  const row = (await h.items(chat.id)).find(item => item.data?.type === 'claudeCommand');
  assert.ok(row);
  const shown = classifyTool(row.data);
  assert.equal(`${shown.verb} ${shown.subject}`, 'Used foo skill');
  assert.equal(row.data?.output, 'FOO-SKILL-BODY: write the notes as a table.');
});

// Spec: MUS-SPEC-14-729I (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729i)
test('the same command on a chat that does not run Claude Code gets its expansion inlined, with numbered arguments filled', async t => {
  const h: H = await harness(t);
  const chat = await h.chat('gpt-5.6-terra', h.tree.project);
  const comp = pick(await h.skills(h.tree.project), 'fe:comp', 'command');
  await h.send(chat.id, '/fe:comp Button tailwind', [comp.id]);
  assert.equal((await h.snapshot(chat.id)).status, 'completed');
  assert.equal((await h.launches()).length, 0, 'Claude Code never ran');
  const prompt = String(h.codex[0]?.prompt ?? '');
  assert.match(prompt, /Selected command: \/fe:comp/);
  assert.match(prompt, /<command-instructions>\nBuild the Button component with tailwind styling\.\n<\/command-instructions>/);
});

// Spec: MUS-SPEC-14-729C (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729c)
test('~/.claude entries show in every folder; a folder\'s .claude skills and commands only in that folder', async t => {
  const h: H = await harness(t);
  await h.folderId(h.tree.project); await h.folderId(h.tree.other);
  const inProject = await h.skills(h.tree.project), inOther = await h.skills(h.tree.other);
  for (const name of ['foo', 'bar', 'fe:comp']) { pick(inProject, name); pick(inOther, name); }
  const ship = pick(inProject, 'ship', 'command'), style = pick(inProject, 'house-style', 'skill');
  assert.match(ship.provenance, /\.claude\/commands/); assert.match(style.provenance, /\.claude\/skills/);
  assert.ok(!inOther.some(entry => entry.name === 'ship' || entry.name === 'house-style'), 'another folder does not see them');
  const chat = await h.chat('cc/claude-opus-5-5', h.tree.project);
  await h.send(chat.id, '$ship', [ship.id]);
  const [run] = await h.launches();
  assert.equal(run?.prompt, '/ship', 'a folder command runs in its folder with no arguments');
  const other = await h.chat('cc/claude-opus-5-5', h.tree.other);
  await assert.rejects(h.service.invoke('chat.send', {id: other.id, text: '$ship', requestId: randomUUID(), skillIds: [ship.id]}), /outside this chat’s allowed skill roots/, 'another folder\'s chat cannot run it');
});

// Spec: MUS-SPEC-14-729O (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729o)
test('a skill installed for both clients (~/.agents/skills and ~/.claude/skills, same SKILL.md) is listed once, as the Claude Code skill; a same-named but different skill stays listed twice', async t => {
  const h: H = await harness(t);
  const agents = join(h.tree.home, '.agents', 'skills');
  await mkdir(join(agents, 'foo'), {recursive: true});
  await writeFile(join(agents, 'foo', 'SKILL.md'), await readFile(join(h.tree.home, '.claude', 'skills', 'foo', 'SKILL.md'), 'utf8'));
  await mkdir(join(agents, 'twin'), {recursive: true}); await mkdir(join(h.tree.home, '.claude', 'skills', 'twin'), {recursive: true});
  await writeFile(join(agents, 'twin', 'SKILL.md'), '---\nname: twin\ndescription: The agents twin\n---\nA\n');
  await writeFile(join(h.tree.home, '.claude', 'skills', 'twin', 'SKILL.md'), '---\nname: twin\ndescription: The Claude twin\n---\nB\n');
  const skills = await h.skills(h.tree.other);
  const foos = skills.filter(entry => entry.name === 'foo');
  assert.equal(foos.length, 1, `foo once; got ${foos.map(entry => entry.provenance).join(', ')}`);
  assert.equal(foos[0].claude, 'skill', 'the kept row is the Claude Code skill, so a Claude Code run invokes it natively');
  assert.deepEqual(skills.filter(entry => entry.name === 'twin').map(entry => entry.shortDescription).sort(), ['The Claude twin', 'The agents twin'], 'different skills under one name both stay');
  const chat = await h.chat('cc/claude-opus-5-5', h.tree.other);
  await h.send(chat.id, '$foo the notes', [foos[0].id]);
  const [run] = await h.launches();
  assert.equal(run?.prompt, '/foo the notes', 'the kept row still runs natively');
});

// Spec: MUS-SPEC-14-729D (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729d)
test('a command turned off in Skills & plugins leaves the picker and a send that still names it is refused', async t => {
  const h: H = await harness(t);
  await h.folderId(h.tree.project);
  const bar = pick(await h.skills(h.tree.project), 'bar', 'command');
  await h.service.invoke('extensions.enablement.set', {extensionId: `skill:${qualifiedSkillName(bar)}`, scope: 'user', scopeId: '', enabled: false});
  assert.ok(!(await h.skills(h.tree.project)).some(entry => entry.name === 'bar'), 'gone from the picker');
  pick(await h.skills(h.tree.project), 'foo');
  const chat = await h.chat('cc/claude-opus-5-5', h.tree.project);
  await assert.rejects(h.service.invoke('chat.send', {id: chat.id, text: '$bar x', requestId: randomUUID(), skillIds: [bar.id]}), /The \/bar command is disabled here/);
  assert.equal((await h.launches()).length, 0, 'nothing ran');
});

/** Plugin entries shaped like the real inventory: connector plugins with an app, a server, or both. */
const icon = (name: string) => ({kind: 'image' as const, dataUrl: `data:image/png;base64,${Buffer.from(name).toString('base64')}`});
const plugin = (name: string, displayName: string, servers: string[], apps: string[]): PluginEntry => ({id: `/cache/${name}`, name, displayName, version: '1', provenance: 'codex', path: `/cache/${name}`, skills: [], readError: null,
  mcpServers: servers.map(server => ({name: server, transport: 'remote' as const})), apps: apps.map(app => ({name: app, id: `connector_${app}`, required: false})), icon: icon(name)});
const inventory = [plugin('github', 'GitHub', [], ['github']), plugin('google-drive', 'Google Drive', [], ['google-drive']), plugin('figma', 'Figma', ['figma'], ['figma', 'figma_runtime']), plugin('slack', 'Slack', [], ['slack']), plugin('notion', 'Notion', ['notion'], ['notion'])];

// Name resolution behind MUS-SPEC-14-729E (the drawn rows are checked in the DOM suite).
test('tool calls from connector and plugin servers resolve to that plugin\'s icon under every name the coding clients give them', () => {
  const cases: Array<[string, string, string | undefined]> = [
    ['mcp__codex_apps__github', '_create_pull_request', 'GitHub'],
    ['mcp__codex_apps__slack', '_slack_read_channel', 'Slack'],
    ['codex_apps', 'google_drive.list_drives', 'Google Drive'],
    ['figma', 'get_screenshot', 'Figma'],
    ['plugin_figma_figma', 'get_design_context', 'Figma'],
    ['claude_ai_Notion', 'search', 'Notion'],
    ['mcp__node_repl', 'js', undefined],
    ['muster_browser', 'browser_click', undefined],
  ];
  for (const [server, tool, expected] of cases) assert.equal(mcpMark(inventory, server, tool)?.plugin, expected, `${server} / ${tool}`);
  assert.deepEqual(mcpMark(inventory, 'plugin_figma_figma')?.icon, icon('figma'), 'the mark is the plugin\'s own icon');
  assert.deepEqual(mcpServerNames('codex_apps', 'google_drive.list_drives'), ['google_drive', 'codex_apps']);
  assert.equal(mcpMark([], 'figma'), undefined, 'no inventory, no mark');
  assert.deepEqual([mcpToolLabel('_slack_read_channel', 'Slack'), mcpToolLabel('google_drive.list_drives', 'Google Drive'), mcpToolLabel('_create_pull_request', 'GitHub'), mcpToolLabel('github', 'GitHub')],
    ['read channel', 'list drives', 'create pull request', 'github'], 'rows read the tool, not the connector plumbing');
});

/** A real PNG: noisy pixels do not compress, so a 512px one is about 1 MB, like the logos plugins ship. */
function png(size: number, noisy: boolean): Buffer {
  const row = Buffer.alloc(1 + size * 4), rows: Buffer[] = [];
  for (let y = 0; y < size; y++) { const line = Buffer.from(row); if (noisy) randomFillSync(line, 1); else line.fill(0x7f, 1); rows.push(line); }
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// Spec: MUS-SPEC-14-729Q (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729q)
test('a plugin whose logo file is over the icon budget (Computer Use ships a 900 KB, 1024px PNG) still shows its logo, scaled down, in Skills & plugins and on its MCP server', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-729q-')), saved = process.env.HOME;
  process.env.HOME = join(root, 'home');
  const dir = join(root, 'home', '.codex', 'plugins', 'cache', 'openai-bundled', 'computer-use', '1.0.1');
  await mkdir(join(dir, '.codex-plugin'), {recursive: true}); await mkdir(join(dir, 'assets'));
  const logo = png(512, true), scaled = png(64, false);
  assert.ok(logo.length > 256 * 1024, `the fixture logo is over the budget (${logo.length} bytes)`);
  await writeFile(join(dir, 'assets', 'app-icon.png'), logo);
  await writeFile(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'computer-use', version: '1.0.1', interface: {displayName: 'Computer Use', logo: './assets/app-icon.png', brandColor: '#0F172A'}}));
  const asked: number[] = [];
  const service = createAgentService({dataDir: root, onEvent() {}, downscaleIcon(bytes: Buffer, size: number) { asked.push(size); return bytes.equals(logo) ? scaled : null; }});
  t.after(async () => { await service.dispose(); if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; await rm(root, {recursive: true, force: true}); });
  const inventory = await service.invoke('plugins.inventory', undefined);
  const plugin = inventory.find(entry => entry.name === 'computer-use');
  assert.ok(plugin, 'the plugin is listed');
  assert.deepEqual(plugin.icon, {kind: 'image', dataUrl: `data:image/png;base64,${scaled.toString('base64')}`}, 'the logo shows, not the CU monogram');
  assert.ok(asked.length === 1 && asked[0] >= 96, `scaled once to a crisp icon size (asked ${asked})`);
  assert.deepEqual(mcpMark(inventory, 'computer-use')?.icon, plugin.icon, 'its MCP server row and tool rows carry the same logo');
  const install = async (name: string, file: string, bytes: Buffer | string) => {
    const pluginDir = join(root, 'home', '.codex', 'plugins', 'cache', 'openai-bundled', name, '1.0.0');
    await mkdir(join(pluginDir, '.codex-plugin'), {recursive: true}); await mkdir(join(pluginDir, 'assets'));
    await writeFile(join(pluginDir, 'assets', file), bytes);
    await writeFile(join(pluginDir, '.codex-plugin', 'plugin.json'), JSON.stringify({name, version: '1.0.0', interface: {displayName: name, logo: `./assets/${file}`}}));
  };
  const huge = png(1600, true);
  assert.ok(huge.length > 8 * 1024 * 1024, `the fixture is over the 8 MB source limit (${huge.length} bytes)`);
  await install('huge-logo', 'logo.png', huge);
  await install('undecodable-logo', 'logo.png', png(400, true));
  await install('big-svg', 'logo.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><!--${'x'.repeat(300 * 1024)}--><rect width="1" height="1"/></svg>`);
  asked.length = 0;
  const after = await service.invoke('plugins.inventory', undefined);
  for (const name of ['huge-logo', 'undecodable-logo', 'big-svg']) {
    const entry = after.find(item => item.name === name);
    assert.ok(entry, `${name} is listed`);
    assert.ok(entry.icon?.kind !== 'image', `${name} keeps its monogram (${entry.icon?.kind})`);
  }
  assert.equal(asked.length, 1, `only the decodable-size raster reaches the scaler; the 8 MB one and the SVG never do (asked ${asked.length})`);
});

// Spec: MUS-SPEC-14-729S (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729s)
test('an installed remote plugin with no logo on disk (Atlassian) shows the logo Codex lists for it, kept in a local cache; unsafe or non-image downloads keep the monogram', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-729s-')), saved = process.env.HOME;
  process.env.HOME = join(root, 'home');
  const cache = join(root, 'home', '.codex', 'plugins', 'cache', 'openai-curated-remote');
  const plugin = async (name: string, displayName: string) => {
    const dir = join(cache, name, '2.0.2'); await mkdir(join(dir, '.codex-plugin'), {recursive: true});
    await writeFile(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({name, version: '2.0.2', interface: {displayName}}));
  };
  await plugin('app-atlassian', 'Atlassian'); await plugin('app-plain', 'Plain'); await plugin('app-page', 'Page'); await plugin('app-huge', 'Huge');
  const light = png(64, false), dark = png(48, false);
  const served: Record<string, {type: string; body: Buffer}> = {
    'https://files.example/atlassian.png': {type: 'image/png', body: light},
    'https://files.example/atlassian-dark.png': {type: 'image/png', body: dark},
    'https://files.example/page.png': {type: 'text/html', body: Buffer.from('<html><script>alert(1)</script></html>')},
    'https://files.example/huge.png': {type: 'image/png', body: Buffer.concat([light, Buffer.alloc(9 * 1024 * 1024)])},
  };
  const fetched: string[] = [];
  const fakeFetch = (async (url: string) => {
    fetched.push(String(url));
    const hit = served[String(url)];
    return hit ? new Response(new Uint8Array(hit.body), {status: 200, headers: {'content-type': hit.type}}) : new Response('missing', {status: 404});
  }) as typeof fetch;
  const row = (name: string, face: Record<string, unknown>, installed = true) => ({id: `${name}@openai-curated-remote`, name, installed, source: {type: 'remote'}, interface: {displayName: name, ...face}});
  const listing = {marketplaces: [{name: 'openai-curated-remote', plugins: [
    row('app-atlassian', {composerIconUrl: 'https://files.example/atlassian.png', logoUrlDark: 'https://files.example/atlassian-dark.png'}),
    row('app-plain', {logoUrl: 'http://files.example/atlassian.png'}),
    row('app-page', {logoUrl: 'https://files.example/page.png'}),
    row('app-huge', {logoUrl: 'https://files.example/huge.png'}),
    row('app-relative', {logoUrl: '/images/ecosystem/apps/github/icon.png'}),
    row('app-not-installed', {logoUrl: 'https://files.example/atlassian.png'}, false),
  ]}]};
  const events: string[] = [];
  let lists = 0;
  const service = createAgentService({dataDir: root, onEvent(event) { events.push(event.type); },
    remotePluginIcons: {delayMs: 0, listPlugins: async () => { lists++; return listing; }, fetch: fakeFetch}});
  let second: ReturnType<typeof createAgentService> | undefined;
  t.after(async () => { await service.dispose(); await second?.dispose(); if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; await rm(root, {recursive: true, force: true}); });
  for (let i = 0; i < 100 && !events.includes('pluginIconsChanged'); i++) await delay(20);
  assert.ok(events.includes('pluginIconsChanged'), 'the app is told the plugin marks changed, so open menus redraw');
  const icon = (inventory: PluginEntry[], name: string) => inventory.find(entry => entry.name === name)?.icon;
  const inventory = await service.invoke('plugins.inventory', undefined);
  assert.deepEqual(icon(inventory, 'app-atlassian'), {kind: 'image', dataUrl: `data:image/png;base64,${light.toString('base64')}`, darkDataUrl: `data:image/png;base64,${dark.toString('base64')}`}, 'Atlassian shows its logo, with the dark variant for the dark theme');
  for (const name of ['app-plain', 'app-page', 'app-huge']) assert.equal(icon(inventory, name)?.kind, 'monogram', `${name}: a non-https, non-image or oversized download is not used`);
  assert.ok(!fetched.some(url => url.startsWith('http:') || url.startsWith('/')), 'only absolute https URLs are fetched');
  assert.ok(!fetched.includes('https://files.example/atlassian.png') || fetched.filter(url => url === 'https://files.example/atlassian.png').length === 1, 'a plugin that is not installed is not fetched');
  assert.equal(mcpMark(inventory, 'app-atlassian')?.icon, icon(inventory, 'app-atlassian'), 'connector and tool rows carry the same logo');
  // Offline, on the next launch: the cached logo still shows and nothing is listed or downloaded again inside the refresh window.
  fetched.length = 0; const listsBefore = lists;
  const again = createAgentService({dataDir: root, onEvent() {}, remotePluginIcons: {delayMs: 0, listPlugins: async () => { lists++; throw new Error('offline'); }, fetch: (async () => { throw new Error('offline'); }) as typeof fetch}});
  second = again;
  await delay(100);
  const offline = await again.invoke('plugins.inventory', undefined);
  assert.equal(icon(offline, 'app-atlassian')?.kind, 'image', 'the cached logo shows offline');
  assert.equal(lists, listsBefore, 'a fresh cache is not refreshed on every launch');
  assert.deepEqual(fetched, []);
});

// Spec: MUS-SPEC-14-729T (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-729t)
test('a marketplace plugin with no logo (the Claude marketplace’s linear) shows the logo an OpenAI catalog lists under the same name; other marketplaces, other names and skills keep their monogram', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-729t-')), saved = process.env.HOME;
  process.env.HOME = join(root, 'home');
  extensionsOptions.codexCache = join(root, 'no-codex-cache'); extensionsOptions.claudeMarketplaces = join(root, 'no-claude-marketplaces');
  const market = join(root, 'claude-market'), skills = join(root, 'skill-folder');
  for (const name of ['linear', 'homebrew-thing']) {
    await mkdir(join(market, 'plugins', name, '.claude-plugin'), {recursive: true});
    await writeFile(join(market, 'plugins', name, '.claude-plugin', 'plugin.json'), JSON.stringify({name, description: `${name} tools`}));
    await writeFile(join(market, 'plugins', name, '.mcp.json'), JSON.stringify({mcpServers: {[name]: {type: 'http', url: `https://mcp.${name}.example/mcp`}}}));
  }
  await mkdir(join(market, '.claude-plugin'), {recursive: true});
  await writeFile(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({name: 'claude-market', owner: {name: 'Fixture'}, plugins: [{name: 'linear', source: './plugins/linear'}, {name: 'homebrew-thing', source: './plugins/homebrew-thing'}]}));
  await mkdir(join(skills, 'skills', 'gitlab'), {recursive: true});
  await writeFile(join(skills, 'skills', 'gitlab', 'SKILL.md'), '---\nname: gitlab\ndescription: Notes about GitLab\n---\nUse GitLab.\n');
  const logo = png(64, false);
  const fetched: string[] = [];
  const fakeFetch = (async (url: string) => { fetched.push(String(url)); return new Response(new Uint8Array(logo), {status: 200, headers: {'content-type': 'image/png'}}); }) as typeof fetch;
  const row = (id: string, url: string) => ({id, name: id.slice(0, id.indexOf('@')), installed: false, interface: {logoUrl: url}});
  const listing = {marketplaces: [
    {name: 'openai-curated-remote', plugins: [row('linear@openai-curated-remote', 'https://files.example/linear.png'), row('gitlab@openai-curated-remote', 'https://files.example/gitlab.png')]},
    {name: 'acme-market', plugins: [row('homebrew-thing@acme-market', 'https://files.example/homebrew.png')]},
  ]};
  const events: string[] = [];
  let lists = 0;
  const service = createAgentService({dataDir: join(root, 'data'), onEvent(event) { events.push(event.type); },
    remotePluginIcons: {delayMs: 0, topUpDelayMs: 0, listPlugins: async () => { lists++; return listing; }, fetch: fakeFetch}});
  t.after(async () => { await service.dispose(); extensionsOptions.codexCache = undefined; extensionsOptions.claudeMarketplaces = undefined; if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; await rm(root, {recursive: true, force: true}); });
  await service.invoke('extensions.sources.add', {kind: 'local', path: market});
  await service.invoke('extensions.sources.add', {kind: 'local', path: skills});
  for (let i = 0; i < 50 && lists === 0; i++) await delay(20);
  // Mark the event stream before asking: with no delays the background lookup can finish while the catalog call returns.
  const mark = events.length;
  const before = await service.invoke('extensions.catalog', undefined);
  const pkg = (catalog: typeof before, name: string, kind = 'plugin') => catalog.find(entry => entry.name === name && entry.kind === kind);
  assert.notEqual(pkg(before, 'linear')?.icon?.kind, 'image', 'before the lookup Linear has no logo of its own');
  let after = before;
  for (let i = 0; i < 150 && !(events.slice(mark).includes('pluginIconsChanged') && pkg(after, 'linear')?.icon?.kind === 'image'); i++) { await delay(20); after = await service.invoke('extensions.catalog', undefined); }
  assert.ok(events.slice(mark).includes('pluginIconsChanged'), 'the asked-for names are looked up in the background and the app is told to redraw');
  assert.deepEqual(pkg(after, 'linear')?.icon, {kind: 'image', dataUrl: `data:image/png;base64,${logo.toString('base64')}`}, 'Linear shows the logo the OpenAI catalog lists for linear');
  assert.notEqual(pkg(after, 'homebrew-thing')?.icon?.kind, 'image', 'a name only a third-party catalog lists is not borrowed');
  assert.notEqual(pkg(after, 'gitlab', 'skill')?.icon?.kind, 'image', 'a skill is not a brand’s plugin: it keeps its monogram');
  assert.deepEqual(fetched, ['https://files.example/linear.png'], 'only the matched logo is downloaded');
  const listsNow = lists;
  await service.invoke('extensions.catalog', undefined); await delay(100);
  assert.equal(lists, listsNow, 'a name looked up once is not looked up again');
});

// Spec: MUS-SPEC-14-732A (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-732a)
test('a command file swapped for a symlink right after it is checked is not read through the link, in the picker or when a run attaches it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-732a-')), saved = process.env.HOME, original = fsPromises.realpath;
  process.env.HOME = join(root, 'home');
  const commands = join(root, 'home', '.claude', 'commands');
  await mkdir(commands, {recursive: true});
  const secret = join(root, 'secret.txt');
  await writeFile(secret, 'SECRET-OUTSIDE-THE-COMMANDS-FOLDER\n');
  await writeFile(join(commands, 'swap.md'), 'SWAP-BODY\n');
  const target = await realpath(join(commands, 'swap.md'));
  t.after(async () => { fsPromises.realpath = original; if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; await rm(root, {recursive: true, force: true}); });
  // The swap lands between the last containment check (the second time the file's path is resolved) and the read.
  let seen = 0;
  const armSwap = () => { seen = 0; };
  fsPromises.realpath = (async (...args: Parameters<typeof original>) => {
    const resolved = await original(...args);
    if (resolved === target && ++seen === 2) { await unlink(target); await symlink(secret, target); }
    return resolved;
  }) as typeof original;
  armSwap();
  const listed = (await discoverSkills([])).find(entry => entry.name === 'swap');
  assert.doesNotMatch(listed?.readme ?? '', /SECRET/, 'the picker never shows the file the link points at');
  await unlink(target); await writeFile(target, 'SWAP-BODY\n'); armSwap();
  const attached = await resolveAttachedSkill(target, []);
  assert.doesNotMatch(attached?.content ?? '', /SECRET/, 'a run never gets the file the link points at');
  fsPromises.realpath = original;
  await unlink(target); await writeFile(target, 'SWAP-BODY\n');
  assert.equal((await resolveAttachedSkill(target, []))?.content, 'SWAP-BODY\n', 'an untouched command still reads');
});

// Spec: MUS-SPEC-14-732B (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-732b)
test('a logo URL that redirects to plain http is never fetched over http; an https to https redirect still brings the logo', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-732b-')), saved = process.env.HOME;
  process.env.HOME = join(root, 'home');
  const cache = join(root, 'home', '.codex', 'plugins', 'cache', 'openai-curated-remote');
  for (const name of ['app-downgrade', 'app-hop']) {
    const dir = join(cache, name, '1.0.0'); await mkdir(join(dir, '.codex-plugin'), {recursive: true});
    await writeFile(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({name, version: '1.0.0', interface: {displayName: name}}));
  }
  const logo = png(64, false);
  const redirects: Record<string, string> = {'https://files.example/downgrade.png': 'http://files.example/logo.png', 'https://files.example/hop.png': '/cdn/logo.png'};
  const served: Record<string, Buffer> = {'http://files.example/logo.png': logo, 'https://files.example/cdn/logo.png': logo};
  const fetched: string[] = [];
  // Behaves like fetch: `redirect: 'follow'` (the default) follows Location itself; `manual` hands the 3xx back.
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    let current = String(url);
    for (let hop = 0; hop < 5; hop++) {
      fetched.push(current);
      const next = redirects[current];
      if (!next) break;
      if (init?.redirect === 'manual') return new Response(null, {status: 302, headers: {location: next}});
      current = new URL(next, current).href;
    }
    const body = served[current];
    return body ? new Response(new Uint8Array(body), {status: 200, headers: {'content-type': 'image/png'}}) : new Response('missing', {status: 404});
  }) as typeof fetch;
  const row = (name: string, logoUrl: string) => ({id: `${name}@openai-curated-remote`, name, installed: true, source: {type: 'remote'}, interface: {displayName: name, logoUrl}});
  const listing = {marketplaces: [{name: 'openai-curated-remote', plugins: [row('app-downgrade', 'https://files.example/downgrade.png'), row('app-hop', 'https://files.example/hop.png')]}]};
  const events: string[] = [];
  const service = createAgentService({dataDir: root, onEvent(event) { events.push(event.type); }, remotePluginIcons: {delayMs: 0, listPlugins: async () => listing, fetch: fakeFetch}});
  t.after(async () => { await service.dispose(); if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; await rm(root, {recursive: true, force: true}); });
  for (let i = 0; i < 100 && !events.includes('pluginIconsChanged'); i++) await delay(20);
  const inventory = await service.invoke('plugins.inventory', undefined);
  const icon = (name: string) => inventory.find(entry => entry.name === name)?.icon;
  assert.ok(!fetched.some(url => url.startsWith('http:')), `nothing is requested over http; requested ${fetched.join(', ')}`);
  assert.equal(icon('app-downgrade')?.kind, 'monogram', 'a logo behind an http redirect keeps the monogram');
  assert.equal(icon('app-hop')?.kind, 'image', 'a relative https redirect is followed');
});

// Spec: MUS-SPEC-14-732I (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-732i)
test('a command folder swapped for a link to an outside folder while it is read is refused, even if every check sees the folder restored', {skip: process.platform !== 'darwin' && 'needs O_NOFOLLOW_ANY (macOS)'}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-732i-')), saved = process.env.HOME, originalRealpath = fsPromises.realpath, originalLstat = fsPromises.lstat;
  process.env.HOME = join(root, 'home');
  const commands = join(root, 'home', '.claude', 'commands'), outside = join(root, 'outside');
  await mkdir(join(commands, 'team'), {recursive: true}); await mkdir(outside);
  await writeFile(join(commands, 'team', 'review.md'), 'TEAM-REVIEW-BODY\n');
  await writeFile(join(outside, 'review.md'), 'SECRET-OUTSIDE-THE-COMMANDS-FOLDER\n');
  const inside = await realpath(join(commands, 'team', 'review.md')), secretStat = await stat(join(outside, 'review.md'));
  t.after(async () => { fsPromises.realpath = originalRealpath; fsPromises.lstat = originalLstat; if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; await rm(root, {recursive: true, force: true}); });
  // The racer keeps team/ as a link to the outside folder, but restores it whenever the reader resolves or lstats the path.
  await rm(join(commands, 'team'), {recursive: true}); await symlink(outside, join(commands, 'team'));
  fsPromises.realpath = (async (...args: Parameters<typeof originalRealpath>) => String(args[0]) === inside ? inside : originalRealpath(...args)) as typeof originalRealpath;
  fsPromises.lstat = (async (...args: Parameters<typeof originalLstat>) => String(args[0]) === inside ? secretStat : originalLstat(...args)) as typeof originalLstat;
  const listed = (await discoverSkills([])).find(entry => entry.name === 'team:review');
  assert.doesNotMatch(listed?.readme ?? '', /SECRET/, 'the picker never shows the outside file');
  const attached = await resolveAttachedSkill(inside, []);
  assert.doesNotMatch(attached?.content ?? '', /SECRET/, 'a run never gets the outside file');
});

// Spec: MUS-SPEC-14-732J (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-732j)
test('an inlined command keeps a quoted argument whole, splitting its arguments the way Claude Code does', async t => {
  const h: H = await harness(t);
  const chat = await h.chat('gpt-5.6-terra', h.tree.project);
  const comp = pick(await h.skills(h.tree.project), 'fe:comp', 'command');
  await h.send(chat.id, `/fe:comp "Button primary" 'tailwind v4'`, [comp.id]);
  assert.equal((await h.snapshot(chat.id)).status, 'completed');
  const prompt = String(h.codex[0]?.prompt ?? '');
  assert.match(prompt, /<command-instructions>\nBuild the Button primary component with tailwind v4 styling\.\n<\/command-instructions>/, prompt.slice(prompt.indexOf('<command-instructions>'), prompt.indexOf('</command-instructions>') + 24));
});

// Spec: MUS-SPEC-14-732C (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-732c)
test('an entry Claude Code would not reach by its name (a project command under a personal one, a command under a same-named skill) runs as picked, inlined, not as /name', async t => {
  const h: H = await harness(t);
  await writeFile(join(h.tree.project, '.claude', 'commands', 'bar.md'), 'PROJECT-BAR-BODY: check $ARGUMENTS the project way.\n');
  await writeFile(join(h.tree.home, '.claude', 'commands', 'foo.md'), 'FOO-COMMAND-BODY: list $ARGUMENTS.\n');
  await h.folderId(h.tree.project);
  const skills = await h.skills(h.tree.project);
  const bars = skills.filter(entry => entry.name === 'bar' && entry.claude === 'command');
  assert.equal(bars.length, 2, 'both bar commands are listed');
  const projectBar = bars.find(entry => entry.provenance.startsWith('.claude/commands'))!, personalBar = bars.find(entry => entry.provenance === '~/.claude/commands')!;
  const runs = async (entry: SkillEntry, text: string) => {
    const chat = await h.chat('cc/claude-opus-5-5', h.tree.project);
    const before = (await h.launches()).length;
    await h.send(chat.id, text, [entry.id]);
    const launches = await h.launches();
    assert.equal(launches.length, before + 1, 'Claude Code ran the turn');
    return {prompt: launches.at(-1)!.prompt, system: flag(launches.at(-1)!.argv, '--append-system-prompt') ?? ''};
  };
  const project = await runs(projectBar, '/bar the API');
  assert.doesNotMatch(project.prompt, /^\/bar/, 'Claude Code would run the personal bar for /bar, so the project one is not sent by name');
  assert.match(project.prompt + project.system, /PROJECT-BAR-BODY: check the API the project way\./, 'the picked project command is what runs');
  const personal = await runs(personalBar, '/bar the API');
  assert.equal(personal.prompt, '/bar the API', 'the personal bar is the one Claude Code reaches, so it still runs natively');
  const fooCommand = pick(skills, 'foo', 'command'), fooSkill = pick(skills, 'foo', 'skill');
  const command = await runs(fooCommand, '/foo the changes');
  assert.doesNotMatch(command.prompt, /^\/foo/, 'a skill named foo wins /foo in Claude Code, so the command is not sent by name');
  assert.match(command.prompt + command.system, /FOO-COMMAND-BODY: list the changes\./);
  const skill = await runs(fooSkill, 'the notes $foo');
  assert.equal(skill.prompt, '/foo the notes', 'the skill is what /foo reaches');
});

// Spec: MUS-SPEC-14-732D (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-732d)
test('a folder whose .claude/skills is a link to its .agents/skills lists the skill as Claude Code\'s and a Claude Code run invokes it by name', async t => {
  const h: H = await harness(t);
  const shared = join(h.tree.other, '.agents', 'skills');
  await mkdir(join(shared, 'shared-notes'), {recursive: true});
  await writeFile(join(shared, 'shared-notes', 'SKILL.md'), '---\nname: shared-notes\ndescription: Shared by both clients\n---\nSHARED-BODY\n');
  await mkdir(join(h.tree.other, '.claude'), {recursive: true});
  await symlink(shared, join(h.tree.other, '.claude', 'skills'));
  await h.folderId(h.tree.other);
  const listed = (await h.skills(h.tree.other)).filter(entry => entry.name === 'shared-notes');
  assert.equal(listed.length, 1, 'listed once');
  assert.equal(listed[0].claude, 'skill', 'as the Claude Code skill');
  const chat = await h.chat('cc/claude-opus-5-5', h.tree.other);
  await h.send(chat.id, 'the notes $shared-notes', [listed[0].id]);
  const [run] = await h.launches();
  assert.equal(run?.prompt, '/shared-notes the notes', 'Claude Code runs it by name');
});

// Spec: MUS-SPEC-14-732E (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-732e)
test('a logo download that fails is tried again after six hours, not a week later', async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-732e-')), saved = process.env.HOME;
  process.env.HOME = join(root, 'home');
  const dir = join(root, 'home', '.codex', 'plugins', 'cache', 'openai-curated-remote', 'app-atlassian', '1.0.0');
  await mkdir(join(dir, '.codex-plugin'), {recursive: true});
  await writeFile(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({name: 'app-atlassian', version: '1.0.0', interface: {displayName: 'Atlassian'}}));
  const listing = {marketplaces: [{name: 'openai-curated-remote', plugins: [{id: 'app-atlassian@openai-curated-remote', name: 'app-atlassian', installed: true, source: {type: 'remote'}, interface: {displayName: 'Atlassian', logoUrl: 'https://files.example/atlassian.png'}}]}]};
  const logo = png(64, false), start = Date.now(), hour = 60 * 60 * 1000;
  let up = false, fetches = 0;
  const fakeFetch = (async () => { fetches++; return up ? new Response(new Uint8Array(logo), {status: 200, headers: {'content-type': 'image/png'}}) : new Response('busy', {status: 503}); }) as typeof fetch;
  const services: ReturnType<typeof createAgentService>[] = [];
  t.after(async () => { for (const service of services) await service.dispose(); if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; await rm(root, {recursive: true, force: true}); });
  const launch = async (at: number) => {
    const events: string[] = [];
    const service = createAgentService({dataDir: root, onEvent(event) { events.push(event.type); }, remotePluginIcons: {delayMs: 0, now: () => at, listPlugins: async () => listing, fetch: fakeFetch}});
    services.push(service);
    await delay(300);
    return {service, events};
  };
  await launch(start);
  assert.equal(fetches, 1, 'the first launch tries the download');
  const icon = async (service: ReturnType<typeof createAgentService>) => (await service.invoke('plugins.inventory', undefined)).find(entry => entry.name === 'app-atlassian')?.icon?.kind;
  up = true;
  const soon = await launch(start + hour);
  assert.equal(fetches, 1, 'within six hours of a failure nothing is tried again');
  assert.equal(await icon(soon.service), 'monogram');
  const later = await launch(start + 7 * hour);
  assert.equal(fetches, 2, 'after six hours the failed download is tried again');
  assert.ok(later.events.includes('pluginIconsChanged'), 'and the app is told');
  assert.equal(await icon(later.service), 'image', 'Atlassian shows its logo');
});
