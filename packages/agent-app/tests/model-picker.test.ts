import test from 'node:test';
import assert from 'node:assert/strict';
import {ALL_TAB, FAVORITES_TAB, favoriteKey, initialPickerTab, isAutoRoute, matchesModelQuery, pickerBadges, pickerModels, pickerSections} from '../src/shared/model-picker.ts';
import {applyVisibility, EMPTY_MODEL_POLICY} from '../src/shared/model-catalog.ts';

const providers = [
  {id: 'hybrow', name: 'Hybrow OmniRoute', models: [
    {id: 'claude/claude-fable-5', name: 'Claude Fable 5', contextWindow: 1_000_000, images: true},
    {id: 'advisor', name: 'Advisor'}, {id: 'executor', name: 'Executor'}, {id: 'smol', name: 'Smol'},
    {id: 'moonshot/kimi-coding', name: 'Kimi Coding'},
    {id: 'auto', name: 'Auto'},
    {id: 'auto/best-chat', name: 'Auto · best chat'}, {id: 'auto/best-chaos', name: 'Auto · best chaos'}, {id: 'auto/fast', name: 'Auto · fast'},
    ...Array.from({length: 50}, (_, i) => ({id: `vendor/m-${i}`, name: `Vendor ${i}`, hiddenByDefault: true})),
  ]},
  {id: 'openai-direct', name: 'ChatGPT', models: [{id: 'gpt-6', name: 'GPT-6', contextWindow: 400_000, images: true}, {id: 'gpt-6-codex', name: 'GPT-6 Codex'}]},
  {id: 'claude-code', name: 'Claude Code', models: [{id: 'claude-opus-5-5', name: 'Claude Opus 5.5'}]},
];
const all = pickerModels(providers);
const {shown, hidden} = applyVisibility(all, EMPTY_MODEL_POLICY);
const ids = (models: {id: string}[]) => models.map(model => model.id);

test('only auto/… combos fold into Auto routes; a bare "auto" and named agents stay rows', () => {
  assert.equal(isAutoRoute('auto/best-chat'), true);
  assert.equal(isAutoRoute('AUTO/fast'), true);
  for (const id of ['auto', 'advisor', 'intelligent-planner', 'claude/claude-fable-5', 'autopilot', 'auto/']) assert.equal(isAutoRoute(id), false, id);
});

test('the picker opens on the current model\'s provider, else All', () => {
  const rail = ['hybrow', 'openai-direct', 'claude-code'];
  assert.equal(initialPickerTab(rail, {providerId: 'openai-direct', model: 'gpt-6'}), 'openai-direct');
  assert.equal(initialPickerTab(rail, {providerId: 'gone', model: 'x'}), ALL_TAB, 'a provider missing from the rail opens All');
  assert.equal(initialPickerTab(rail, null), ALL_TAB);
});

test('a provider tab lists only that provider, with routes collapsed and hidden-by-default models left out', () => {
  assert.equal(hidden.length, 50);
  const [section, ...rest] = pickerSections(shown, providers, {tab: 'hybrow', query: '', favorites: []});
  assert.equal(rest.length, 0);
  assert.equal(section!.title, 'Hybrow OmniRoute');
  assert.deepEqual(ids(section!.models), ['advisor', 'auto', 'claude/claude-fable-5', 'executor', 'moonshot/kimi-coding', 'smol'], 'named agents and catalog models by name');
  assert.deepEqual(ids(section!.routes), ['auto/best-chaos', 'auto/best-chat', 'auto/fast']);
});

test('All lists every provider in order; favorites lead their provider', () => {
  const favorites = [favoriteKey({providerId: 'openai-direct', id: 'gpt-6-codex'})];
  const sections = pickerSections(shown, providers, {tab: ALL_TAB, query: '', favorites});
  assert.deepEqual(sections.map(section => section.providerId), ['hybrow', 'openai-direct', 'claude-code']);
  assert.deepEqual(ids(sections[1]!.models), ['gpt-6-codex', 'gpt-6']);
  const fav = pickerSections(shown, providers, {tab: FAVORITES_TAB, query: '', favorites});
  assert.deepEqual(fav.map(section => ids(section.models)), [['gpt-6-codex']]);
});

test('the current route and favorited routes are never folded away', () => {
  const favorites = [favoriteKey({providerId: 'hybrow', id: 'auto/fast'})];
  const [section] = pickerSections(shown, providers, {tab: 'hybrow', query: '', favorites, selected: {providerId: 'hybrow', model: 'auto/best-chat'}});
  assert.ok(ids(section!.models).includes('auto/best-chat'));
  assert.equal(section!.models[0]!.id, 'auto/fast', 'favorite first');
  assert.deepEqual(ids(section!.routes), ['auto/best-chaos']);
});

test('search spans every provider regardless of the tab and lists matching routes inline', () => {
  const sections = pickerSections(shown, providers, {tab: 'claude-code', query: 'gpt 6', favorites: []});
  assert.deepEqual(sections.map(section => [section.providerId, ids(section.models)]), [['openai-direct', ['gpt-6', 'gpt-6-codex']]]);
  const routes = pickerSections(shown, providers, {tab: 'openai-direct', query: 'best', favorites: []});
  assert.deepEqual(routes.map(section => [ids(section.models), section.routes.length]), [[['auto/best-chaos', 'auto/best-chat'], 0]]);
  assert.equal(matchesModelQuery({name: 'GPT-6 Codex', id: 'gpt-6-codex', provider: 'ChatGPT'}, 'chatgpt codex'), true, 'provider name matches');
  assert.equal(matchesModelQuery({name: 'Auto · best chat', id: 'auto/best-chat', provider: 'Hybrow'}, 'auto best'), true);
  assert.equal(matchesModelQuery({name: 'GPT-6', id: 'gpt-6', provider: 'ChatGPT'}, 'claude'), false);
});

test('row badges carry only declared capabilities, never "unknown"', () => {
  assert.deepEqual(pickerBadges({contextWindow: 400_000, images: true}).map(badge => badge.label), ['400K', 'Images']);
  assert.deepEqual(pickerBadges({contextWindow: 262_144, images: false}).map(badge => badge.label), ['262K']);
  assert.deepEqual(pickerBadges({}), []);
});
