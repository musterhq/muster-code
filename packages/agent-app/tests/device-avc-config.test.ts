/** The H.264 stall fix (#811): repairing the simulator's fallback SPS so the decoder outputs each frame at once.
 *  Ported from T3 Code's avcConfig.test.ts (MIT, Copyright (c) 2026 T3 Tools Inc., commit
 *  fa4e4677c0ecc437aece2dcea39f76ef31414152; see THIRD-PARTY-NOTICES.md). The byte fixtures are unchanged. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {simulatorAvcConfig} from '../src/renderer/devices/avcConfig.ts';

// Captured from the hub before and after its encoder falls back from low-latency rate control.
const lowLatency = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 22, 39, 100, 0, 51, 172, 19, 20, 60, 4, 192, 20, 158, 106, 154, 129,
  1, 1, 3, 194, 1, 8, 248, 1, 0, 4, 40, 238, 60, 176,
]);
const fallback = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 12, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 164, 1, 0, 4, 40,
  238, 60, 176,
]);
const repaired = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 17, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 168, 6, 208, 68, 35,
  80, 1, 0, 4, 40, 238, 60, 176,
]);
/** Same bytes, compared byte for byte. */
const bytes = (actual: Uint8Array, expected: Uint8Array, label = 'same bytes') => assert.deepEqual([...actual], [...expected], label);
/** Passed through untouched: the very same object, never a copy. */
const same = (actual: Uint8Array, expected: Uint8Array, label = 'passed through untouched') => assert.equal(actual, expected, label);

// Spec: MUS-SPEC-21-811A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-811a)
test('stall fix: the fallback SPS gains zero reordering byte for byte; good, unknown, truncated and oversized records pass through untouched', async t => {
  await t.test('adds zero reordering and one reference frame to the captured fallback SPS', () => {
    bytes(simulatorAvcConfig(fallback), repaired);
    same(simulatorAvcConfig(repaired), repaired, 'idempotent');
  });

  await t.test('preserves existing VUI and leaves the original codec description untouched', () => {
    const original = fallback.slice();
    simulatorAvcConfig(fallback);
    bytes(fallback, original);
    same(simulatorAvcConfig(lowLatency), lowLatency);
  });

  await t.test('repairs multiple SPS entries while preserving PPS and profile extensions', () => {
    const extensions = [0xfd, 0xf8, 0xf8, 0];
    const description = Uint8Array.from([
      ...fallback.subarray(0, 5), 0xe2, ...fallback.subarray(6, 20), ...lowLatency.subarray(6, 30), ...fallback.subarray(20), ...extensions,
    ]);
    bytes(simulatorAvcConfig(description), Uint8Array.from([
      ...description.subarray(0, 6), ...repaired.subarray(6, 25), ...lowLatency.subarray(6, 30), ...fallback.subarray(20), ...extensions,
    ]));
  });

  await t.test('passes through every truncated prefix of the captured configurations', () => {
    for (const config of [fallback, lowLatency]) {
      for (let length = 0; length < config.length; length++) {
        const truncated = config.subarray(0, length);
        same(simulatorAvcConfig(truncated), truncated, `prefix of ${length}`);
      }
    }
  });

  await t.test('does not modify unsupported profiles, scaling lists, or invalid parameter-set lengths', () => {
    const unsupportedProfile = fallback.slice(); unsupportedProfile[9] = 110;
    const scalingLists = fallback.slice(); scalingLists[12] = scalingLists[12]! | 1;
    const invalidSpsLength = fallback.slice(); invalidSpsLength[6] = 0xff;
    const invalidPpsLength = fallback.slice(); invalidPpsLength[21] = 0xff;
    for (const config of [unsupportedProfile, scalingLists, invalidSpsLength, invalidPpsLength]) same(simulatorAvcConfig(config), config);
  });

  await t.test('requires valid SPS trailing bits before appending VUI metadata', () => {
    const invalidPadding = fallback.slice(); invalidPadding[19] = 0;
    same(simulatorAvcConfig(invalidPadding), invalidPadding);
  });

  await t.test('passes through invalid NAL headers and unterminated Exp-Golomb values', () => {
    const forbiddenBit = fallback.slice(); forbiddenBit[8] = forbiddenBit[8]! | 0x80;
    same(simulatorAvcConfig(forbiddenBit), forbiddenBit);
    const unterminated = fallback.slice(); unterminated.fill(0, 12, 20);
    same(simulatorAvcConfig(unterminated), unterminated);
    const overlong = Uint8Array.from([...fallback.subarray(0, 6), 0, 13, 39, 100, 0, 51, 0, 0, 3, 0, 0, 3, 0, 0, 0, ...fallback.subarray(20)]);
    same(simulatorAvcConfig(overlong), overlong);
  });

  await t.test('bounds parsing of oversized configurations and SPS data', () => {
    const oversizedConfig = new Uint8Array(64 * 1024 + 1);
    oversizedConfig.set(fallback);
    same(simulatorAvcConfig(oversizedConfig), oversizedConfig);
    const oversizedSps = new Uint8Array(6 + 2 + 4097 + 7);
    oversizedSps.set(fallback.subarray(0, 6));
    oversizedSps.set([0x10, 1], 6);
    oversizedSps.set(fallback.subarray(8, 20), 8);
    oversizedSps.set(fallback.subarray(20), 8 + 4097);
    same(simulatorAvcConfig(oversizedSps), oversizedSps);
  });
});
