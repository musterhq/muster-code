// #729 (Electron): the app's real logo scaler (nativeImage) behind plugin discovery. Run by scripts/test-electron.mjs.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomFillSync} from 'node:crypto';
import {crc32, deflateSync} from 'node:zlib';
import {app, nativeImage} from 'electron';
import {downscaleIcon} from '../src/main/icon-downscale.ts';
import {createAgentService} from '../src/runtime/service.ts';

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length); return out;
}
/** A PNG of noisy pixels (does not compress, so 512px is about 1 MB like the logos plugins ship), or one whose pixel data is garbage. */
function png(size: number, pixels: 'noisy' | 'garbage'): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 6, 0, 0, 0], 8);
  let data: Buffer;
  if (pixels === 'noisy') { const rows: Buffer[] = []; for (let y = 0; y < size; y++) { const line = Buffer.alloc(1 + size * 4); randomFillSync(line, 1); rows.push(line); } data = deflateSync(Buffer.concat(rows)); }
  else { data = randomFillSync(Buffer.alloc(size * size * 2)); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', data), chunk('IEND', Buffer.alloc(0))]);
}

let failed = false;
async function test(name: string, body: () => Promise<void>): Promise<void> {
  try { await body(); console.log(`ok - ${name}`); } catch (error) { failed = true; console.log(`not ok - ${name}`); console.log(error); }
}

app.dock?.hide();
// Top-level await on whenReady deadlocks an ESM main script, so the test runs from the ready callback.
app.whenReady().then(async () => {
  const root = await mkdtemp(join(tmpdir(), 'muster-729q-electron-')), saved = process.env.HOME;
  process.env.HOME = join(root, 'home');
  const install = async (name: string, displayName: string, bytes: Buffer) => {
    const dir = join(root, 'home', '.codex', 'plugins', 'cache', 'openai-bundled', name, '1.0.0');
    await mkdir(join(dir, '.codex-plugin'), {recursive: true}); await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'app-icon.png'), bytes);
    await writeFile(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({name, version: '1.0.0', interface: {displayName, logo: './assets/app-icon.png'}}));
  };
  const logo = png(512, 'noisy'), garbage = png(400, 'garbage');
  await install('computer-use', 'Computer Use', logo);
  await install('broken-logo', 'Broken Logo', garbage);
  const service = createAgentService({dataDir: join(root, 'data'), onEvent() {}, downscaleIcon});

  // Spec: MUS-SPEC-14-732K (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-732k)
  await test('a plugin logo over the icon budget is scaled by the app\'s real image scaler and shown; one it cannot decode keeps the monogram', async () => {
    assert.ok(logo.length > 256 * 1024 && garbage.length > 256 * 1024, `both fixtures are over the 256 KB budget (${logo.length}, ${garbage.length})`);
    assert.ok(!nativeImage.createFromBuffer(logo).isEmpty(), 'the fixture logo is a real image');
    assert.ok(nativeImage.createFromBuffer(garbage).isEmpty(), 'the broken fixture really cannot be decoded');
    const inventory = await service.invoke('plugins.inventory', undefined);
    const plugin = inventory.find(entry => entry.name === 'computer-use');
    assert.equal(plugin?.icon?.kind, 'image', 'Computer Use shows its logo, not a monogram');
    const dataUrl = (plugin!.icon as {dataUrl: string}).dataUrl;
    assert.match(dataUrl, /^data:image\/png;base64,/);
    const scaled = nativeImage.createFromDataURL(dataUrl);
    assert.deepEqual(scaled.getSize(), {width: 128, height: 128}, 'scaled to 128px');
    assert.ok(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64').length <= 256 * 1024, 'and within the icon budget');
    assert.notEqual(inventory.find(entry => entry.name === 'broken-logo')?.icon?.kind, 'image', 'an undecodable logo keeps the monogram');
  });

  await service.dispose();
  if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
  await rm(root, {recursive: true, force: true});
  app.exit(failed ? 1 : 0);
}).catch(error => { console.error(error); app.exit(1); });
