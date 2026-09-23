import assert from 'node:assert/strict';
import {test} from 'node:test';
import {COMMANDS, commandRows, commandState, paletteEmptyState, parsePaletteQuery, type CommandContext} from '../src/renderer/commandPalette.ts';
import {MENU_ACTIONS} from '../src/shared/menu-protocol.ts';
import {buildMenuTemplate, flattenMenu} from '../src/main/menu.ts';

const idle: CommandContext = {screen: 'work', draftOpen: false, chat: null, canBack: false, canForward: false, slotTitles: [], chatCount: 0};
const withChat = (over: Partial<NonNullable<CommandContext['chat']>> = {}, ctx: Partial<CommandContext> = {}): CommandContext => ({
  ...idle, chatCount: 2, slotTitles: ['Refactor auth', 'Docs'], ...ctx,
  chat: {id: 'c1', title: 'Refactor auth', status: 'completed', archived: false, pinned: false, unread: false, snoozed: false, folderName: 'api-server', ...over},
});

test('NAV-12: "> " switches ⌘K into command mode; anything else is search', () => {
  assert.deepEqual(parsePaletteQuery('> pin'), {mode: 'commands', text: 'pin'});
  assert.deepEqual(parsePaletteQuery('  >'), {mode: 'commands', text: ''});
  assert.deepEqual(parsePaletteQuery('hono >'), {mode: 'search', text: 'hono >'});
});

test('NAV-12: every renderer menu intent (and the main-only Add Folder/Stop) is a palette command, no duplicates', () => {
  const ids = new Set(COMMANDS.map(command => command.id));
  assert.equal(ids.size, COMMANDS.length);
  for (const action of MENU_ACTIONS) if (action !== 'command-palette') assert.ok(ids.has(action as never), `palette lists ${action}`);
  assert.ok(ids.has('open-folder') && ids.has('stop'));
  // Shortcuts shown match the menu accelerators they claim.
  const items = flattenMenu(buildMenuTemplate({isMac: true, isPackaged: true, helpAvailable: false, send() {}, addFolder() {}, stopRun() {}, openHelp() {}, toggleDevTools() {}}));
  const accel = (label: string) => items.find(item => item.label === label)?.accelerator;
  assert.equal(accel('Command Palette…'), 'Shift+CmdOrCtrl+P');
  assert.equal(COMMANDS.find(c => c.id === 'archive-chat')!.shortcut, '⇧⌘A');
  assert.equal(accel('Archive Chat'), 'Shift+CmdOrCtrl+A');
  assert.equal(COMMANDS.find(c => c.id === 'stop')!.shortcut, '⌘.');
  assert.equal(accel('Stop'), 'CmdOrCtrl+.');
});

test('NAV-12: chat commands are disabled with a reason until a chat is open, and name the chat as scope', () => {
  for (const id of ['rename-chat', 'pin-chat', 'archive-chat', 'copy-link', 'find-in-chat', 'open-terminal'] as const) {
    assert.deepEqual(commandState(id, idle), {enabled: false, reason: 'Open a chat first'}, id);
    assert.equal(commandState(id, withChat()).enabled, true, id);
  }
  assert.equal(commandState('rename-chat', withChat()).scope, 'Refactor auth', 'scope visible before execution');
  assert.equal(commandState('open-terminal', withChat()).scope, 'api-server');
  assert.equal(commandState('pin-chat', withChat({pinned: true})).label, 'Unpin chat');
  assert.equal(commandState('archive-chat', withChat({archived: true})).label, 'Unarchive chat');
  assert.equal(commandState('snooze-chat', withChat({snoozed: true})).label, 'Wake chat');
  assert.equal(commandState('snooze-chat', withChat({archived: true})).reason, 'Archived chats cannot be snoozed');
  assert.equal(commandState('rename-chat', withChat({}, {draftOpen: true})).enabled, false, 'a new-chat draft hides the chat behind it');
});

test('NAV-12: context-dependent prerequisites', () => {
  assert.equal(commandState('stop', withChat()).reason, 'This chat is not running');
  assert.equal(commandState('stop', withChat({status: 'running'})).enabled, true);
  assert.equal(commandState('stop', withChat({status: 'stopping'})).reason, 'Already stopping');
  assert.equal(commandState('search-files', withChat({folderName: undefined})).reason, 'This chat has no folder');
  assert.equal(commandState('back', idle).reason, 'No earlier chat in history');
  assert.equal(commandState('back', {...idle, canBack: true}).enabled, true);
  assert.equal(commandState('next-chat', {...idle, chatCount: 1}).enabled, false);
  assert.equal(commandState('mark-unread', withChat({unread: true})).reason, 'Already unread');
  assert.equal(commandState('focus-composer', {...idle, screen: 'settings'}).enabled, false);
  assert.deepEqual(commandState('chat-2', withChat()), {enabled: true, scope: 'Docs'});
  assert.deepEqual(commandState('chat-5', withChat()), {enabled: false, reason: 'No chat in position 5'});
  assert.equal(commandState('new-chat', idle).enabled, true, 'no prerequisite, always runnable');
});

test('NAV-12: rows keep disabled commands listed (after enabled ones), fuzzy by label, keyword or group', () => {
  const all = commandRows('', idle);
  assert.equal(all.length, COMMANDS.length, 'nothing is hidden for being unavailable');
  const firstDisabled = all.findIndex(row => !row.state.enabled);
  assert.ok(firstDisabled > 0 && all.slice(firstDisabled).every(row => !row.state.enabled), 'enabled first');
  const pin = commandRows('unpin', withChat({pinned: true}));
  assert.equal(pin[0].command.id, 'pin-chat');
  assert.equal(pin[0].label, 'Unpin chat');
  assert.ok(pin[0].labelRanges.length > 0, 'the state label is what gets highlighted');
  assert.ok(commandRows('cron', idle).some(row => row.command.id === 'automations'), 'keywords match');
  assert.deepEqual(commandRows('zzqqxx', idle), []);
});

test('NAV-11/12: empty state names the query and suggests what else to try', () => {
  assert.deepEqual(paletteEmptyState('zzzznonexistent'), {title: 'No results for “zzzznonexistent”', message: 'Try a file name, words from a message, or type > for commands.'});
  assert.match(paletteEmptyState('> frobnicate').title, /No commands match “frobnicate”/);
  assert.match(paletteEmptyState('> frobnicate').message, /delete “>”/);
  assert.ok(paletteEmptyState('x'.repeat(200)).title.length < 80, 'long queries are clipped');
});
