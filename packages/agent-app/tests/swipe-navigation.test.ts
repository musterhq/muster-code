import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSwipeDetector, SWIPE_DISTANCE} from '../src/renderer/swipeNavigation.ts';

const gesture = (deltas: Array<[number, number]>, opts: {scrollable?: boolean; ctrlKey?: boolean; start?: number} = {}, detector = createSwipeDetector()) =>
  deltas.map(([deltaX, deltaY], i) => detector.wheel({deltaX, deltaY, at: (opts.start ?? 0) + i * 16, scrollable: !!opts.scrollable, ctrlKey: opts.ctrlKey})).filter(Boolean);

test('a two-finger swipe right goes back, left goes forward, once per gesture', () => {
  assert.deepEqual(gesture(Array(20).fill([-20, 1])), ['back']);
  assert.deepEqual(gesture(Array(20).fill([25, -2])), ['forward']);
});

test('short, vertical, diagonal, pinch and scrollable-pane gestures never navigate', () => {
  assert.deepEqual(gesture(Array(5).fill([-20, 0])), [], `below ${SWIPE_DISTANCE}px`);
  assert.deepEqual(gesture(Array(30).fill([-5, -40])), [], 'vertical scrolling');
  assert.deepEqual(gesture(Array(30).fill([-20, -18])), [], 'diagonal');
  assert.deepEqual(gesture(Array(30).fill([-20, 0]), {ctrlKey: true}), [], 'pinch zoom');
  assert.deepEqual(gesture(Array(30).fill([-20, 0]), {scrollable: true}), [], 'a code block or diff that scrolls sideways');
});

test('a gesture that scrolled a pane to its edge does not then navigate', () => {
  const d = createSwipeDetector();
  const steps = [...Array(5).fill(true), ...Array(25).fill(false)].map((scrollable, i) => d.wheel({deltaX: -20, deltaY: 0, at: i * 16, scrollable}));
  assert.deepEqual(steps.filter(Boolean), []);
});

test('momentum after a fired swipe does not fire again; a new gesture after a pause does', () => {
  const d = createSwipeDetector();
  assert.deepEqual(gesture(Array(40).fill([-20, 0]), {}, d), ['back'], 'one action for one long swipe');
  assert.deepEqual(gesture(Array(20).fill([-20, 0]), {start: 40 * 16 + 400}, d), ['back'], 'next swipe after the trackpad settles');
});
