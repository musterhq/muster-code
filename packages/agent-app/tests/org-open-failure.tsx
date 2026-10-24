/** Opening a task or project in another org: when switching org fails, say so and stay put (no silent no-op, no unhandled rejection). */
import assert from 'node:assert/strict';
import {check} from './dom-check.ts';
const unhandled: unknown[] = [];
process.on('unhandledRejection', e => { unhandled.push(e); });
(globalThis as any).window = { muster: {
  subscribe: () => () => {},
  invoke: async (command: string) => { if (command === 'orgs.open') throw new Error('server unreachable'); return undefined; },
} };
(globalThis as any).document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
const hub = await import('../src/renderer/hubStore.ts');
const org = await import('../src/renderer/orgStore.ts');
const store = await import('../src/renderer/store.ts');
// Spec: MUS-SPEC-12-556C (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-556c)
await check('a failed org switch is reported and the page stays where it was', async () => {
  const before = hub.hubRoute();
  const opened = await org.openTaskInOrg('other-org', 't1').then(() => 'resolved', () => 'rejected');
  const openedProject = await org.openProjectInOrg('other-org', 'p1').then(() => 'resolved', () => 'rejected');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(opened, 'resolved', 'the call does not reject');
  assert.equal(openedProject, 'resolved', 'the call does not reject');
  assert.equal(hub.hubRoute(), before, 'the page did not move to a task of an org that could not be opened');
  assert.ok(store.getState().notices.some(n => n.kind === 'error' && /server unreachable/.test(n.message)), 'the failure is shown');
  assert.equal(unhandled.length, 0);
});
console.log('org-open-failure ok');
process.exit(0);
