import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { detectDevicePlatform, deviceNoun, normalizePlatform, setDevicePlatform } from '../src/shared/device-noun.ts';

test('the helper names the computer per OS (#335)', () => {
  const mac = deviceNoun('darwin'), pc = deviceNoun('win32'), linux = deviceNoun('linux');
  assert.deepEqual([mac.title, mac.lower, mac.your, mac.the, mac.bare, mac.possessive], ['This Mac', 'this Mac', 'your Mac', 'the Mac', 'Mac', "this Mac's"]);
  assert.deepEqual([pc.title, pc.lower, pc.your, pc.the, pc.bare, pc.possessive], ['This PC', 'this PC', 'your PC', 'the PC', 'PC', "this PC's"]);
  assert.deepEqual([linux.title, linux.lower, linux.your, linux.the, linux.bare, linux.possessive], ['This computer', 'this computer', 'your computer', 'the computer', 'computer', "this computer's"]);
  assert.deepEqual([mac.fileManager, pc.fileManager, linux.fileManager], ['Finder', 'File Explorer', 'your file manager']);
  assert.deepEqual([mac.os, pc.os, linux.os], ['macOS', 'Windows', 'Linux']);
  assert.equal(pc.secretStore, 'the Windows credential store');
});

test('platform strings from process.platform, navigator.platform and user agents all map', () => {
  assert.equal(normalizePlatform('MacIntel'), 'darwin');
  assert.equal(normalizePlatform('Win32'), 'win32');
  assert.equal(normalizePlatform('Linux x86_64'), 'linux');
  assert.equal(normalizePlatform('freebsd'), 'linux', 'an unknown system reads as a generic computer');
  assert.equal(normalizePlatform(undefined), 'linux');
});

test('setDevicePlatform and MUSTER_DEVICE_PLATFORM pin what device() reports', () => {
  const before = process.env.MUSTER_DEVICE_PLATFORM;
  try {
    process.env.MUSTER_DEVICE_PLATFORM = 'win32';
    assert.equal(detectDevicePlatform(), 'win32');
    setDevicePlatform('linux');
    assert.equal(detectDevicePlatform(), 'linux', 'an explicit pin wins over the environment');
    setDevicePlatform(null);
    assert.equal(detectDevicePlatform(), 'win32');
  } finally {
    setDevicePlatform(null);
    if (before === undefined) delete process.env.MUSTER_DEVICE_PLATFORM; else process.env.MUSTER_DEVICE_PLATFORM = before;
  }
});

/** Strings that name the Mac on purpose. Add a file here only when the feature really is macOS-only. */
const ALLOWED = new Set<string>([
  'src/shared/device-noun.ts',
]);
const LITERAL = /\b(?:This|this|your|Your|the|The) Mac\b/;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}
/** Drops comments (whole-line, block and trailing) so only code and strings are left. */
function code(source: string): string[] {
  const lines: string[] = []; let inBlock = false;
  for (let line of source.split('\n')) {
    if (inBlock) { const end = line.indexOf('*/'); if (end < 0) continue; line = line.slice(end + 2); inBlock = false; }
    line = line.replace(/\/\*.*?\*\//g, '');
    const open = line.indexOf('/*'); if (open >= 0) { line = line.slice(0, open); inBlock = true; }
    line = line.replace(/(^|\s)\/\/.*$/, '$1');
    lines.push(line);
  }
  return lines;
}

test('no user-facing "this Mac" literal outside the helper (#335)', () => {
  const root = join(import.meta.dirname, '..');
  const offenders: string[] = [];
  for (const file of sources(join(root, 'src'))) {
    const rel = relative(root, file).split('\\').join('/');
    if (ALLOWED.has(rel)) continue;
    code(readFileSync(file, 'utf8')).forEach((line, index) => { if (LITERAL.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(offenders, [], 'use device() from src/shared/device-noun.ts instead of naming the Mac:\n' + offenders.join('\n'));
});
