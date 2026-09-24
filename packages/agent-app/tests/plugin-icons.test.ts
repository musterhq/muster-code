import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPlugins, discoverSkills, invokedPluginContext, parseSkillInterface, resolveInvokedPlugins, svgIcon } from '../src/runtime/plugin-library.ts';
import { initials, monogram, nameHue } from '../src/shared/item-icon.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#EA4335" d="M0 0h16v16H0z"/></svg>';
const BLACK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M0 0h16v16H0z"/></svg>';

async function plugin(cache: string, market: string, name: string, version: string, face: Record<string, unknown>, files: Record<string, string | Buffer> = {}) {
  const dir = join(cache, market, name, version);
  await mkdir(join(dir, '.codex-plugin'), { recursive: true });
  await writeFile(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, version, description: `${name} plugin`, interface: face }));
  for (const [path, body] of Object.entries(files)) { await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), body); }
  return dir;
}

test('plugin inventory reads manifest names, brand colours and sanitized icons with a monogram fallback', async t => {
  const base = await mkdtemp(join(tmpdir(), 'muster-plugin-icons-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cache = join(base, 'cache');
  await plugin(cache, 'openai-curated', 'gmail', '0.1.0', { displayName: 'Gmail', shortDescription: 'Read and manage Gmail', brandColor: '#EA4335', composerIcon: './assets/gmail.png', defaultPrompt: ['Summarize my inbox'] }, { 'assets/gmail.png': PNG });
  await plugin(cache, 'openai-curated', 'github', '0.1.0', { displayName: 'GitHub', brandColor: '#24292F', composerIcon: './assets/github-small.svg', logo: './assets/github.png' }, { 'assets/github-small.svg': BLACK_SVG });
  await plugin(cache, 'openai-curated', 'heygen', '1.0.0', { displayName: 'HeyGen' });
  await plugin(cache, 'openai-curated', 'evil', '1.0.0', { displayName: 'Evil', composerIcon: './assets/x.svg', logo: 'https://example.test/logo.png' }, { 'assets/x.svg': '<svg onload="alert(1)"></svg>' });
  // An icon symlink pointing outside the plugin directory is never read.
  const escape = await plugin(cache, 'openai-curated', 'escape', '1.0.0', { displayName: 'Escape', composerIcon: './assets/icon.png' });
  await writeFile(join(base, 'outside.png'), PNG); await mkdir(join(escape, 'assets')); await symlink(join(base, 'outside.png'), join(escape, 'assets', 'icon.png'));
  // Versions and curated/curated-remote copies collapse to the newest; `latest` is an alias.
  await plugin(cache, 'openai-curated', 'slack', '0.1.2', { displayName: 'Slack old' });
  const slack = await plugin(cache, 'openai-curated', 'slack', '0.1.10', { displayName: 'Slack', composerIcon: './assets/s.svg' }, { 'assets/s.svg': SVG });
  await symlink(slack, join(cache, 'openai-curated', 'slack', 'latest'));
  const old = await plugin(cache, 'openai-curated-remote', 'figma', 'abc123', { displayName: 'Figma old' });
  const fresh = await plugin(cache, 'openai-curated', 'figma', 'def456', { displayName: 'Figma' });
  await utimes(old, new Date(1000), new Date(1000)); await utimes(fresh, new Date(), new Date());

  const entries = await discoverPlugins(cache);
  const by = (name: string) => entries.find(entry => entry.name === name)!;
  assert.deepEqual(entries.map(entry => entry.displayName), ['Escape', 'Evil', 'Figma', 'GitHub', 'Gmail', 'HeyGen', 'Slack']);
  assert.equal(by('gmail').icon?.kind, 'image');
  assert.match((by('gmail').icon as { dataUrl: string }).dataUrl, /^data:image\/png;base64,/);
  assert.equal(by('gmail').brandColor, '#EA4335'); assert.equal(by('gmail').shortDescription, 'Read and manage Gmail'); assert.deepEqual(by('gmail').defaultPrompts, ['Summarize my inbox']);
  assert.deepEqual(by('github').icon && { kind: by('github').icon!.kind, monochrome: (by('github').icon as { monochrome?: boolean }).monochrome }, { kind: 'image', monochrome: true }, 'black-only SVG is flagged for inversion');
  assert.deepEqual(by('heygen').icon, { kind: 'monogram', text: 'H', hue: nameHue('heygen') });
  assert.equal(by('evil').icon?.kind, 'monogram', 'unsafe SVG and remote logos fall back to the monogram');
  assert.equal(by('escape').icon?.kind, 'monogram', 'symlinked icon outside the plugin is refused');
  assert.equal(by('slack').version, '0.1.10'); assert.match((by('slack').icon as { dataUrl: string }).dataUrl, /^data:image\/svg\+xml;base64,/);
  assert.equal(by('figma').version, 'def456', 'non-semver duplicates keep the most recently modified copy');
  assert.deepEqual(await discoverPlugins(cache), entries, 'monograms and icons are deterministic across scans');

  const invoked = await resolveInvokedPlugins([by('gmail').id], cache);
  assert.equal(invoked[0].displayName, 'Gmail');
  assert.match(invokedPluginContext(invoked), /invoked the Gmail plugin \(@gmail\)/);
  await assert.rejects(resolveInvokedPlugins([join(base, 'nope')], cache), /no longer installed/);
});

test('SVG sanitizer rejects scripts, handlers, foreign content and external references', () => {
  for (const bad of ['<svg><script>x</script></svg>', '<svg><a onclick="x"/></svg>', '<svg><foreignObject/></svg>', '<svg><image href="https://x/y.png"/></svg>', '<svg><style>@import url(https://x)</style></svg>', '<html><svg/></html>', 'plain text'])
    assert.equal(svgIcon(Buffer.from(bad)), null, bad);
  assert.equal(svgIcon(Buffer.from(SVG))?.kind, 'image');
  assert.equal(svgIcon(Buffer.alloc(70 * 1024, 'a')), null, 'size cap');
});

test('skills read agents/openai.yaml interface and SKILL.md front matter', async t => {
  const home = await mkdtemp(join(tmpdir(), 'muster-skill-icons-'));
  const previous = process.env.HOME; process.env.HOME = home;
  t.after(async () => { process.env.HOME = previous; await rm(home, { recursive: true, force: true }); });
  const pdf = join(home, '.codex', 'skills', 'pdf');
  await mkdir(join(pdf, 'agents'), { recursive: true }); await mkdir(join(pdf, 'assets'));
  await writeFile(join(pdf, 'SKILL.md'), '---\nname: pdf\ndescription: Work with PDFs\n---\nUse pdf tools.');
  await writeFile(join(pdf, 'agents', 'openai.yaml'), 'interface:\n  display_name: "PDF Skill"\n  short_description: Create, edit, and review PDFs\n  icon_large: "./assets/pdf.png"\n');
  await writeFile(join(pdf, 'assets', 'pdf.png'), PNG);
  const plain = join(home, '.codex', 'skills', 'review');
  await mkdir(plain, { recursive: true });
  await writeFile(join(plain, 'SKILL.md'), '---\nname: review\ndescription: >-\n  Review the\n  current diff\n---\nChecklist.');
  const skills = await discoverSkills();
  const by = (name: string) => skills.find(skill => skill.name === name)!;
  assert.equal(by('pdf').displayName, 'PDF Skill'); assert.equal(by('pdf').shortDescription, 'Create, edit, and review PDFs'); assert.equal(by('pdf').icon?.kind, 'image');
  assert.equal(by('review').displayName, 'review'); assert.equal(by('review').shortDescription, 'Review the current diff'); assert.equal(by('review').icon?.kind, 'monogram');
  assert.deepEqual(parseSkillInterface('interface:\n  display_name: \'It\'\'s\'\n  icon_small: ./a.svg # note\nother:\n  display_name: nope\n'), { display_name: "It's", icon_small: './a.svg' });
});

test('monogram initials and brand hues are deterministic', () => {
  assert.equal(initials('Google Drive'), 'GD'); assert.equal(initials('heygen'), 'H'); assert.equal(initials('unified-computer-use'), 'UC');
  assert.deepEqual(monogram('Gmail', 'gmail', '#EA4335'), { kind: 'monogram', text: 'G', hue: 5 });
  assert.equal(monogram('Notion', 'notion', '#111111').kind === 'monogram' && (monogram('Notion', 'notion', '#111111') as { hue: number }).hue, nameHue('notion'), 'near-black brands use the name hash');
});
