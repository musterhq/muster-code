import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createComputerDomain} from '../src/runtime/domains/computer.ts';
import {createSettingsDomain, type ElectronApi} from '../src/runtime/domains/settings.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import {normalizeSettings, parseSettingsImport, validateSetting} from '../src/shared/domains/settings-protocol.ts';

const key = 'general.defaultModel';
const padded = {providerId: 'provider', model: ' model-id ', effort: 'high'};
const clean = {...padded, model: 'model-id'};

test('default model is trimmed when validated, loaded and imported', () => {
  assert.deepEqual(validateSetting(key, padded), clean);
  assert.deepEqual(normalizeSettings({[key]: padded})[key], clean);
  assert.deepEqual(parseSettingsImport(JSON.stringify({format: 'muster-settings', version: 1, settings: {[key]: padded}})).settings[key], clean);
  assert.equal(padded.model, ' model-id ', 'normalization does not mutate the input');
  assert.equal(validateSetting(key, null), null);
  for (const value of [
    {...padded, model: '   '}, {...padded, model: 'bad\nmodel'},
    {...padded, model: 'x'.repeat(257)}, {...padded, providerId: ''},
    {...padded, effort: 'invalid'},
  ]) {
    assert.throws(() => validateSetting(key, value), /general\.defaultModel must be/);
    assert.equal(normalizeSettings({[key]: value})[key], null);
  }
});

test('default model is trimmed before settings.set persists it', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-input-guards-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const electron = {app: {on() {}, off() {}}, BrowserWindow: {getAllWindows: () => []}} as unknown as ElectronApi;
  const domain = createSettingsDomain({dataDir, emit() {}} as unknown as DomainContext, electron);
  t.after(() => domain.dispose?.());
  await domain.handlers['settings.set']!({key, value: padded});
  const stored = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'));
  assert.deepEqual(stored.values[key], clean);
});

test('permission settings reject inherited and unknown pane names before opening anything', async t => {
  const opened: unknown[][] = [];
  t.mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    opened.push(args);
    (args.at(-1) as (error: null) => void)(null);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const domain = createComputerDomain({dataDir: tmpdir(), hooks: {addRunOptionsContributor: () => () => {}}} as unknown as DomainContext);
  t.after(() => domain.dispose?.());
  const open = domain.handlers['computer.openPermissionSettings']!;
  for (const pane of ['constructor', 'toString', '__proto__', 'unknown', '', null, 1]) {
    await assert.rejects(async () => open({pane}), /Unknown settings pane\./);
  }
  assert.equal(opened.length, 0);
  for (const pane of ['accessibility', 'screen']) {
    if (process.platform === 'darwin') await open({pane});
    else await assert.rejects(async () => open({pane}), /macOS only/);
  }
  assert.deepEqual(opened.map(args => args.slice(0, 2)), process.platform === 'darwin' ? [
    ['/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility']],
    ['/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']],
  ] : []);
});
