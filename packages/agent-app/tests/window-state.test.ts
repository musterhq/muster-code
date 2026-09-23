import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampGeometry, DEFAULT_GEOMETRY, MIN_HEIGHT, MIN_WIDTH, parseGeometry, planDisplayChange } from '../src/main/window-state.ts';

const display = { x: 0, y: 0, width: 1920, height: 1080 };

test('clamp keeps on-screen geometry as-is', () => {
  const g = clampGeometry({ x: 100, y: 50, width: 1280, height: 840, maximized: false }, [display]);
  assert.deepEqual(g, { x: 100, y: 50, width: 1280, height: 840, maximized: false });
});

test('clamp drops off-screen position but keeps size', () => {
  const g = clampGeometry({ x: 5000, y: 5000, width: 1280, height: 840, maximized: false }, [display]);
  assert.equal(g.x, undefined);
  assert.equal(g.y, undefined);
  assert.equal(g.width, 1280);
});

test('clamp enforces minimum size and display bounds', () => {
  const g = clampGeometry({ width: 10, height: 10, maximized: false }, [display]);
  assert.equal(g.width, MIN_WIDTH);
  assert.equal(g.height, MIN_HEIGHT);
  const big = clampGeometry({ width: 99999, height: 99999, maximized: false }, [display]);
  assert.equal(big.width, display.width);
  assert.equal(big.height, display.height);
});

test('clamp with no displays falls back to defaults without throwing', () => {
  const g = clampGeometry({ x: 10, y: 10, width: 0, height: 0, maximized: false }, []);
  assert.equal(g.width, DEFAULT_GEOMETRY.width);
  assert.equal(g.height, DEFAULT_GEOMETRY.height);
  assert.equal(g.x, undefined);
});

test('parseGeometry rejects malformed input', () => {
  assert.equal(parseGeometry('not json'), null);
  assert.equal(parseGeometry('null'), null);
  assert.equal(parseGeometry('{"width":"wide"}'), null);
  assert.deepEqual(parseGeometry('{"width":800,"height":600,"maximized":1}'), {
    x: undefined, y: undefined, width: 800, height: 600, maximized: false,
  });
});

test('display changes re-clamp a live window: keep, resize, or centre after its display is unplugged', () => {
  const external = { x: 1920, y: 0, width: 2560, height: 1440 };
  const onExternal = { x: 2200, y: 100, width: 1600, height: 1000, maximized: false };
  assert.deepEqual(planDisplayChange(onExternal, [display, external]), { kind: 'keep' });
  assert.deepEqual(planDisplayChange(onExternal, [display]), { kind: 'center', width: 1600, height: 1000 }, 'the window was entirely on the removed display');
  assert.deepEqual(planDisplayChange({ x: 100, y: 100, width: 2400, height: 1000, maximized: false }, [display]), { kind: 'resize', width: 1920, height: 1000 }, 'a resolution drop shrinks an oversize window in place');
  assert.deepEqual(planDisplayChange(onExternal, []), { kind: 'keep' }, 'no displays at all is transient; leave the window alone');
  assert.deepEqual(planDisplayChange({ ...onExternal, maximized: true }, [display]), { kind: 'keep' }, 'the OS re-lays maximized windows');
});
