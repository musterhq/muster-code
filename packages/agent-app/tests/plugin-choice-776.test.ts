// #776: for each plugin Muster ships its own version of (documents, spreadsheets, presentations, PDF, visualize, computer
// use), the person picks Muster's version, an installed one or none in Skills & plugins, and only that one is loaded
// into a chat's home on its next turn. The installed app here is a fake plugin cache and skills folder.
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, readlinkSync, realpathSync} from 'node:fs';
import {chmod, mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter, ProviderInput} from '../src/runtime/provider.ts';
import {pluginSourceOptions} from '../src/runtime/plugin-providers.ts';
import {COMPUTER_MCP_LAUNCHER_ENV} from '../src/runtime/domains/computer.ts';
import {prepareChatCodexHome} from '../src/runtime/codex-home.ts';
import {MUSTER_OFFICE_SKILLS} from '../src/runtime/office-skills.ts';
import {COMPUTER_MCP} from '../src/shared/computer-use.ts';
import type {PluginCapability} from '../src/shared/domains/extensions-protocol.ts';

const appDir = resolve(import.meta.dirname, '..');
const skillsSource = join(appDir, 'resources', 'skills');
const info: ProviderAdapter['info'] = () => [{id: 'fixture', name: 'Fixture', available: true, identityMasked: 'Hidden', models: []}];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const linkTo = (path: string) => { try { return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null; } catch { return null; } };
const there = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };

/** A person's coding-client home with another app's plugins and skills, and their own skill. */
async function personHome(root: string) {
  const source = join(root, 'person-home'), cache = join(source, 'plugins', 'cache');
  const plugin = async (market: string, name: string, version: string) => {
    const dir = join(cache, market, name, version);
    await mkdir(join(dir, '.codex-plugin'), {recursive: true});
    await mkdir(join(dir, 'skills', name), {recursive: true});
    await writeFile(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({name, version, interface: {displayName: name}}));
    await writeFile(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\nThe other app's ${name}.\n`);
    // Something that would leave a mark if anything ran it: listing a version only reads files.
    await writeFile(join(dir, 'install.sh'), `#!/bin/sh\ntouch '${join(root, 'ran')}'\n`); await chmod(join(dir, 'install.sh'), 0o755);
  };
  await plugin('other-market', 'documents', '1.4.0');
  await plugin('other-market', 'pdf', '1.4.0');
  await plugin('other-market', 'template-maker', '2.0.0');
  await plugin('bundled', 'visualize', '1.0.57');
  await plugin('bundled', 'computer-use', '1.0.1');
  await plugin('bundled', 'browser', '1.0.0');
  const skill = async (name: string, front = '') => { await mkdir(join(source, 'skills', name), {recursive: true}); await writeFile(join(source, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n${front}---\n${name}.\n`); };
  await skill('docx', 'version: 3.1\n');
  await skill('pdf');
  await skill('my-skill');
  await writeFile(join(source, 'config.toml'), 'model = "x"\n');
  return {source, cache};
}

async function setup(t: TestContext) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'muster-776-')));
  const {source, cache} = await personHome(root);
  const dataDir = join(root, 'data'), home = join(root, 'muster-home');
  const launcher = join(root, 'computer-launcher'); await writeFile(launcher, '#!/bin/sh\n'); await chmod(launcher, 0o755);
  const saved = process.env[COMPUTER_MCP_LAUNCHER_ENV];
  process.env[COMPUTER_MCP_LAUNCHER_ENV] = launcher;
  pluginSourceOptions.codexHome = source;
  const inputs: ProviderInput[] = [];
  const provider: ProviderAdapter = {info, run: async input => { inputs.push(input); return {status: 'completed', finalMessage: 'done'}; }, stop: async () => true, dispose() {}};
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => {
    await service.dispose(); pluginSourceOptions.codexHome = undefined;
    if (saved === undefined) delete process.env[COMPUTER_MCP_LAUNCHER_ENV]; else process.env[COMPUTER_MCP_LAUNCHER_ENV] = saved;
    await rm(root, {recursive: true, force: true});
  });
  const prepare = () => prepareChatCodexHome(source, home, {dataDir, musterSkills: skillsSource});
  const list = () => service.invoke('extensions.providers.list', undefined);
  const row = (rows: PluginCapability[], id: string) => rows.find(entry => entry.id === id)!;
  return {root, source, cache, dataDir, home, launcher, service, inputs, prepare, list, row};
}

// Spec: MUS-SPEC-14-776A (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-776a)
test("with another app's plugin cache and Muster's built-ins, every plugin lists Muster's version next to the installed one", async t => {
  const {root, source, cache, list, row} = await setup(t);
  const rows = await list();
  assert.deepEqual(rows.map(entry => entry.id), ['documents', 'spreadsheets', 'presentations', 'pdf', 'visualize', 'computer-use']);
  for (const entry of rows) {
    assert.ok(entry.muster, `${entry.id} has Muster's version`);
    assert.equal(entry.muster!.origin, 'muster'); assert.equal(entry.muster!.source, 'Muster');
    assert.ok(entry.muster!.name && entry.muster!.version && entry.muster!.path, `${entry.id}: name, version and path`);
    assert.equal(entry.choice, 'muster', 'Muster\'s by default');
    assert.equal(entry.active?.id, entry.muster!.id);
  }
  for (const name of MUSTER_OFFICE_SKILLS) assert.equal(row(rows, name).muster!.path, join(skillsSource, name));
  const documents = row(rows, 'documents');
  assert.deepEqual(documents.installed.map(entry => [entry.form, entry.path, entry.version]), [
    ['plugin', join(cache, 'other-market', 'documents'), '1.4.0'],
    ['skill', join(source, 'skills', 'docx'), '3.1'],
  ]);
  assert.match(documents.installed[0]!.source, /other-market/);
  for (const entry of documents.installed) assert.equal(entry.origin, 'installed');
  assert.deepEqual(row(rows, 'pdf').installed.map(entry => entry.path), [join(cache, 'other-market', 'pdf'), join(source, 'skills', 'pdf')]);
  assert.deepEqual(row(rows, 'spreadsheets').installed, []);
  assert.deepEqual(row(rows, 'visualize').installed.map(entry => [entry.path, entry.version]), [[join(cache, 'bundled', 'visualize'), '1.0.57']]);
  assert.equal(row(rows, 'visualize').muster!.form, 'tool');
  assert.deepEqual(row(rows, 'computer-use').installed.map(entry => entry.path), [join(cache, 'bundled', 'computer-use')]);
  assert.ok(!existsSync(join(root, 'ran')), 'nothing found was run');
});

// Spec: MUS-SPEC-14-776B (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-776b)
test("choosing the installed version links only that one into the chat's home, and choosing Muster's links only Muster's", async t => {
  const {source, cache, home, service, prepare} = await setup(t);
  const defaults = prepare();
  await service.invoke('extensions.providers.set', {capability: 'documents', choice: 'installed', installedId: join(cache, 'other-market', 'documents')});
  await service.invoke('extensions.providers.set', {capability: 'pdf', choice: 'installed', installedId: join(source, 'skills', 'pdf')});
  await assert.rejects(service.invoke('extensions.providers.set', {capability: 'pdf', choice: 'installed', installedId: join(source, 'skills', 'my-skill')}), /not an installed version/);
  const installed = prepare();
  assert.notEqual(installed.key, defaults.key, 'a changed choice restarts a warm session on the next turn');
  assert.equal(linkTo(join(home, 'plugins', 'cache', 'other-market', 'documents')), join(cache, 'other-market', 'documents'), 'the chosen installed plugin is linked');
  assert.ok(!there(join(home, 'skills', 'documents')), 'Muster\'s documents skill is not loaded beside it');
  assert.ok(!there(join(home, 'skills', 'docx')), 'the other installed documents version stays out');
  assert.equal(linkTo(join(home, 'skills', 'pdf')), join(source, 'skills', 'pdf'), 'the chosen pdf skill is linked');
  assert.ok(!there(join(home, 'plugins', 'cache', 'other-market', 'pdf')), 'the pdf plugin was not chosen');
  assert.equal(linkTo(join(home, 'plugins', 'cache', 'other-market', 'template-maker')), join(cache, 'other-market', 'template-maker'));
  assert.ok(existsSync(join(home, 'skills', 'spreadsheets', 'SKILL.md')), 'other plugins keep Muster\'s version');

  await service.invoke('extensions.providers.set', {capability: 'documents', choice: 'muster'});
  await service.invoke('extensions.providers.set', {capability: 'pdf', choice: 'muster'});
  const back = prepare();
  assert.equal(back.key, defaults.key);
  for (const name of ['documents', 'pdf']) {
    assert.equal(linkTo(join(home, 'skills', name)), null);
    assert.equal(readFileSync(join(home, 'skills', name, 'SKILL.md'), 'utf8'), readFileSync(join(skillsSource, name, 'SKILL.md'), 'utf8'), `${name} is Muster's again`);
    assert.ok(!there(join(home, 'plugins', 'cache', 'other-market', name)));
  }

  await service.invoke('extensions.providers.set', {capability: 'spreadsheets', choice: 'off'});
  prepare();
  assert.ok(!there(join(home, 'skills', 'spreadsheets')), 'off loads neither');
});

// Spec: MUS-SPEC-14-776C (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-776c)
test('when the chosen installed app is removed the next turn falls back to Muster\'s version and says so once', async t => {
  const {cache, home, service, inputs, prepare, list, row} = await setup(t);
  await service.invoke('extensions.providers.set', {capability: 'visualize', choice: 'installed', installedId: join(cache, 'bundled', 'visualize')});
  prepare();
  assert.equal(linkTo(join(home, 'plugins', 'cache', 'bundled', 'visualize')), join(cache, 'bundled', 'visualize'));
  assert.ok(!there(join(home, 'plugins', 'cache', 'bundled', 'computer-use')), 'Muster\'s computer use is chosen, so the other one stays out');

  await rm(join(cache, 'bundled'), {recursive: true, force: true});
  assert.doesNotThrow(() => prepare());
  assert.ok(!there(join(home, 'plugins', 'cache', 'bundled')), 'no broken link is left behind');
  const visualize = row(await list(), 'visualize');
  assert.equal(visualize.choice, 'installed');
  assert.equal(visualize.missing, true);
  assert.equal(visualize.active?.origin, 'muster');

  const chat = await service.invoke('chat.create', {});
  await service.invoke('chat.update', {id: chat.id, mode: 'agent'});
  for (const text of ['first', 'second']) { await service.invoke('chat.send', {id: chat.id, text, requestId: randomUUID()}); for (let i = 0; i < 20 && inputs.length < (text === 'first' ? 1 : 2); i++) await flush(); }
  assert.equal(inputs.length, 2);
  assert.match(inputs[0]!.prompt, /installed Visualize[^\n]*is no longer there[^\n]*Muster's/);
  assert.doesNotMatch(inputs[1]!.prompt, /is no longer there/, 'said once');
});

// Spec: MUS-SPEC-14-776D (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-776d)
test("old whole-folder links get the defaults and a person's own unrelated skill is never removed", async t => {
  const {source, cache, home, service, prepare} = await setup(t);
  await mkdir(home, {recursive: true});
  await symlink(join(source, 'skills'), join(home, 'skills'));
  await symlink(join(source, 'plugins'), join(home, 'plugins'));
  prepare();
  assert.ok(!lstatSync(join(home, 'skills')).isSymbolicLink() && !lstatSync(join(home, 'plugins')).isSymbolicLink(), 'the old links became folders');
  for (const name of MUSTER_OFFICE_SKILLS) assert.ok(existsSync(join(home, 'skills', name, 'SKILL.md')), `${name}: Muster's by default`);
  for (const name of ['documents', 'pdf']) assert.ok(!there(join(home, 'plugins', 'cache', 'other-market', name)));
  assert.ok(!there(join(home, 'plugins', 'cache', 'bundled', 'visualize')));
  assert.equal(linkTo(join(home, 'skills', 'my-skill')), join(source, 'skills', 'my-skill'));

  for (const choice of ['off', 'installed', 'muster'] as const) {
    for (const capability of ['documents', 'spreadsheets', 'presentations', 'pdf', 'visualize', 'computer-use'] as const) {
      if (choice === 'installed' && (capability === 'spreadsheets' || capability === 'presentations')) continue;
      await service.invoke('extensions.providers.set', {capability, choice});
    }
    prepare();
    assert.equal(linkTo(join(home, 'skills', 'my-skill')), join(source, 'skills', 'my-skill'), `the person's own skill stays with ${choice}`);
  }
  // The person's home keeps everything it had.
  for (const path of ['skills/my-skill/SKILL.md', 'skills/docx/SKILL.md', 'skills/pdf/SKILL.md', 'config.toml']) assert.ok(existsSync(join(source, path)), path);
  for (const path of ['other-market/documents/1.4.0', 'other-market/pdf/1.4.0', 'bundled/visualize/1.0.57', 'bundled/computer-use/1.0.1']) assert.ok(existsSync(join(cache, path, '.codex-plugin', 'plugin.json')), path);
});

// Spec: MUS-SPEC-14-776E (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-776e)
test("choosing installed or off for computer use leaves Muster's computer-use server out of the turn", async t => {
  const {cache, home, service, inputs, prepare} = await setup(t);
  const chat = await service.invoke('chat.create', {});
  await service.invoke('chat.update', {id: chat.id, mode: 'agent'});
  const turn = async () => { const before = inputs.length; await service.invoke('chat.send', {id: chat.id, text: 'go', requestId: randomUUID()}); for (let i = 0; i < 20 && inputs.length === before; i++) await flush(); return inputs.at(-1)!; };
  assert.ok((await turn()).configOverrides?.[`mcp_servers.${COMPUTER_MCP}.command`], 'Muster\'s by default');
  await service.invoke('extensions.providers.set', {capability: 'computer-use', choice: 'installed', installedId: join(cache, 'bundled', 'computer-use')});
  assert.equal((await turn()).configOverrides?.[`mcp_servers.${COMPUTER_MCP}.command`], undefined);
  prepare();
  assert.equal(linkTo(join(home, 'plugins', 'cache', 'bundled', 'computer-use')), join(cache, 'bundled', 'computer-use'));
  await service.invoke('extensions.providers.set', {capability: 'computer-use', choice: 'off'});
  assert.equal((await turn()).configOverrides?.[`mcp_servers.${COMPUTER_MCP}.command`], undefined);
  prepare();
  assert.ok(!there(join(home, 'plugins', 'cache', 'bundled', 'computer-use')));
});
