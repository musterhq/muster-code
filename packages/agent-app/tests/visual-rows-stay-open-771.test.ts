/** #771: a page an agent showed in the chat (render_html) stays where it was drawn. Tool activity around it still
 *  folds (into its one-line summary, and behind a finished turn's "Worked for" header), but the page is its own row. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groupActivity, type TranscriptEntry} from '../src/renderer/components/activityGrouping.ts';
import {createTimelineProjection} from '../src/renderer/components/timeline-navigation-model.ts';
import {foldable} from '../src/renderer/components/turnStatusModel.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

const at = '2026-10-31T10:00:00Z';
const plain = (id: string, kind: TimelineItem['kind'], text = id): TimelineItem => ({id, kind, text, chatId: 'chat', createdAt: at});
const command = (id: string): TimelineItem => ({...plain(id, 'tool', 'ls'), status: 'completed', data: {type: 'commandExecution', command: 'ls', exitCode: 0}});
const page = (id: string): TimelineItem => ({...plain(id, 'tool', 'render_html'), status: 'completed', data: {type: 'mcpToolCall', server: 'muster_browser', tool: 'render_html',
  arguments: {title: 'Memory', html: '<p>chart</p>'}, result: 'Shown to the user inline as “Memory” (muster-html:0123456789abcdef0123456789abcdef). It has no network access.'}});
const shape = (rows: readonly TranscriptEntry[]) => rows.map(row => row.kind === 'activity' ? `${'visual' in row && row.visual ? 'visual' : 'activity'}[${row.items.map(item => item.id).join(',')}]` : row.id);
const turn = [plain('u1', 'user'), command('t1'), command('t2'), page('p1'), command('t3'), plain('a1', 'assistant'), plain('u2', 'user'), plain('a2', 'assistant')];

// Spec: MUS-SPEC-21-771I (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-771i)
test('a shown page is its own row between the tool groups before and after it', () => {
  assert.deepEqual(shape(groupActivity(turn)), ['u1', 'activity[t1,t2]', 'visual[p1]', 'activity[t3]', 'a1', 'u2', 'a2']);
  assert.deepEqual(shape(createTimelineProjection()(turn).rows), ['u1', 'activity[t1,t2]', 'visual[p1]', 'activity[t3]', 'a1', 'u2', 'a2'], 'the live chat view groups the same way');
});

// Spec: MUS-SPEC-21-771J (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-771j)
test('a finished turn folds its tool activity but never the page it showed', () => {
  const rows = createTimelineProjection()(turn).rows;
  const folds = Object.fromEntries(rows.map(row => [shape([row])[0], foldable(row)]));
  assert.equal(folds['activity[t1,t2]'], true);
  assert.equal(folds['activity[t3]'], true);
  assert.equal(folds['visual[p1]'], false, 'the page stays visible when the turn folds');
  assert.equal(folds.a1, false);
});

// Spec: MUS-SPEC-21-771K (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-771k)
test('a page that failed or is still drawing folds with its tools like any tool row', () => {
  const failed: TimelineItem = {...page('p2'), status: 'failed', data: {type: 'mcpToolCall', server: 'muster_browser', tool: 'render_html', result: 'Invalid HTML.'}};
  assert.deepEqual(shape(groupActivity([plain('u1', 'user'), command('t1'), failed, command('t2')])), ['u1', 'activity[t1,p2,t2]']);
});
