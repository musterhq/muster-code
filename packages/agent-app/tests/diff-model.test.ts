import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {buildDiff, computeDiffModel, expandFolds, foldContext, inlineWordSpans, layerSpans, mergeExpansion, wordSpans, EXPAND_STEP, WORD_PAIR_BUDGET, type DiffRow, type FoldExpansion, type FoldRow} from '../src/renderer/diffModel.ts';

const lines = (count: number, prefix = 'line') => Array.from({length: count}, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';
const folds = (rows: DiffRow[]) => rows.filter((row): row is FoldRow => row.type === 'fold');
const texts = (rows: DiffRow[]) => rows.map(row => row.type === 'fold' ? `[fold ${row.count}]` : row.text);

test('paired replace lines get word spans; whole-line marks and the limited flag past the pair budget', () => {
  const small = buildDiff('const total = 1;\n', 'const total = 2;\n');
  const del = small.rows.find(row => row.type === 'del')!, add = small.rows.find(row => row.type === 'add')!;
  assert.equal(small.wordLimited, false);
  assert.deepEqual('spans' in del && del.spans?.filter(span => span.changed).map(span => span.text), ['1']);
  assert.deepEqual('spans' in add && add.spans?.filter(span => span.changed).map(span => span.text), ['2']);
  const before = lines(WORD_PAIR_BUDGET + 5, 'value'), after = lines(WORD_PAIR_BUDGET + 5, 'value').replaceAll('value', 'other');
  const big = buildDiff(before, after);
  assert.equal(big.wordLimited, true, 'more than 200 paired lines exhausts the word budget');
  const lastAdd = big.rows.filter(row => row.type === 'add').at(-1)!;
  assert.deepEqual('spans' in lastAdd && lastAdd.spans, [{text: `other ${WORD_PAIR_BUDGET + 5}`, changed: true}], 'past the budget the whole line is marked changed');
  assert.equal(wordSpans('a'.repeat(3000), 'b'.repeat(1001)), null, 'oversized pairs skip the word diff');
});

test('folds carry content anchors that survive line shifts, and expand above/below/all', () => {
  const before = lines(60), after = before.replace('line 5\n', 'line five\n').replace('line 55\n', 'line fifty-five\n');
  const folded = foldContext(buildDiff(before, after).rows);
  const [interior, tail] = folds(folded);
  assert.equal(interior.count, 43, '3 context lines are kept on each side of the two hunks');
  assert.equal(tail.count, 2);
  // Ten lines land above everything (a streaming edit); the same interior fold keeps its anchor.
  const shifted = foldContext(buildDiff(lines(10, 'new') + before, lines(10, 'new') + after).rows);
  assert.equal(folds(shifted).length, 3, 'the prepended lines form a new leading fold');
  assert.equal(folds(shifted)[1].anchor, interior.anchor, 'anchors derive from boundary content, not line numbers');
  assert.equal(folds(shifted)[2].anchor, tail.anchor);
  assert.notEqual(interior.anchor, tail.anchor);

  const state = new Map<string, FoldExpansion>([[interior.anchor, {above: EXPAND_STEP, below: 0}]]);
  const above = expandFolds(folded, state);
  const residual = folds(above)[0];
  assert.equal(residual.count, 43 - EXPAND_STEP);
  assert.equal(residual.anchor, interior.anchor, 'a partially revealed fold keeps its anchor for the next press');
  assert.equal(texts(above)[texts(above).indexOf('[fold 23]') - 1], 'line 28', 'the first 20 hidden lines (9..28) are revealed above the residual fold');

  state.set(interior.anchor, mergeExpansion(state.get(interior.anchor), {below: EXPAND_STEP}));
  const both = expandFolds(folded, state);
  assert.equal(folds(both)[0].count, 3);
  assert.equal(texts(both)[texts(both).indexOf('[fold 3]') + 1], 'line 32', 'the last 20 hidden lines (32..51) are revealed below');

  state.set(interior.anchor, mergeExpansion(state.get(interior.anchor), {above: EXPAND_STEP}));
  assert.equal(folds(expandFolds(folded, state)).length, 1, 'over-expanding reveals the whole fold instead of a negative residual');
  assert.deepEqual(folds(expandFolds(folded, new Map([[tail.anchor, {above: 0, below: 0, all: true}]]))).map(fold => fold.count), [43], 'expand all removes only that fold');
  assert.equal(expandFolds(folded, new Map()), folded, 'no expansions returns the same rows');
});

test('layerSpans keeps syntax colour under word overlays and ignores stale tokens', () => {
  const text = 'const total = 12;';
  const tokens = [{content: 'const', color: '#a'}, {content: ' total = ', color: '#b'}, {content: '12', color: '#c'}, {content: ';'}];
  const spans = [{text: 'const total = 1', changed: false}, {text: '2', changed: true}, {text: ';', changed: false}];
  const layered = layerSpans(text, tokens, spans);
  assert.equal(layered.map(segment => segment.text).join(''), text, 'segments concatenate back to the line');
  assert.deepEqual(layered.map(segment => [segment.text, segment.color, segment.changed]), [
    ['const', '#a', false], [' total = ', '#b', false], ['1', '#c', false], ['2', '#c', true], [';', undefined, false],
  ]);
  assert.deepEqual(layerSpans(text, [{content: 'stale', color: '#z'}], spans).map(segment => segment.color), [undefined, undefined, undefined], 'tokens that do not cover the text are dropped');
  assert.deepEqual(layerSpans(text, tokens, undefined).length, 4);
  assert.deepEqual(layerSpans('', tokens, spans), []);
  assert.deepEqual(layerSpans('plain'), [{text: 'plain', changed: false}]);
});

test('inline patch rows pair removal runs with addition runs under the same budget', () => {
  const rows = [
    {kind: 'hunk', text: '@@'}, {kind: 'context', text: 'a'},
    {kind: 'del', text: 'x = 1'}, {kind: 'del', text: 'y = 1'}, {kind: 'add', text: 'x = 2'}, {kind: 'add', text: 'y = 2'}, {kind: 'add', text: 'z = 3'},
  ];
  const {spans, limited} = inlineWordSpans(rows);
  assert.equal(limited, false);
  assert.deepEqual(spans[2]?.filter(span => span.changed).map(span => span.text), ['1']);
  assert.deepEqual(spans[5]?.filter(span => span.changed).map(span => span.text), ['2']);
  assert.equal(spans[6], undefined, 'an unpaired addition has no overlay');
  assert.equal(spans[0], undefined);
  const many = Array.from({length: WORD_PAIR_BUDGET + 1}, (_, i) => ({kind: 'del', text: `v ${i}`})).concat(Array.from({length: WORD_PAIR_BUDGET + 1}, (_, i) => ({kind: 'add', text: `w ${i}`})));
  assert.equal(inlineWordSpans(many).limited, true);
});

test('computeDiffModel applies the line budget and reports it', () => {
  const model = computeDiffModel(lines(10_050), lines(10_050).replace('line 2\n', 'line two\n'));
  assert.equal(model.limited, true);
  assert.deepEqual(model.stats, {adds: 1, dels: 1});
  assert.equal(model.all.length, 10_001);
  assert.equal(model.wordLimited, false);
});

test('the shared diff worker client cancels superseded requests, releases after 60s idle and flags load failures', async () => {
  const posted: unknown[] = [];
  let terminated = 0;
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: {data: unknown}) => void) | null = null;
    onerror: ((event: {preventDefault?: () => void}) => void) | null = null;
    constructor() { FakeWorker.instances.push(this); }
    postMessage(message: unknown) { posted.push(message); }
    terminate() { terminated++; }
  }
  Object.assign(globalThis, {Worker: FakeWorker, document: {baseURI: 'file:///app/'}});
  mock.timers.enable({apis: ['setTimeout']});
  try {
    const {requestDiff, releaseDiffWorker, diffWorkerActive, diffWorkerCount, pendingDiffRequests, setDiffWorkerPoolLimit, DiffWorkerError, DIFF_WORKER_IDLE_MS} = await import('../src/renderer/diffWorkerClient.ts');
    setDiffWorkerPoolLimit(1);
    const first = requestDiff({before: 'a\n', after: 'b\n'});
    const second = requestDiff({before: 'a\n', after: 'c\n'});
    assert.equal(FakeWorker.instances.length, 1, 'one worker serves every request');
    first.cancel();
    assert.deepEqual(posted.at(-1), {id: 1, cancel: true}, 'a superseded request is cancelled in the worker');
    assert.equal(pendingDiffRequests(), 1);
    first.promise.then(() => assert.fail('cancelled requests never resolve'), () => assert.fail('cancelled requests never reject'));
    const worker = FakeWorker.instances[0];
    worker.onmessage!({data: {id: 2, all: [], folded: [], stats: {adds: 0, dels: 0}, limited: false, wordLimited: false, revision: null}});
    const model = await second.promise;
    assert.deepEqual(model.stats, {adds: 0, dels: 0});
    assert.equal(diffWorkerActive(), true);
    mock.timers.tick(DIFF_WORKER_IDLE_MS - 1);
    assert.equal(diffWorkerActive(), true, 'the worker stays warm while under the idle window');
    mock.timers.tick(1);
    assert.equal(diffWorkerActive(), false, 'idle release terminates the shared worker');
    assert.equal(terminated, 1);

    const third = requestDiff({before: 'x', after: 'y'});
    assert.equal(FakeWorker.instances.length, 2, 'the next request recreates the worker lazily');
    FakeWorker.instances[1].onerror!({preventDefault() {}});
    await assert.rejects(third.promise, (error: unknown) => error instanceof DiffWorkerError);
    assert.equal(diffWorkerActive(), false);

    const fourth = requestDiff({before: 'x', after: 'y'});
    FakeWorker.instances[2].onmessage!({data: {id: 4, error: 'too complex'}});
    await assert.rejects(fourth.promise, (error: unknown) => error instanceof Error && !(error instanceof DiffWorkerError) && error.message === 'too complex');
    releaseDiffWorker();

    // Capped pool: a second worker only while the first is busy, never more than the cap, each idles out.
    setDiffWorkerPoolLimit(2);
    const base = FakeWorker.instances.length;
    const a = requestDiff({before: '1', after: '2'});
    assert.equal(FakeWorker.instances.length, base + 1, 'one diff uses one worker');
    const b = requestDiff({before: '1', after: '3'});
    assert.equal(FakeWorker.instances.length, base + 2, 'a concurrent diff gets a second worker');
    const c = requestDiff({before: '1', after: '4'});
    assert.equal(diffWorkerCount(), 2, 'the pool never exceeds its cap');
    const [wa, wb] = [FakeWorker.instances[base]!, FakeWorker.instances[base + 1]!];
    const ok = (id: number) => ({data: {id, all: [], folded: [], stats: {adds: 0, dels: 0}, limited: false, wordLimited: false, revision: null}});
    wa.onmessage!(ok(5)); wb.onmessage!(ok(6));
    await Promise.all([a.promise, b.promise]);
    wa.onmessage!(ok(7)); // both busy → the third request queued on the least-loaded (first) worker
    await c.promise;
    mock.timers.tick(DIFF_WORKER_IDLE_MS);
    assert.equal(diffWorkerCount(), 0, 'every pooled worker is released after 60s idle');
  } finally { mock.timers.reset(); }
});
