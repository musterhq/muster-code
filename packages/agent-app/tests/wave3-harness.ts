/** Wave 3 harness: the Wave 2 one (real service, real SQLite and git, scripted provider) plus the insight domain's fake clock. */
import type { TestContext } from 'node:test';
import { insightClock } from '../src/runtime/domains/insight.ts';
import { wave2, FakeClock, until, wait, type Wave2 } from './wave2-harness.ts';

export { FakeClock, until, wait };
export async function wave3(t: TestContext, opts: { fakeClock?: boolean } = {}): Promise<Wave2> {
  const h = await wave2(t, opts);
  if (h.clock) { insightClock.now = h.clock.now; insightClock.timers = { set: h.clock.set, clear: h.clock.clear }; }
  t.after(() => { insightClock.now = undefined; insightClock.timers = undefined; });
  return h;
}
