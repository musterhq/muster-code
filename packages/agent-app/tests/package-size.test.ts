import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

const root = path.join(import.meta.dirname, '..');
const script = path.join(root, 'scripts/check-package-size.mjs');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/** A minimal unpacked app: resources/app with a bundle and the given node_modules entries. */
function fixture(modules: Record<string, string[]>, bundle = 'const fs = require("node:fs"); const pty = require("node-pty"); require("electron");') {
  const base = mkdtempSync(path.join(tmpdir(), 'muster-size-'));
  const app = path.join(base, 'win-unpacked/resources/app');
  mkdirSync(path.join(app, 'dist/main'), {recursive: true});
  writeFileSync(path.join(app, 'package.json'), '{}');
  writeFileSync(path.join(app, 'dist/main/index.cjs'), bundle);
  for (const [name, files] of Object.entries(modules)) for (const file of files) {
    mkdirSync(path.dirname(path.join(app, 'node_modules', name, file)), {recursive: true});
    writeFileSync(path.join(app, 'node_modules', name, file), 'x');
  }
  return {base, app};
}
const run = (app: string) => spawnSync(process.execPath, [script, app], {encoding: 'utf8', env: {...process.env, MUSTER_RELEASE_DIR: path.join(app, 'nowhere')}});

test('size budget: only node-pty in node_modules passes and prints a size table', () => {
  const {base, app} = fixture({'node-pty': ['package.json', 'lib/index.js', 'build/Release/pty.node', 'prebuilds/win32-x64/pty.node']});
  try {
    const result = run(app);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /node_modules/);
    assert.match(result.stdout, /Size budget ok/);
  } finally { rmSync(base, {recursive: true, force: true}); }
});

test('size budget: any other package in node_modules fails the build', () => {
  const {base, app} = fixture({'node-pty': ['package.json'], react: ['package.json'], '@napi-rs': ['canvas/index.js']});
  try {
    const result = run(app);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /node_modules must hold only node-pty/);
    assert.match(result.stderr, /react/);
  } finally { rmSync(base, {recursive: true, force: true}); }
});

test('size budget: node-pty build intermediates, foreign prebuilds and unshipped requires fail', () => {
  const {base, app} = fixture({'node-pty': ['package.json', 'build/Release/obj/pty.iobj', 'build/Release/pty.pdb', 'prebuilds/darwin-arm64/pty.node']}, 'require("react")');
  try {
    const result = run(app);
    assert.equal(result.status, 1);
    for (const needle of [/build intermediate: build\/Release\/obj\/pty\.iobj/, /pty\.pdb/, /another platform's prebuild: prebuilds\/darwin-arm64/, /requires "react"/]) assert.match(result.stderr, needle);
  } finally { rmSync(base, {recursive: true, force: true}); }
});

test('packaging config: dependencies are not packed, English locale only, maximum compression, xz deb', () => {
  const yml = read('electron-builder.yml');
  assert.match(yml, /^ {2}- "!node_modules\/\*\*"$/m);
  assert.ok(yml.indexOf('"!node_modules/**"') < yml.indexOf('node_modules/node-pty/**'), 'exclusion comes before the node-pty include');
  assert.match(yml, /^electronLanguages: \[en-US\]$/m);
  assert.match(yml, /^compression: maximum$/m);
  assert.match(yml, /^ {2}compression: xz$/m);
  assert.match(yml, /build\/\*\*\/\*\.\{iobj,ipdb,tlog,obj,pdb,lib,exp/);
  assert.match(read('scripts/after-pack.cjs'), /pruneForeignPrebuilds/);
});

test('mac packaging: LZMA disk image, English-only .lproj before signing', () => {
  const script = read('scripts/package-release.mjs');
  assert.match(script, /'-format', 'ULMO'/);
  assert.doesNotMatch(script, /UDZO/);
  assert.ok(script.indexOf('.lproj') < script.indexOf('// 4. Signing.'), 'locales are removed before the bundle is signed');
  assert.match(script, /CFBundleLocalizations/);
});

test('server tarball is an xz archive and the install docs and workflow agree', () => {
  const repo = path.join(root, '../..');
  assert.match(readFileSync(path.join(repo, 'packages/server/scripts/package.mjs'), 'utf8'), /\.tar\.xz/);
  assert.match(readFileSync(path.join(repo, 'docs/server.md'), 'utf8'), /muster-server-<version>-linux-x64\.tar\.xz/);
  const workflow = readFileSync(path.join(repo, '.github/workflows/agent-app-release.yml'), 'utf8');
  assert.doesNotMatch(workflow, /muster-server-[^\s]*\.tar\.gz/);
  assert.match(workflow, /out\/muster-server-\*\.tar\.xz/);
});
