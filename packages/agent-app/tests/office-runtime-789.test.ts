/**
 * #789 phase 1: Muster's own office runtime. LibreOffice is downloaded on first use into Muster's data folder (never bundled),
 * a copy the user installed is preferred, and another app's runtime folders are never read. The network, the unpacker and
 * soffice are fakes: nothing here downloads for real.
 */
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {constants, promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir, tmpdir} from 'node:os';
import {join, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {OfficeRuntime, PINNED_LIBREOFFICE, pinnedBuild, installedCandidates, type OfficeBuild, type OfficeFetch, type OfficeRuntimeProgress} from '../src/runtime/office-runtime.ts';
import {renderOfficeFile} from '../src/runtime/office-render.ts';
import {CANDIDATE_PATHS, findSoffice, setOfficeRuntime} from '../src/runtime/document-preview.ts';
import {DOMAIN_FACTORIES} from '../src/runtime/domains/index.ts';
import {officeRuntimeTesting} from '../src/runtime/domains/office.ts';
import {createDomainHooks} from '../src/runtime/domains/hooks.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import type {AgentEvent} from '../src/shared/protocol.ts';

async function directory(t: TestContext, prefix = 'muster-office-'): Promise<string> {
  const path = await fs.realpath(await fs.mkdtemp(join(tmpdir(), prefix)));
  t.after(() => fs.rm(path, {recursive: true, force: true}));
  return path;
}
const exists = (path: string) => fs.access(path).then(() => true, () => false);

/** A pinned build whose bytes are `payload`. */
function buildFor(payload: Buffer, overrides: Partial<OfficeBuild> = {}): OfficeBuild {
  return {version: '26.2.6', platform: 'darwin', arch: 'arm64', kind: 'dmg', file: 'LibreOffice_test.dmg',
    urls: ['https://download.example.invalid/lo.dmg', 'https://archive.example.invalid/lo.dmg'],
    sha256: createHash('sha256').update(payload).digest('hex'), bytes: payload.length, ...overrides};
}

/** A fake download server. `cutAt` drops the connection once that many bytes of the file were sent (then clears itself). */
function server(payload: Buffer, options: {cutAt?: number; ranges?: boolean; status?: (url: string) => number | undefined} = {}) {
  const calls: Array<{url: string; range: string | undefined}> = [];
  let cutAt = options.cutAt;
  const fetch: OfficeFetch = async (url, init) => {
    const range = init.headers['Range'];
    calls.push({url, range});
    const forced = options.status?.(url);
    if (forced) return {status: forced, headers: {get: () => null}, body: null};
    let start = 0, status = 200;
    if (range && options.ranges !== false) { start = Number(/^bytes=(\d+)-$/.exec(range)![1]); status = 206; }
    const slice = payload.subarray(start), cut = cutAt; cutAt = undefined;
    async function* body() {
      const end = cut === undefined ? slice.length : Math.min(slice.length, Math.max(0, cut - start));
      for (let at = 0; at < end; at += 4096) yield slice.subarray(at, Math.min(end, at + 4096));
      if (end < slice.length) throw new Error('socket hang up');
    }
    const headers: Record<string, string> = {'content-length': String(slice.length)};
    if (status === 206) headers['content-range'] = `bytes ${start}-${payload.length - 1}/${payload.length}`;
    return {status, headers: {get: name => headers[name.toLowerCase()] ?? null}, body: body()};
  };
  return {fetch, calls};
}

/** Unpacks like the real dmg step: a LibreOffice.app with an executable soffice. */
const fakeExtract = async (_archive: string, into: string) => {
  const bin = join(into, 'LibreOffice.app', 'Contents', 'MacOS');
  await fs.mkdir(bin, {recursive: true});
  await fs.writeFile(join(bin, 'soffice'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  await fs.writeFile(join(into, 'LibreOffice.app', 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleShortVersionString</key><string>26.2.6.3</string></dict></plist>');
};

function recordingProbe(probed: string[]) {
  return async (path: string) => { probed.push(path); try { await fs.access(path, constants.X_OK); return true; } catch { return false; } };
}

// Spec: MUS-SPEC-21-789A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789a)
test('a LibreOffice the user installed is used and nothing is downloaded', async t => {
  const dir = await directory(t), root = join(dir, 'office-runtime');
  const installed = join(dir, 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice');
  await fs.mkdir(join(installed, '..'), {recursive: true});
  await fs.writeFile(installed, '#!/bin/sh\n', {mode: 0o755});
  const payload = Buffer.alloc(10_000, 7), net = server(payload);
  // A downloaded copy exists too: the user's own install still wins.
  const first = new OfficeRuntime({root, build: buildFor(payload), fetch: net.fetch, extract: fakeExtract, candidates: [], env: {}});
  await first.ensure();
  const calls = net.calls.length;
  const runtime = new OfficeRuntime({root, build: buildFor(payload), fetch: net.fetch, extract: fakeExtract, candidates: ['/nonexistent/soffice', installed], env: {}});
  assert.equal(await runtime.soffice(), installed);
  assert.equal(await runtime.ensure(), installed);
  assert.equal(net.calls.length, calls, 'ensure() with an installed copy makes no request');
  const status = await runtime.status();
  assert.equal(status.source, 'installed');
  assert.equal(status.path, installed);
  // On PATH counts as installed as well.
  const onPath = new OfficeRuntime({root: join(dir, 'other-root'), build: buildFor(payload), fetch: net.fetch, extract: fakeExtract, candidates: [], env: {PATH: ['/nonexistent', join(installed, '..')].join(process.platform === 'win32' ? ';' : ':')}, platform: 'darwin'});
  assert.equal(await onPath.soffice(), installed);
  assert.equal((await onPath.status()).source, 'installed');
});

// Spec: MUS-SPEC-21-789B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789b)
test('the pinned LibreOffice downloads into Muster\'s data folder with progress', async t => {
  const dir = await directory(t), root = join(dir, 'office-runtime');
  const payload = Buffer.alloc(64 * 1024 + 123, 3), net = server(payload), progress: OfficeRuntimeProgress[] = [];
  const runtime = new OfficeRuntime({root, build: buildFor(payload), fetch: net.fetch, extract: fakeExtract, candidates: [], env: {}});
  assert.equal((await runtime.status()).source, 'none');
  assert.equal(await runtime.soffice(), null);
  const soffice = await runtime.ensure(event => progress.push(event));
  assert.ok(soffice.startsWith(root + sep), `installed under Muster's data folder: ${soffice}`);
  assert.ok(soffice.endsWith(join('LibreOffice.app', 'Contents', 'MacOS', 'soffice')));
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0]!.url, 'https://download.example.invalid/lo.dmg');
  const downloads = progress.filter(event => event.phase === 'downloading');
  assert.ok(downloads.length >= 2, 'more than one progress event');
  assert.ok(downloads.every((event, i) => event.total === payload.length && (i === 0 || event.received >= downloads[i - 1]!.received)));
  assert.equal(downloads.at(-1)!.received, payload.length);
  assert.deepEqual(progress.map(event => event.phase).filter((phase, i, all) => all.indexOf(phase) === i), ['downloading', 'verifying', 'installing']);
  const status = await runtime.status();
  assert.equal(status.source, 'downloaded');
  assert.equal(status.version, '26.2.6');
  assert.ok((status.bytes ?? 0) > 0);
  assert.equal(status.path, soffice);
  // A second ensure (and a concurrent pair) reuses the install.
  const again = await Promise.all([runtime.ensure(), runtime.ensure()]);
  assert.deepEqual(again, [soffice, soffice]);
  assert.equal(net.calls.length, 1);
  // The archive is not kept after install.
  assert.deepEqual(await fs.readdir(join(root, 'downloads')).catch(() => []), []);
});

// Spec: MUS-SPEC-21-789C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789c)
test('an interrupted download resumes from the partial file', async t => {
  const dir = await directory(t), root = join(dir, 'office-runtime');
  const payload = Buffer.from(Array.from({length: 50_000}, (_, i) => i % 251));
  const net = server(payload, {cutAt: 20_480});
  const runtime = new OfficeRuntime({root, build: buildFor(payload), fetch: net.fetch, extract: fakeExtract, candidates: [], env: {}});
  await assert.rejects(runtime.ensure(), /hang up|interrupted/i);
  const partial = join(root, 'downloads', 'LibreOffice_test.dmg.part');
  assert.equal((await fs.stat(partial)).size, 20_480, 'the received bytes are kept');
  const before = await runtime.status();
  assert.equal(before.source, 'none');
  assert.equal(before.partialBytes, 20_480);
  const progress: OfficeRuntimeProgress[] = [];
  const soffice = await runtime.ensure(event => progress.push(event));
  assert.equal(net.calls.at(-1)!.range, 'bytes=20480-', 'asks only for the rest');
  assert.equal(progress.find(event => event.phase === 'downloading')!.received >= 20_480, true, 'progress starts from the kept bytes');
  assert.ok(await exists(soffice));
  assert.equal(await exists(partial), false);
  // A server that ignores Range restarts the file from zero instead of appending a second copy.
  const dir2 = await directory(t), root2 = join(dir2, 'office-runtime');
  const noRanges = server(payload, {cutAt: 8_192, ranges: false});
  const runtime2 = new OfficeRuntime({root: root2, build: buildFor(payload), fetch: noRanges.fetch, extract: fakeExtract, candidates: [], env: {}});
  await assert.rejects(runtime2.ensure());
  assert.ok(await exists(await runtime2.ensure()));
});

// Spec: MUS-SPEC-21-789D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789d)
test('a download that fails its checksum is rejected and deleted', async t => {
  const dir = await directory(t), root = join(dir, 'office-runtime');
  const payload = Buffer.alloc(30_000, 1), tampered = Buffer.from(payload); tampered[100] = 2;
  const net = server(tampered);
  let extracted = 0;
  const runtime = new OfficeRuntime({root, build: buildFor(payload), fetch: net.fetch, extract: async (...args) => { extracted++; await fakeExtract(...args); }, candidates: [], env: {}});
  await assert.rejects(runtime.ensure(), /checksum/i);
  assert.equal(extracted, 0, 'nothing from a bad download is unpacked');
  assert.deepEqual(await fs.readdir(join(root, 'downloads')).catch(() => []), [], 'the bad file is deleted');
  const status = await runtime.status();
  assert.equal(status.source, 'none');
  assert.equal(status.partialBytes, 0);
  assert.match(status.error ?? '', /checksum/i);
  // The next attempt starts from zero (no Range on a deleted file).
  await assert.rejects(runtime.ensure(), /checksum/i);
  assert.equal(net.calls.at(-1)!.range, undefined);
});

// Spec: MUS-SPEC-21-789E (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789e)
test('a failed unpack leaves no half-installed runtime', async t => {
  const dir = await directory(t), root = join(dir, 'office-runtime');
  const payload = Buffer.alloc(12_000, 9), net = server(payload);
  const broken = new OfficeRuntime({root, build: buildFor(payload), fetch: net.fetch, candidates: [], env: {},
    extract: async (_archive, into) => { await fs.mkdir(join(into, 'LibreOffice.app', 'Contents'), {recursive: true}); await fs.writeFile(join(into, 'LibreOffice.app', 'Contents', 'half'), 'x'); throw new Error('disk full'); }});
  await assert.rejects(broken.ensure(), /disk full/);
  assert.equal((await broken.status()).source, 'none');
  const left = await fs.readdir(root);
  assert.deepEqual(left.filter(name => name !== 'downloads'), [], `no staging or install folder is left: ${left.join(', ')}`);
  // An unpack that produces no soffice is refused the same way.
  const empty = new OfficeRuntime({root, build: buildFor(payload), fetch: net.fetch, candidates: [], env: {}, extract: async () => {}});
  await assert.rejects(empty.ensure(), /soffice/);
  assert.deepEqual((await fs.readdir(root)).filter(name => name !== 'downloads'), []);
  // A good unpack then installs in one step: the install folder appears complete, with its manifest.
  const good = new OfficeRuntime({root, build: buildFor(payload), fetch: net.fetch, extract: fakeExtract, candidates: [], env: {}});
  const soffice = await good.ensure();
  const installs = await fs.readdir(join(root, 'libreoffice'));
  assert.deepEqual(installs, ['26.2.6']);
  assert.ok(await exists(join(root, 'libreoffice', '26.2.6', 'manifest.json')));
  assert.ok(soffice.startsWith(join(root, 'libreoffice', '26.2.6') + sep));
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('staging')), []);
});

// Spec: MUS-SPEC-21-789F (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789f)
test('remove deletes only Muster\'s downloaded copy', async t => {
  const dir = await directory(t), root = join(dir, 'office-runtime');
  const payload = Buffer.alloc(9_000, 5), net = server(payload);
  const runtime = new OfficeRuntime({root, build: buildFor(payload), fetch: net.fetch, extract: fakeExtract, candidates: [], env: {}});
  await runtime.ensure();
  const removed = await runtime.remove();
  assert.equal(removed.removed, true);
  assert.ok(removed.bytes > 0);
  assert.equal(await exists(join(root, 'libreoffice')), false);
  const status = await runtime.status();
  assert.equal(status.source, 'none');
  assert.equal(status.bytes, null);
  // With only the user's own install there is nothing of Muster's to remove, and the user's copy is untouched.
  const installed = join(dir, 'own', 'soffice');
  await fs.mkdir(join(dir, 'own'));
  await fs.writeFile(installed, '#!/bin/sh\n', {mode: 0o755});
  const theirs = new OfficeRuntime({root, build: buildFor(payload), fetch: net.fetch, extract: fakeExtract, candidates: [installed], env: {}});
  assert.deepEqual(await theirs.remove(), {removed: false, bytes: 0});
  assert.ok(await exists(installed));
  // A partial download is removed too.
  const cut = server(payload, {cutAt: 4_096});
  const partial = new OfficeRuntime({root, build: buildFor(payload), fetch: cut.fetch, extract: fakeExtract, candidates: [], env: {}});
  await assert.rejects(partial.ensure());
  assert.equal((await partial.status()).partialBytes, 4_096);
  await partial.remove();
  assert.equal((await partial.status()).partialBytes, 0);
});

// Spec: MUS-SPEC-21-789G (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789g)
test('another app\'s runtime folders are never probed', async t => {
  const dir = await directory(t), root = join(dir, 'office-runtime'), home = homedir();
  // Only the user's standard installs, PATH and Muster's own folder: nothing in another app's home or cache.
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    for (const path of installedCandidates(platform, home, {LOCALAPPDATA: join(home, 'AppData', 'Local'), ProgramFiles: 'C:\\Program Files'})) {
      const inHome = path.startsWith(home) ? path.slice(home.length) : '';
      assert.ok(!/[\\/]\.[^\\/]+[\\/]/.test(inHome), `${platform}: no dot-folder in home (another app's cache): ${path}`);
    }
  }
  for (const path of CANDIDATE_PATHS) assert.ok(!path.startsWith(home + sep + '.'), `document preview never probes a dot-folder in home: ${path}`);
  const probed: string[] = [];
  const payload = Buffer.alloc(2_000, 4), net = server(payload);
  const candidates = ['/nonexistent/LibreOffice.app/Contents/MacOS/soffice'];
  const runtime = new OfficeRuntime({root, build: buildFor(payload), fetch: net.fetch, extract: fakeExtract, candidates, env: {PATH: '/nonexistent/bin'}, platform: 'darwin', isExecutable: recordingProbe(probed)});
  await runtime.status();
  await runtime.ensure();
  await runtime.status();
  const allowed = new Set([...candidates, join('/nonexistent/bin', 'soffice'), join('/nonexistent/bin', 'libreoffice')]);
  for (const path of probed) assert.ok(allowed.has(path) || path.startsWith(root + sep), `unexpected probe: ${path}`);
  // With no installed copy and no other app present, rendering still has a soffice: Muster's own.
  assert.ok((await runtime.soffice())!.startsWith(root + sep));
});

// Spec: MUS-SPEC-21-789H (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789h)
test('the document preview finds soffice through the office runtime', async t => {
  const saved = process.env['MUSTER_SOFFICE_PATH'];
  delete process.env['MUSTER_SOFFICE_PATH'];
  t.after(() => { setOfficeRuntime(null); if (saved !== undefined) process.env['MUSTER_SOFFICE_PATH'] = saved; });
  const dir = await directory(t), root = join(dir, 'office-runtime');
  const payload = Buffer.alloc(3_000, 6), net = server(payload);
  const runtime = new OfficeRuntime({root, build: buildFor(payload), fetch: net.fetch, extract: fakeExtract, candidates: [], env: {}});
  setOfficeRuntime(runtime);
  // Not downloaded yet: the preview says LibreOffice is missing (so the viewer falls back) and points at Settings; it never downloads by itself.
  await assert.rejects(findSoffice([]), (error: Error) => error.message.startsWith('LibreOffice not installed') && /Settings/.test(error.message));
  assert.equal(net.calls.length, 0);
  const soffice = await runtime.ensure();
  assert.equal(await findSoffice([]), soffice);
});

/** A soffice stand-in: writes `doc.pdf` into --outdir from a fixture PDF. */
function fakeConvert(pdf: Buffer, seen: {args?: string[]; tmp?: string}) {
  return async (_soffice: string, args: string[]) => {
    seen.args = args;
    const outdir = args[args.indexOf('--outdir') + 1]!;
    seen.tmp = join(outdir, '..');
    await fs.writeFile(join(outdir, 'doc.pdf'), pdf);
  };
}
/** A two-page PDF with a filled box on each page. */
function twoPagePdf(): Buffer {
  const objects = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>', '<</Length 26>>stream\n0 0 1 rg 10 10 80 40 re f\nendstream',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 6 0 R>>', '<</Length 26>>stream\n1 0 0 rg 20 20 80 40 re f\nendstream'];
  let body = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((object, i) => { offsets.push(body.length); body += `${i + 1} 0 obj${object}endobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// Spec: MUS-SPEC-21-789I (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789i)
test('rendering an office file gives page images and cleans its temp folder', async t => {
  const dir = await directory(t), tmpRoot = join(dir, 'tmp'), outDir = join(dir, 'out');
  await fs.mkdir(tmpRoot);
  const file = join(dir, 'Quarterly report.docx');
  await fs.writeFile(file, 'PK fake docx');
  let ensured = 0;
  const seen: {args?: string[]; tmp?: string} = {};
  const result = await renderOfficeFile(file, {runtime: {ensure: async () => { ensured++; return '/fake/soffice'; }}, outDir, tmpRoot, run: fakeConvert(twoPagePdf(), seen)});
  assert.equal(ensured, 1, 'the runtime is ensured (downloaded on first use)');
  assert.ok(seen.args!.includes('--headless') && seen.args!.includes('--convert-to') && seen.args!.includes('pdf'));
  assert.ok(seen.args!.some(arg => arg.startsWith('-env:UserInstallation=')), 'an isolated LibreOffice profile');
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.pages, [join(outDir, 'page-1.png'), join(outDir, 'page-2.png')]);
  for (const page of result.pages) assert.deepEqual([...(await fs.readFile(page)).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a real PNG from pdf.js');
  assert.equal(result.pdf, join(outDir, 'Quarterly report.pdf'));
  assert.ok((await fs.readFile(result.pdf)).subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.deepEqual(await fs.readdir(tmpRoot), [], 'the temp folder is removed');
  assert.equal(await fs.readFile(file, 'utf8'), 'PK fake docx', 'the source is never changed');
  // A PDF is rasterized directly: no LibreOffice needed.
  const pdfFile = join(dir, 'plain.pdf');
  await fs.writeFile(pdfFile, twoPagePdf());
  const direct = await renderOfficeFile(pdfFile, {runtime: {ensure: async () => { throw new Error('not needed'); }}, outDir: join(dir, 'out2'), tmpRoot, maxPages: 1});
  assert.equal(direct.pageCount, 2);
  assert.equal(direct.pages.length, 1, 'maxPages caps the images');
});

// Spec: MUS-SPEC-21-789J (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789j)
test('a render that runs past its timeout stops and leaves no temp files', async t => {
  const dir = await directory(t), tmpRoot = join(dir, 'tmp'), outDir = join(dir, 'out');
  await fs.mkdir(tmpRoot);
  const file = join(dir, 'slow.pptx');
  await fs.writeFile(file, 'PK slow');
  let aborted = false;
  const hang = (_soffice: string, _args: string[], signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('killed')); }, {once: true});
  });
  const started = Date.now();
  await assert.rejects(renderOfficeFile(file, {runtime: {ensure: async () => '/fake/soffice'}, outDir, tmpRoot, timeoutMs: 150, run: hang}), /timed out/i);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(aborted, true, 'the conversion is told to stop (the process tree is killed)');
  assert.deepEqual(await fs.readdir(tmpRoot), [], 'the temp folder is removed');
  assert.deepEqual(await fs.readdir(outDir).catch(() => []), [], 'no partial output');
  // A conversion that fails is cleaned up the same way.
  await assert.rejects(renderOfficeFile(file, {runtime: {ensure: async () => '/fake/soffice'}, outDir, tmpRoot, run: async () => { throw new Error('LibreOffice exited with code 1.'); }}), /code 1/);
  assert.deepEqual(await fs.readdir(tmpRoot), []);
});

// Spec: MUS-SPEC-21-789K (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789k)
test('Settings commands report the runtime and download it in the background', async t => {
  const dataDir = await directory(t), db = new DatabaseSync(':memory:');
  t.after(() => { db.close(); officeRuntimeTesting.options = undefined; setOfficeRuntime(null); });
  const payload = Buffer.alloc(40_000, 8), net = server(payload);
  officeRuntimeTesting.options = {build: buildFor(payload), fetch: net.fetch, extract: fakeExtract, candidates: [], env: {}};
  const events: AgentEvent[] = [];
  const domain = DOMAIN_FACTORIES.office({dataDir, db: () => db, hooks: createDomainHooks().hooks, emit: event => events.push(event)} as unknown as DomainContext);
  t.after(() => domain.dispose?.());
  const h = domain.handlers as Record<string, (input: unknown) => unknown>;
  const none = await h['office.runtime.status']!({}) as {source: string; pinned: {version: string; bytes: number} | null};
  assert.equal(none.source, 'none');
  assert.deepEqual(none.pinned && {version: none.pinned.version, bytes: none.pinned.bytes}, {version: '26.2.6', bytes: payload.length});
  const started = await h['office.runtime.download']!({}) as {phase: string};
  assert.equal(started.phase, 'downloading', 'returns at once; progress arrives as events');
  for (let i = 0; i < 500 && (await h['office.runtime.status']!({}) as {source: string}).source !== 'downloaded'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const done = await h['office.runtime.status']!({}) as {source: string; version: string; bytes: number; path: string; phase: string};
  assert.equal(done.source, 'downloaded');
  assert.equal(done.version, '26.2.6');
  assert.ok(done.path.startsWith(join(dataDir, 'office-runtime') + sep));
  assert.equal(done.phase, 'idle');
  const changes = events.filter(event => event.type === 'officeRuntimeChanged') as Array<{type: 'officeRuntimeChanged'; status: {phase: string; received?: number}}>;
  assert.ok(changes.some(event => event.status.phase === 'downloading' && (event.status.received ?? 0) > 0), 'progress events for the Settings row');
  assert.equal(changes.at(-1)!.status.phase, 'idle');
  const removed = await h['office.runtime.remove']!({}) as {source: string};
  assert.equal(removed.source, 'none');
});

// Spec: MUS-SPEC-21-789L (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789l)
test('every pinned LibreOffice build is an official https download with a SHA-256', () => {
  assert.match(PINNED_LIBREOFFICE.version, /^\d+\.\d+\.\d+$/);
  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']] as const) {
    const build = pinnedBuild(platform, arch);
    assert.ok(build, `${platform}-${arch} has a pinned build`);
    assert.equal(build.version, PINNED_LIBREOFFICE.version);
    assert.match(build.sha256, /^[0-9a-f]{64}$/);
    assert.ok(build.bytes > 100_000_000 && build.bytes < 500_000_000, `${build.file}: ${build.bytes}`);
    assert.ok(build.urls.length >= 1);
    for (const url of build.urls) assert.match(url, /^https:\/\/download(archive)?\.documentfoundation\.org\/libreoffice\//);
  }
  assert.equal(pinnedBuild('freebsd', 'x64'), null);
});
