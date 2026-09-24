import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TimelineItem} from '../src/shared/protocol.ts';
import {changeTotals, collectFileChanges} from '../src/renderer/turnFileChanges.ts';

/**
 * F23: WorkControls' header SummaryToggle pill used to read `state.gitChanges[folderId]` — the
 * folder's whole working-tree diff, shared by every chat open on that folder — so a brand-new chat
 * that had made no edits of its own still showed another chat's "+453 −0". The fix sums only the
 * fileChange items in *this chat's own* timeline (the same computation `TurnChanges`/`TurnFileChanges`
 * already use per turn), exactly what the summary card's compact bar and folded pill (SummaryCard) now do with `state.timelines[chat.id]`; the header toggle no longer carries stats.
 */
function fileChangeItem(chatId: string, path: string, diff: string): TimelineItem {
  return {id: `${chatId}:${path}`, chatId, kind: 'tool', status: 'completed', createdAt: new Date().toISOString(), text: '', data: {type: 'fileChange', changes: [{path, diff}]}};
}
/** The exact expression SummaryCard uses to turn a chat's timeline into pill stats. */
const pillTotals = (items: readonly TimelineItem[] | undefined) => items?.length ? changeTotals(collectFileChanges(items)) : undefined;

test('two chats sharing a folder get independent pill totals from their own timelines', () => {
  const chatA = [fileChangeItem('a', 'README.md', '@@ -0,0 +1,3 @@\n+one\n+two\n+three')];
  const chatB: TimelineItem[] = []; // a brand-new chat: no turns yet
  const totalsA = pillTotals(chatA), totalsB = pillTotals(chatB);
  assert.deepEqual(totalsA, {files: 1, adds: 3, dels: 0});
  // The new chat shows nothing — never chat A's "+3 −0" just because they share a folder.
  assert.equal(totalsB, undefined);
});

test('a chat with only deletions still reports real totals (pill is not just "any files present")', () => {
  const items = [fileChangeItem('c', 'old.ts', '@@ -1,2 +0,0 @@\n-gone\n-also gone')];
  assert.deepEqual(pillTotals(items), {files: 1, adds: 0, dels: 2});
});

test('a chat whose only edits net to zero (write then fully revert) hides the pill\'s stats', () => {
  const items: TimelineItem[] = [
    fileChangeItem('d', 'x.ts', '@@ -0,0 +1,1 @@\n+line'),
    {id: 'd:x.ts:2', chatId: 'd', kind: 'tool', status: 'completed', createdAt: new Date().toISOString(), text: '', data: {type: 'fileChange', changes: [{path: 'x.ts', diff: '@@ -1,1 +0,0 @@\n-line'}]}},
  ];
  const totals = pillTotals(items)!;
  assert.equal(totals.adds, 0);
  assert.equal(totals.dels, 0);
  // The card's stats gate (adds>0 || dels>0) hides the stats span in this case.
  assert.equal(totals.adds > 0 || totals.dels > 0, false);
});
