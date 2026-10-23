import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dividerLabel, dividerRows} from '../src/renderer/dayDividers.ts';

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();
const row = (kind: string, createdAt: string, id = Math.random().toString(36)) => ({id, chatId: 'c', kind, text: '', createdAt}) as never;
const activity = (...times: string[]) => ({kind: 'activity', id: 'a' + times[0], items: times.map(createdAt => ({createdAt}))}) as never;

test('the first message and messages after a 30-minute pause or a new day get a divider; follow-ups do not', () => {
  const rows = [
    row('user', at(2026, 10, 18, 0, 52)), row('assistant', at(2026, 10, 18, 0, 53)),
    row('user', at(2026, 10, 18, 1, 5)),                 // 12 min after the reply: same sitting
    activity(at(2026, 10, 18, 1, 6), at(2026, 10, 18, 1, 40)), // long tool run ends 1:40
    row('user', at(2026, 10, 18, 2, 0)),                 // 20 min after the run ended: no divider
    row('assistant', at(2026, 10, 18, 2, 1)),
    row('user', at(2026, 10, 18, 2, 31)),                // exactly 30 min: divider
    row('user', at(2026, 10, 19, 0, 1)),                 // next day
  ];
  assert.deepEqual([...dividerRows(rows).keys()], [0, 6, 7]);
});

test('rows with no or bad timestamps never produce a divider or break the gap', () => {
  const rows = [row('user', 'not a date'), row('user', at(2026, 1, 1, 9, 0)), row('assistant', ''), row('user', at(2026, 1, 1, 9, 10))];
  assert.deepEqual([...dividerRows(rows).keys()], [1]);
});

test('labels: Today, Yesterday, weekday within a week, then the date, with the year only when it differs', () => {
  const now = new Date(2026, 9, 18, 11, 0).getTime();
  const label = (y: number, mo: number, d: number) => dividerLabel(new Date(y, mo - 1, d, 0, 52).getTime(), now, 'en-GB');
  assert.deepEqual(label(2026, 10, 18), {day: 'Today', time: '0:52'});
  assert.equal(label(2026, 10, 17).day, 'Yesterday');
  assert.equal(label(2026, 10, 14).day, 'Wednesday');
  assert.equal(label(2026, 10, 11).day, '11 Oct');
  assert.equal(label(2025, 10, 11).day, '11 Oct 2025');
  assert.equal(dividerLabel(new Date(2026, 9, 18, 14, 5).getTime(), now, 'en-US').time, '2:05 PM');
});

test('cheap enough to run on every streamed update of a long chat', () => {
  const rows = Array.from({length: 2000}, (_, i) => row(i % 2 ? 'assistant' : 'user', new Date(2026, 0, 1, 0, i).toISOString()));
  dividerRows(rows); // first projection parses every timestamp once
  const start = performance.now();
  for (let i = 0; i < 100; i++) dividerRows(rows);
  const perCall = (performance.now() - start) / 100;
  assert.ok(perCall < 0.5, `dividerRows took ${perCall.toFixed(3)} ms for 2000 rows`);
  console.log(`dividerRows: ${perCall.toFixed(3)} ms per call on 2000 rows`);
});
