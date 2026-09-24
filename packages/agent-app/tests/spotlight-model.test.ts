import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Chat, Folder, Project } from '../src/shared/protocol.ts';
import {
  MAX_CHAT_RESULTS,
  chatLocationName,
  defaultChatRows,
  fuzzyMatch,
  moveHighlight,
  quickActionRows,
  settingsRows,
  searchChatRows,
  splitHighlight,
} from '../src/renderer/spotlightModel.ts';

function chat(overrides: Partial<Chat> & Pick<Chat, 'id' | 'title'>): Chat {
  return {
    pinned: false,
    archived: false,
    draft: '',
    status: 'idle',
    updatedAt: '2026-01-01T00:00:00.000Z',
    model: 'test-model',
    mode: 'agent',
    ...overrides,
  };
}

// --- fuzzyMatch --------------------------------------------------------------

test('fuzzyMatch: empty query matches everything with no highlight ranges', () => {
  const result = fuzzyMatch('', 'anything');
  assert.deepEqual(result, { score: 0, ranges: [] });
});

test('fuzzyMatch: requires every query character to appear in order', () => {
  assert.equal(fuzzyMatch('mgr', 'main-dev ossmgr')?.ranges.length, 2); // 'm' then contiguous 'gr'
  assert.equal(fuzzyMatch('zzz', 'main-dev ossmgr'), null);
  assert.equal(fuzzyMatch('rm', 'main-dev ossmgr'), null); // out of order
});

test('fuzzyMatch: ranks a start/word-boundary match above one buried mid-word', () => {
  const atStart = fuzzyMatch('tur', 'Turbo');
  const midWord = fuzzyMatch('urb', 'suburb');
  assert.ok(atStart && midWord);
  assert.ok(atStart!.score > midWord!.score);
});

test('fuzzyMatch: merges contiguous matched characters into a single highlight range', () => {
  const result = fuzzyMatch('main', 'main-dev ossmgr');
  assert.deepEqual(result?.ranges, [[0, 4]]);
});

// --- splitHighlight ------------------------------------------------------------

test('splitHighlight: interleaves plain and highlighted segments from match ranges', () => {
  const parts = splitHighlight('main-dev ossmgr', [[0, 4], [9, 11]]);
  assert.deepEqual(parts, [
    { text: 'main', highlighted: true },
    { text: '-dev ', highlighted: false },
    { text: 'os', highlighted: true },
    { text: 'smgr', highlighted: false },
  ]);
});

test('splitHighlight: no ranges returns the whole string unhighlighted', () => {
  assert.deepEqual(splitHighlight('hello', []), [{ text: 'hello', highlighted: false }]);
});

// --- chatLocationName ----------------------------------------------------------

test('chatLocationName: prefers the project name, then the folder name, then "Personal chat"', () => {
  const folders: Folder[] = [{ id: 'f1', path: '/repo', name: 'repo' }];
  const projects: Project[] = [{ id: 'p1', name: 'Project One', goal: '', folderIds: ['f1'] }];
  assert.equal(chatLocationName({ folderId: 'f1', projectId: 'p1' }, folders, projects), 'Project One');
  assert.equal(chatLocationName({ folderId: 'f1' }, folders, projects), 'repo');
  assert.equal(chatLocationName({}, folders, projects), 'Personal chat');
});

// --- defaultChatRows (empty query) ----------------------------------------------

test('defaultChatRows: takes the given sidebar order, drops archived, caps at the limit', () => {
  const chats = [
    chat({ id: '1', title: 'One' }),
    chat({ id: '2', title: 'Two', archived: true }),
    chat({ id: '3', title: 'Three' }),
    chat({ id: '4', title: 'Four' }),
  ];
  const rows = defaultChatRows(chats, [], [], 2);
  assert.deepEqual(rows.map((r) => r.chat.id), ['1', '3']);
});

test('defaultChatRows: caps at MAX_CHAT_RESULTS by default', () => {
  const chats = Array.from({ length: 12 }, (_, i) => chat({ id: String(i), title: `Chat ${i}` }));
  assert.equal(defaultChatRows(chats, [], []).length, MAX_CHAT_RESULTS);
});

// --- searchChatRows (query present) ---------------------------------------------

test('searchChatRows: matches titles and ranks the closer match first', () => {
  const chats = [
    chat({ id: '1', title: 'ossmgr UI', updatedAt: '2026-01-01T00:00:00.000Z' }),
    chat({ id: '2', title: 'Ossmanager Nuvama and Ragbot', updatedAt: '2026-01-02T00:00:00.000Z' }),
  ];
  const rows = searchChatRows(chats, [], [], 'ossmgr');
  assert.equal(rows[0].chat.id, '1'); // exact contiguous match beats a fuzzier one
});

test('searchChatRows: also matches on the folder/project name, not just the title', () => {
  const folders: Folder[] = [{ id: 'f1', path: '/x/redis-automation', name: 'redis-automation' }];
  const chats = [chat({ id: '1', title: 'main-dev ossmgr', folderId: 'f1' })];
  const rows = searchChatRows(chats, folders, [], 'redis');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chat.id, '1');
});

test('searchChatRows: excludes archived chats and chats that match nothing', () => {
  const chats = [
    chat({ id: '1', title: 'Keep me', archived: true }),
    chat({ id: '2', title: 'No match here' }),
  ];
  assert.deepEqual(searchChatRows(chats, [], [], 'keep'), []);
});

test('searchChatRows: empty query returns no rows (defaultChatRows owns that case)', () => {
  assert.deepEqual(searchChatRows([chat({ id: '1', title: 'Anything' })], [], [], ''), []);
});

// --- quickActionRows -------------------------------------------------------------

test('quickActionRows: empty query keeps every action, in order', () => {
  const rows = quickActionRows('');
  assert.deepEqual(rows.map((r) => r.action.id), ['new-chat', 'open-folder', 'search-files', 'settings', 'providers', 'plugins', 'memory', 'automations', 'terminal', 'stashes', 'import-conversations']);
});

test('quickActionRows: filters by fuzzy match against the label', () => {
  assert.deepEqual(quickActionRows('folder').map((r) => r.action.id), ['open-folder']);
  assert.deepEqual(quickActionRows('zzz'), []);
});

// NAV-11: "settings", "terminal" and "model" (an audited gap) all now find something.
test('quickActionRows: also matches a hidden keyword, not shown or highlighted', () => {
  assert.deepEqual(quickActionRows('settings').map((r) => r.action.id), ['settings']);
  assert.deepEqual(quickActionRows('terminal').map((r) => r.action.id), ['terminal']);
  const modelRows = quickActionRows('model');
  assert.deepEqual(modelRows.map((r) => r.action.id), ['providers'], '"model" finds Accounts & providers via its keywords');
  assert.deepEqual(modelRows[0].labelRanges, [], 'the label itself is not highlighted for a keyword-only match');
});

// --- moveHighlight ----------------------------------------------------------------

test('moveHighlight: clamps at the ends without wrapping', () => {
  assert.equal(moveHighlight(3, 2, 1), 2); // already last, ArrowDown holds
  assert.equal(moveHighlight(3, 0, -1), 0); // already first, ArrowUp holds
  assert.equal(moveHighlight(3, 0, 1), 1);
});

test('moveHighlight: from nothing highlighted, ArrowDown lands on the first row and ArrowUp on the last', () => {
  assert.equal(moveHighlight(3, -1, 1), 0);
  assert.equal(moveHighlight(3, -1, -1), 2);
});

test('moveHighlight: an empty result list has nothing to highlight', () => {
  assert.equal(moveHighlight(0, -1, 1), -1);
  assert.equal(moveHighlight(0, 0, 1), -1);
});

// --- settingsRows (NAV-12 / F12) -----------------------------------------------------

const SECTIONS = [
  { id: 'general', label: 'General', description: 'Sending, spelling and your settings file.', keywords: 'default model send key enter' },
  { id: 'appearance', label: 'Appearance', description: 'Text size and accessibility overrides.', keywords: 'text size zoom reduce motion' },
  { id: 'storage', label: 'Storage', description: 'Disk use by category, with safe cleanup.', keywords: 'disk space cleanup' },
];
test('settingsRows: an empty query lists no Settings pages (the Settings quick action covers that)', () => {
  assert.deepEqual(settingsRows('', SECTIONS), []);
});
test('settingsRows: finds a Settings page by label, highlighting it', () => {
  const rows = settingsRows('appear', SECTIONS);
  assert.deepEqual(rows.map((r) => r.entry.id), ['appearance']);
  assert.ok(rows[0].labelRanges.length > 0);
});
test('settingsRows: finds a Settings page by what is on it (every term), not highlighted', () => {
  assert.deepEqual(settingsRows('send key', SECTIONS).map((r) => r.entry.id), ['general']);
  assert.deepEqual(settingsRows('zoom', SECTIONS).map((r) => r.entry.id), ['appearance']);
  assert.deepEqual(settingsRows('send zoom', SECTIONS), [], 'terms must all land on the same page');
  assert.deepEqual(settingsRows('zoom', SECTIONS)[0].labelRanges, []);
});

// --- NAV-11 global search sections ---------------------------------------------------
import {fileRows, folderRows, mergeContentHits, projectRows} from '../src/renderer/spotlightModel.ts';

test('NAV-11: content hits merge after title matches, never surfacing archived or hidden side chats', () => {
  const a = chat({id: 'a', title: 'Proxy work'}), b = chat({id: 'b', title: 'Other'}), side = chat({id: 'side', title: 'Side'}), gone = chat({id: 'gone', title: 'Old', archived: true});
  const titleRows = searchChatRows([a, b, side], [], [], 'proxy');
  const rows = mergeContentHits(titleRows, [
    {chatId: 'b', snippet: '…the proxy config…', ranges: [[4, 9]]},
    {chatId: 'a', snippet: 'proxy here', ranges: [[0, 5]]},
    {chatId: 'side', snippet: 'proxy in a side chat'},
    {chatId: 'gone', snippet: 'proxy archived'},
    {chatId: 'missing', snippet: 'proxy deleted'},
  ], [a, b, side, gone], [], [], new Set(['side']));
  assert.deepEqual(rows.map(row => row.chat.id), ['a', 'b']);
  assert.equal(rows[0].snippet, 'proxy here', 'a title match also carries its message snippet');
  assert.deepEqual(rows[1].snippetRanges, [[4, 9]]);
});

test('NAV-11: folders, Projects and files as explicit result types', () => {
  const folders = [{id: 'f1', name: 'api-server', path: '/work/api-server'}, {id: 'f2', name: 'web', path: '/work/clients/web'}];
  assert.deepEqual(folderRows('api', folders).map(row => row.item.id), ['f1']);
  assert.deepEqual(folderRows('clients', folders).map(row => [row.item.id, row.labelRanges.length]), [['f2', 0]], 'path matches, name not highlighted');
  assert.deepEqual(folderRows('', folders), []);
  const projects = [{id: 'p1', name: 'Billing revamp', goal: '', folderIds: ['f1']}, {id: 'p2', name: 'Billing old', goal: '', folderIds: [], archived: true}];
  const found = projectRows('billing', projects);
  assert.deepEqual(found.map(row => [row.item.id, row.detail]), [['p1', '1 folder']], 'archived projects excluded');
  const files = fileRows('util', ['src/lib/util.ts', 'README.md'], 1);
  assert.deepEqual(files.map(row => [row.name, row.dir]), [['util.ts', 'src/lib']]);
  assert.deepEqual(files[0].nameRanges, [[0, 4]]);
});
