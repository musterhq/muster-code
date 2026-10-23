import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {PluginUiRegistry} from '../src/main/plugin-ui.ts';
import {pluginUiEntry} from '../src/runtime/domains/artifacts.ts';

async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'muster-plugin-paths-')));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const root = join(dir, 'plugin');
  await mkdir(root);
  await mkdir(join(root, '..pages'));
  for (const entry of ['..index.html', '..pages/index.html', '..notes.txt']) {
    await writeFile(join(root, entry), entry);
  }
  await mkdir(join(dir, '..outside'));
  await writeFile(join(dir, '..outside', 'secret.html'), 'secret');
  await symlink(join(dir, '..outside', 'secret.html'), join(root, 'escape.html'));
  const plugin = (ui: string) => ({id: root, path: root, name: 'demo', apps: [{name: 'Board', ui}]});
  return {root, plugin};
}

test('plugin UI entries allow names beginning with two dots', async t => {
  const {plugin} = await fixture(t);
  for (const entry of ['..index.html', '..pages/index.html']) {
    assert.equal((await pluginUiEntry(plugin(entry), 'Board')).entry, entry);
  }
});

test('plugin UI files allow names beginning with two dots', async t => {
  const {root} = await fixture(t);
  const registry = new PluginUiRegistry();
  const {url} = registry.register({pluginId: root, app: 'Board', title: 'Board', root, entry: '..index.html'});
  const base = `muster-plugin://${new URL(url).host}`;
  for (const entry of ['..index.html', '..pages/index.html', '..notes.txt']) {
    const response = await registry.respond(`${base}/${entry}`);
    assert.equal(response.status, 200, entry);
    assert.equal(response.body.toString(), entry);
  }
});

test('plugin UI paths still reject traversal segments and escaping symlinks', async t => {
  const {root, plugin} = await fixture(t);
  await assert.rejects(pluginUiEntry(plugin('../..outside/secret.html'), 'Board'), /inside the folder/);
  await assert.rejects(pluginUiEntry(plugin('..pages/../..index.html'), 'Board'), /inside the folder/);
  await assert.rejects(pluginUiEntry(plugin('escape.html'), 'Board'), /outside the plugin/);
  const registry = new PluginUiRegistry();
  const {url} = registry.register({pluginId: root, app: 'Board', title: 'Board', root, entry: '..index.html'});
  const base = `muster-plugin://${new URL(url).host}`;
  assert.equal((await registry.respond(`${base}/..%2f..outside/secret.html`)).status, 403);
  assert.equal((await registry.respond(`${base}/..pages%2f..%2f..index.html`)).status, 403);
  assert.equal((await registry.respond(`${base}/escape.html`)).status, 403);
});
