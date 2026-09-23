import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPOSER_COMMANDS, INIT_PROMPT, chipToken, filterComposerCommands, pendingQuestionItem, pickQuestionOption, pluginPromptHint, questionAnswer, questionDigit, restoreQueueOrder, reviewPrompt, terminalsPillLabel, findChipRanges, type ComposerChip } from '../src/renderer/components/composerMenus.ts';
import { discoverPlugins, svgIcon } from '../src/runtime/plugin-library.ts';
import type { PendingQuestion, TimelineItem } from '../src/shared/protocol.ts';

test('S3-A /status /mcp /init /review are real built-ins with Codex descriptions', () => {
  for (const id of ['status', 'mcp', 'init', 'review'] as const) assert.equal(filterComposerCommands(id)[0]?.id, id, id);
  const by = (id: string) => COMPOSER_COMMANDS.find(command => command.id === id)!;
  assert.equal(by('status').description, 'Show chat ID, context usage, and rate limits');
  assert.equal(by('mcp').description, 'Show MCP server status');
  assert.equal(by('init').description, 'Create an AGENTS.md file with instructions');
  assert.equal(filterComposerCommands('pl')[0]?.id, 'plan', 'existing ranking is unchanged');
  assert.equal(filterComposerCommands('summarize')[0]?.id, 'compact');
  assert.match(INIT_PROMPT, /^Generate a file named AGENTS\.md/);
  const review = reviewPrompt(Array.from({ length: 45 }, (_, index) => `f${index}.ts`));
  assert.match(review, /- f0\.ts\n/); assert.match(review, /- …and 5 more/); assert.ok(!review.includes('f44.ts'));
  assert.match(review, /Do not modify any files/);
});

test('S3-A connector chips: @mcp: and @app: tokens', () => {
  assert.equal(chipToken('mcp', 'github'), '@mcp:github');
  assert.equal(chipToken('app', 'Google Drive'), '@app:"Google Drive"');
});

const question = (patch: Partial<PendingQuestion> = {}): PendingQuestion => ({ id: 'q', header: 'Pick', question: 'Which?', options: [{ label: 'A' }, { label: 'B', value: 'b-value' }], allowCustomAnswer: true, multiSelect: false, ...patch });
test('S3-A pending question: oldest pending item, 1–9 picks, typed custom answer wins', () => {
  const item = (id: string, status: string): TimelineItem => ({ id, chatId: 'c', kind: 'question', text: '', status, createdAt: '', data: { method: 'item/tool/requestUserInput', questions: [question()] } });
  assert.equal(pendingQuestionItem([item('old', 'answered'), item('now', 'pending'), item('later', 'pending')])?.item.id, 'now');
  assert.equal(pendingQuestionItem([item('x', 'dismissed')]), null);
  assert.equal(pendingQuestionItem(undefined), null);
  assert.equal(questionDigit('1'), 0); assert.equal(questionDigit('9'), 8); assert.equal(questionDigit('0'), null); assert.equal(questionDigit('a'), null);
  const single = question();
  assert.deepEqual(pickQuestionOption({}, single, 1), { q: ['b-value'] }, 'value wins over label');
  assert.deepEqual(pickQuestionOption({ q: ['A'] }, single, 1), { q: ['b-value'] }, 'single-select replaces');
  assert.equal(pickQuestionOption({}, single, 5), null, 'no such option');
  const multi = question({ multiSelect: true });
  const both = pickQuestionOption(pickQuestionOption({}, multi, 0)!, multi, 1)!;
  assert.deepEqual(both, { q: ['A', 'b-value'] });
  assert.deepEqual(pickQuestionOption(both, multi, 0), { q: ['b-value'] }, 'multi-select toggles');
  assert.deepEqual(questionAnswer({ q: ['A'] }, single, '  my own  '), ['my own'], 'typed text is the custom answer');
  assert.deepEqual(questionAnswer({ q: ['A'] }, single, ''), ['A'], 'blank keeps the selected option');
  assert.deepEqual(questionAnswer({ q: ['A'] }, question({ allowCustomAnswer: false }), 'typed'), ['A'], 'no custom answers allowed: typing is ignored');
  assert.deepEqual(questionAnswer({}, question({ options: [], allowCustomAnswer: false }), 'free'), ['free'], 'free-text question');
});

test('S3-A plugin defaultPrompt hint shows only while the draft is chips alone', () => {
  const chips: ComposerChip[] = [{ token: '@linear', kind: 'plugin', id: 'p1', label: 'Linear' }];
  const plugins = [{ id: 'p1', defaultPrompts: ['Triage my issues'] }];
  assert.equal(pluginPromptHint('@linear ', findChipRanges('@linear ', chips), plugins), 'Triage my issues');
  assert.equal(pluginPromptHint('@linear fix it', findChipRanges('@linear fix it', chips), plugins), '');
  assert.equal(pluginPromptHint('@linear ', findChipRanges('@linear ', chips), [{ id: 'p1' }]), '', 'no default prompt');
  assert.equal(pluginPromptHint('', [], plugins), '');
});

test('S3-A small helpers: Terminals label, queued Undo order', () => {
  assert.equal(terminalsPillLabel(1), '1 Terminal'); assert.equal(terminalsPillLabel(3), '3 Terminals');
  assert.deepEqual(restoreQueueOrder(['b', 'c', 'new'], 'new', 0), ['new', 'b', 'c']);
  assert.deepEqual(restoreQueueOrder(['b', 'c', 'new'], 'new', 1), ['b', 'new', 'c']);
  assert.deepEqual(restoreQueueOrder(['b'], 'new', 7), ['b', 'new'], 'past the end: last');
});

test('S3-A full access skip list is per folder and reversible', async () => {
  const saved = new Map<string, string>(), events: string[] = [];
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } },
    window: { dispatchEvent: (event: { type: string }) => { events.push(event.type); return true; } }, CustomEvent: class { constructor(public type: string) {} } });
  const { fullAccessSkipFolders, setFullAccessSkip, skipsFullAccessConfirm, FULL_ACCESS_SKIP_EVENT } = await import('../src/renderer/components/composerMenus.ts');
  assert.equal(skipsFullAccessConfirm('a'), false);
  setFullAccessSkip('a', true); setFullAccessSkip('b', true); setFullAccessSkip('a', true);
  assert.deepEqual(fullAccessSkipFolders(), ['a', 'b']);
  assert.equal(skipsFullAccessConfirm('a'), true); assert.equal(skipsFullAccessConfirm(undefined), false);
  setFullAccessSkip('a', false);
  assert.deepEqual(fullAccessSkipFolders(), ['b']);
  assert.deepEqual(events, [FULL_ACCESS_SKIP_EVENT, FULL_ACCESS_SKIP_EVENT, FULL_ACCESS_SKIP_EVENT], 'no event for a no-op');
  saved.set('muster.fullAccess.skipConfirm', '{bad json');
  assert.deepEqual(fullAccessSkipFolders(), [], 'corrupt storage reads as none');
});

test('CS-C3-2 plugin logos: logoDark is carried as the dark-theme variant; white-only marks are flagged', async t => {
  const WHITE = '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#FFFFFF" d="M0 0h16v16H0z"/></svg>';
  const BLACK = '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#000" d="M0 0h16v16H0z"/></svg>';
  const COLOR = '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#EA4335" d="M0 0h16v16H0z"/></svg>';
  assert.deepEqual({ ...svgIcon(Buffer.from(WHITE)), dataUrl: '' }, { kind: 'image', dataUrl: '', monochromeLight: true });
  assert.equal((svgIcon(Buffer.from(BLACK)) as { monochromeLight?: boolean }).monochromeLight, undefined);
  assert.equal((svgIcon(Buffer.from(COLOR)) as { monochromeLight?: boolean }).monochromeLight, undefined);
  const base = await mkdtemp(join(tmpdir(), 'muster-s3a-logo-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cache = join(base, 'cache');
  const plugin = async (name: string, face: Record<string, unknown>, files: Record<string, string>) => {
    const dir = join(cache, 'openai-curated', name, '1.0.0');
    await mkdir(join(dir, '.codex-plugin'), { recursive: true }); await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', interface: face }));
    for (const [path, body] of Object.entries(files)) await writeFile(join(dir, path), body);
  };
  await plugin('github', { displayName: 'GitHub', composerIcon: './assets/light.svg', logoDark: './assets/dark.svg' }, { 'assets/light.svg': BLACK, 'assets/dark.svg': WHITE });
  await plugin('onlydark', { displayName: 'Only Dark', logoDark: './assets/dark.svg' }, { 'assets/dark.svg': WHITE });
  await plugin('plain', { displayName: 'Plain', composerIcon: './assets/c.svg', logoDark: 'https://example.test/dark.svg' }, { 'assets/c.svg': COLOR });
  const entries = await discoverPlugins(cache), by = (name: string) => entries.find(entry => entry.name === name)!.icon as { kind: string; dataUrl: string; darkDataUrl?: string; monochrome?: boolean; monochromeLight?: boolean };
  assert.equal(by('github').monochrome, true, 'light-theme mark keeps its flag');
  assert.match(by('github').darkDataUrl ?? '', /^data:image\/svg\+xml;base64,/);
  assert.notEqual(by('github').darkDataUrl, by('github').dataUrl);
  assert.equal(by('onlydark').darkDataUrl, by('onlydark').dataUrl, 'only a dark logo: used for both themes');
  assert.equal(by('onlydark').monochromeLight, true, 'and inverted on the light surface');
  assert.equal(by('plain').darkDataUrl, undefined, 'remote dark logos are never fetched');
});
