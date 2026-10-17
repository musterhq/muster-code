/** hubStore / orgStore: a read that started before an org switch must not overwrite the newer read. */
import assert from 'node:assert/strict';
const calls: { command: string; resolve: (v: any) => void; reject: (e: any) => void }[] = [];
(globalThis as any).window = { muster: {
  subscribe: () => () => {},
  invoke: (command: string) => new Promise((resolve, reject) => { calls.push({ command, resolve, reject }); }),
} };
(globalThis as any).document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
const hub = await import('../src/renderer/hubStore.ts');
const org = await import('../src/renderer/orgStore.ts');
const snap = (id: string) => ({ paperclip: { company: { id } } }) as any;
const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(cond(), 'condition'); };
const of = (cmd: string) => calls.filter(c => c.command === cmd);

// workspace snapshot
const first = hub.refreshWorkspace();
await until(() => of('paperclip.snapshot').length === 1);
const second = hub.refreshWorkspace(true);
await until(() => of('paperclip.snapshot').length === 2);
of('paperclip.snapshot')[1].resolve(snap('new-org'));
await second;
of('paperclip.snapshot')[0].resolve(snap('old-org'));
await first;
assert.equal(hub.workspaceSnapshot()?.paperclip?.company?.id, 'new-org', 'older snapshot read must not overwrite the newer one');

// my work
calls.length = 0;
const w1 = org.loadMyWork();
await until(() => of('orgs.work').length === 1);
const w2 = org.loadMyWork(true);
await until(() => of('orgs.work').length === 2);
of('orgs.work')[1].resolve({ connected: true, me: null, fetchedAt: 'b', orgs: [{ org: { id: 'new' } }] });
await w2;
of('orgs.work')[0].resolve({ connected: true, me: null, fetchedAt: 'a', orgs: [{ org: { id: 'old' } }] });
await w1;
const { useMyWork } = org; void useMyWork;
console.log('hub-store-race ok');
process.exit(0);
