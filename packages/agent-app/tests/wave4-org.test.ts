/** Wave 4: G16 export/import package and G17 teams catalog. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { dumpYaml, parseDoc, parseYaml, readPackage, unzipFiles, zipFiles } from '../src/runtime/org/agent-companies.ts';
import { wave1 } from './wave1-harness.ts';

test('G16: the YAML subset and the zip round-trip, and a hostile zip is refused', () => {
  const data = { name: 'A: b', list: ['x', 'y z'], nested: { n: 3, ok: true, none: null, deep: { s: '#hash' } }, rules: [{ match: 'command', pattern: 'git *' }] };
  assert.deepEqual(parseYaml(dumpYaml(data)), data);
  assert.deepEqual(parseYaml('a:\n  - 1\n  - two\nb: [x, "y,z"]\n'), { a: [1, 'two'], b: ['x', 'y,z'] });
  const d = parseDoc('---\nname: Ada\nreportsTo: null\nskills:\n  - review\n---\n\nHello\n'); assert.equal(d.data.name, 'Ada'); assert.equal(d.data.reportsTo, null); assert.equal(d.body, 'Hello');
  const files = { 'COMPANY.md': 'x'.repeat(5000), 'agents/a/AGENTS.md': 'hi', 'sub/é.md': 'ünï' };
  assert.deepEqual(unzipFiles(zipFiles(files)), files);
  assert.throws(() => unzipFiles(zipFiles({ '../evil.md': 'x' })), /unsafe path/);
  assert.throws(() => unzipFiles(Buffer.from('nope')), /not a zip/);
  assert.throws(() => readPackage({ 'README.md': 'x' }), /no COMPANY.md or TEAM.md/);
  assert.throws(() => readPackage({ 'COMPANY.md': '---\nname: X\nschema: other/v9\n---\n' }), /agentcompanies\/v1/);
});

/** A hand-built zip: `entries` central records, each declaring `declared` bytes, all reading the local blob at `lhFor(i)`. */
function craftedZip(blob: Buffer, entries: { name: string; method: number; usize: number; csize?: number; lh: number }[], localHeaders: number) {
  const locals: Buffer[] = []; let off = 0; const offsets: number[] = [];
  for (let k = 0; k < localHeaders; k++) { const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(entries[0]!.method, 8); h.writeUInt16LE(5, 26); const nm = Buffer.from(`k${k}.md`); offsets.push(off); locals.push(h, nm, blob); off += 30 + nm.length + blob.length; }
  const central = entries.map(e => { const nm = Buffer.from(e.name), c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(e.method, 10); c.writeUInt32LE(e.csize ?? blob.length, 20); c.writeUInt32LE(e.usize, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(offsets[e.lh]!, 42); return Buffer.concat([c, nm]); });
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('review: a zip bomb is refused by the bytes really inflated, not the sizes declared', () => {
  const blob = deflateRawSync(Buffer.alloc(1_900_000, 0x61));
  // 400 entries, usize=0, all pointing at one 2 MB deflated blob (800 MB if trusted).
  const overlapping = craftedZip(blob, Array.from({ length: 400 }, (_, i) => ({ name: `a${i}.md`, method: 8, usize: 0, lh: 0 })), 1);
  assert.ok(overlapping.length < 30_000);
  assert.throws(() => unzipFiles(overlapping), /shares data|declares|too large/);
  // A single entry that lies about its size.
  assert.throws(() => unzipFiles(craftedZip(blob, [{ name: 'a.md', method: 8, usize: 10, lh: 0 }], 1)), /declares|too large/);
  // Many honest-looking separate blobs, 400 x 1.9 MB, would pass the declared limit but not the real total.
  const many = craftedZip(blob, Array.from({ length: 12 }, (_, i) => ({ name: `m${i}.md`, method: 8, usize: 1_900_000, lh: i })), 12);
  assert.throws(() => unzipFiles(many), /too large/);
  // Stored entries must have csize === usize.
  assert.throws(() => unzipFiles(craftedZip(Buffer.from('hello'), [{ name: 's.md', method: 0, usize: 3, lh: 0 }], 1)), /declares/);
  assert.deepEqual(unzipFiles(craftedZip(Buffer.from('hello'), [{ name: 's.md', method: 0, usize: 5, lh: 0 }], 1)), { 's.md': 'hello' });
});

test('review: a package cannot pollute prototypes through __proto__, constructor or prototype keys', () => {
  const parsed = parseYaml('a: 1\n__proto__:\n  polluted: yes\nconstructor:\n  prototype:\n    polluted2: yes\nnested:\n  __proto__:\n    polluted3: yes\n  ok: 2\n') as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>).polluted, undefined); assert.equal(({} as Record<string, unknown>).polluted2, undefined); assert.equal(({} as Record<string, unknown>).polluted3, undefined);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype, 'the parsed map keeps its own prototype');
  assert.equal((parsed as { polluted?: unknown }).polluted, undefined);
  assert.deepEqual(Object.keys(parsed).sort(), ['a', 'nested']); assert.deepEqual(parsed.nested, { ok: 2 });
});

test('review: an import is least privilege by default, a replaced agent is stopped and listed for Activate, and a new agent is paused', async t => {
  const { h, cto } = await seeded(t);
  const out = await h.s.invoke('org.export', { projectId: h.project.id }), pkg = { kind: 'zip' as const, base64: out.zipBase64 };
  const gov = (projectId: string, memberId: string) => h.s.invoke('project.agent.gov.get', { projectId, memberId });
  // Default: the package asks for canHire, a project scope and a deny rule; none of it is applied.
  const plain = await h.s.invoke('org.import.apply', { source: pkg, name: 'Plain' });
  const plainCto = (await h.s.invoke('project.members.list', { projectId: plain.projectId })).members.find(m => m.name === 'CTO')!;
  const g = (await gov(plain.projectId, plainCto.id)).governance;
  assert.equal(g.capabilities.canHire, false); assert.equal(g.capabilities.canAssign, false); assert.equal(g.capabilities.assignScope, 'subtree'); assert.equal(g.toolRules.length, 0);
  // Replace: the running agent is paused, and shows in the Activate list.
  assert.equal((await h.s.invoke('project.members.list', { projectId: h.project.id })).members.find(m => m.id === cto.id)!.pausedAt ?? null, null);
  const rep = await h.s.invoke('org.import.apply', { source: pkg, projectId: h.project.id, collision: 'replace', agents: ['cto'], includeRoutines: false, includeTasks: false });
  assert.equal(rep.replaced.length, 1);
  assert.ok((await h.s.invoke('project.members.list', { projectId: h.project.id })).members.find(m => m.id === cto.id)!.pausedAt, 'the replaced agent is paused');
  assert.ok((await h.s.invoke('org.imports.pending', { projectId: h.project.id })).agents.some(a => a.id === cto.id), 'and listed for Activate');
  assert.equal((await gov(h.project.id, cto.id)).governance.capabilities.canHire, true, 'a replaced agent keeps the permissions it had');
  await h.s.invoke('org.activate', { projectId: h.project.id });
  assert.equal((await h.s.invoke('project.members.list', { projectId: h.project.id })).members.find(m => m.id === cto.id)!.pausedAt ?? null, null);
  // Confirmed: the package's own permissions apply.
  const asked = await h.s.invoke('org.import.apply', { source: pkg, name: 'Asked', permissions: 'imported' });
  const askedCto = (await h.s.invoke('project.members.list', { projectId: asked.projectId })).members.find(m => m.name === 'CTO')!;
  assert.equal((await gov(asked.projectId, askedCto.id)).governance.capabilities.canHire, true);
  await assert.rejects(h.s.invoke('org.import.apply', { source: pkg, name: 'Bad', permissions: 'root' as never }), /least or imported/);
});

async function seeded(t: import('node:test').TestContext) {
  const h = await wave1(t);
  const cto = await h.member('CTO', { instructions: 'You are the CTO.\nKeep changes small.' }), qa = await h.member('QA', { reportsTo: cto.id, instructions: 'Verify every fix.' });
  await h.s.invoke('project.agent.gov.set', { projectId: h.project.id, memberId: cto.id, capabilities: { canHire: true, canAssign: true, assignScope: 'project' }, toolRules: [{ match: 'command', pattern: 'rm *', effect: 'deny' }], gitIdentity: { name: 'CTO Bot', email: 'cto-secret@example.com' } });
  await h.s.invoke('project.agent.files.save', { projectId: h.project.id, memberId: cto.id, name: 'SOUL.md', text: 'Calm and exact.' });
  await h.addTask('Write the plan', { kind: 'agent', id: cto.id }, { acceptance: 'A one page plan' });
  const done = await h.addTask('Already done', { kind: 'agent', id: qa.id }); await h.start(done.id); await h.settled(done.id);
  await h.s.invoke('automations.create', { name: 'Monday review', prompt: 'Review open work.', timezone: 'UTC', schedule: { kind: 'daily', time: '09:00', days: [1] }, permissionMode: 'workspace', overlap: 'skip', catchUp: 'none',
    target: { kind: 'task', projectId: h.project.id, assigneeId: `member:${cto.id}`, start: true, mode: 'task' } });
  return { h, cto, qa };
}

test('G16: export writes a package with agents, open tasks, routines and no secrets; import into a new project pauses everything and Activate starts it', async t => {
  const { h, cto, qa } = await seeded(t);
  await h.s.invoke('project.secrets.save', { projectId: h.project.id, name: 'NPM_TOKEN', value: 'super-secret-value-123' }).catch(() => undefined);
  const out = await h.s.invoke('org.export', { projectId: h.project.id });
  const paths = out.files.map(f => f.path);
  for (const p of ['COMPANY.md', '.muster.yaml', 'README.md', 'agents/cto/AGENTS.md', 'agents/cto/SOUL.md', 'agents/qa/AGENTS.md', 'tasks/write-the-plan/TASK.md', 'tasks/monday-review/TASK.md']) assert.ok(paths.includes(p), `${p} in ${paths.join(', ')}`);
  assert.ok(!paths.some(p => /already-done/.test(p)), 'finished tasks are not exported');
  const files = unzipFiles(Buffer.from(out.zipBase64, 'base64')), all = Object.values(files).join('\n');
  assert.ok(!/cto-secret@example.com|super-secret-value|CTO Bot/.test(all), 'no identity or secret leaves');
  assert.match(files['agents/qa/AGENTS.md']!, /reportsTo: cto/);
  assert.match(files['.muster.yaml']!, /canHire: true/); assert.match(files['.muster.yaml']!, /pattern: "?rm \*/);
  // Preview into a new project, then apply.
  const preview = await h.s.invoke('org.import.preview', { source: { kind: 'zip', base64: out.zipBase64 }, name: 'Copy' });
  assert.equal(preview.target.kind, 'new'); assert.deepEqual(preview.agents.map(a => a.slug).sort(), ['cto', 'qa']); assert.ok(preview.agents.every(a => a.action === 'create'));
  assert.ok(preview.tasks.some(x => x.recurring && /Mondays|Mon/.test(x.schedule!))); assert.ok(preview.notes.some(n => /start paused/.test(n)));
  assert.equal(preview.privileged, true); assert.equal(preview.agents.find(a => a.slug === 'cto')!.permissions!.canHire, true); assert.equal(preview.agents.find(a => a.slug === 'cto')!.permissions!.toolRules, 1);
  assert.ok(preview.notes.some(n => /more than the default permissions/.test(n)));
  const res = await h.s.invoke('org.import.apply', { source: { kind: 'zip', base64: out.zipBase64 }, name: 'Copy', permissions: 'imported' });
  assert.equal(res.created.length, 2); assert.equal(res.routines.length, 1); assert.equal(res.tasks.length, 1);
  const team = (await h.s.invoke('project.members.list', { projectId: res.projectId })).members.filter(m => m.kind === 'agent' && m.id !== 'agent');
  assert.ok(team.every(m => m.pausedAt), 'imported agents are paused');
  const newCto = team.find(m => m.name === 'CTO')!, newQa = team.find(m => m.name === 'QA')!;
  assert.equal(newQa.reportsTo, newCto.id); assert.match(newCto.instructions!, /Keep changes small/);
  const gov = await h.s.invoke('project.agent.gov.get', { projectId: res.projectId, memberId: newCto.id });
  assert.equal(gov.governance.capabilities.canHire, true); assert.equal(gov.governance.capabilities.assignScope, 'project'); assert.equal(gov.governance.toolRules[0]!.pattern, 'rm *'); assert.equal(gov.governance.gitIdentity, null);
  assert.ok(gov.files.some(f => f.name === 'SOUL.md'));
  const task = (await h.s.invoke('project.work', { projectId: res.projectId, activityLimit: 5 })).tasks.items.find(x => x.title === 'Write the plan')!;
  assert.equal(task.state, 'backlog'); assert.equal(task.owner.id, newCto.id);
  const autos = (await h.s.invoke('automations.list', undefined)).filter(a => a.target.kind === 'task' && a.target.projectId === res.projectId);
  assert.equal(autos.length, 1); assert.equal(autos[0]!.paused, true);
  const pending = await h.s.invoke('org.imports.pending', { projectId: res.projectId }); assert.equal(pending.agents.length, 2); assert.equal(pending.routines.length, 1);
  const after = await h.s.invoke('org.activate', { projectId: res.projectId, agentIds: [newCto.id] });
  assert.equal(after.agents.length, 1); assert.equal(after.routines.length, 1);
  const rest = await h.s.invoke('org.activate', { projectId: res.projectId }); assert.equal(rest.agents.length + rest.routines.length, 0);
  assert.equal((await h.s.invoke('automations.list', undefined)).find(a => a.id === autos[0]!.id)!.paused, false);
  void cto; void qa;
});

test('G16: collisions are skipped, renamed or replaced; an unknown runner falls back with a note', async t => {
  const { h, cto } = await seeded(t);
  const out = await h.s.invoke('org.export', { projectId: h.project.id });
  const pkg = { kind: 'zip' as const, base64: out.zipBase64 };
  const preview = await h.s.invoke('org.import.preview', { source: pkg, projectId: h.project.id });
  assert.ok(preview.agents.every(a => a.action === 'collision')); assert.ok(preview.notes.some(n => /same name/.test(n)));
  const skip = await h.s.invoke('org.import.apply', { source: pkg, projectId: h.project.id, includeRoutines: false, includeTasks: false }); assert.equal(skip.created.length, 0); assert.equal(skip.skipped.length, 2);
  const ren = await h.s.invoke('org.import.apply', { source: pkg, projectId: h.project.id, collision: 'rename', includeRoutines: false, includeTasks: false });
  assert.deepEqual(ren.created.map(c => c.name).sort(), ['CTO (2)', 'QA (2)']);
  await h.s.invoke('project.members.update', { projectId: h.project.id, id: cto.id, instructions: 'changed locally' });
  const rep = await h.s.invoke('org.import.apply', { source: pkg, projectId: h.project.id, collision: 'replace', agents: ['cto'], includeRoutines: false, includeTasks: false });
  assert.equal(rep.replaced.length, 1); assert.match((await h.s.invoke('project.members.list', { projectId: h.project.id })).members.find(m => m.id === cto.id)!.instructions!, /Keep changes small/);
  const files = unzipFiles(Buffer.from(out.zipBase64, 'base64')); files['.muster.yaml'] = files['.muster.yaml']!.replace('scripted-model', 'gpt-nonexistent');
  const odd = await h.s.invoke('org.import.preview', { source: { kind: 'zip', base64: zipFiles(files).toString('base64') }, name: 'Odd' });
  assert.ok(odd.agents.some(a => a.runner === null && /default runner/.test(a.runnerNote ?? '')));
});

test('G16: a folder export round-trips; folders outside the rules are refused', async t => {
  const { h } = await seeded(t);
  const dir = mkdtempSync(join(tmpdir(), 'muster-w4-org-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const w = await h.s.invoke('org.export.write', { projectId: h.project.id, dir }); assert.ok(existsSync(join(w.path, 'COMPANY.md'))); assert.match(readFileSync(join(w.path, 'agents/cto/AGENTS.md'), 'utf8'), /Keep changes small/);
  await assert.rejects(h.s.invoke('org.export.write', { projectId: h.project.id, dir }), /already exists/);
  await assert.rejects(h.s.invoke('org.export.write', { projectId: h.project.id, dir: 'relative' }), /absolute/);
  const res = await h.s.invoke('org.import.apply', { source: { kind: 'folder', path: w.path }, name: 'From folder' }); assert.equal(res.created.length, 2);
  await assert.rejects(h.s.invoke('org.import.preview', { source: { kind: 'folder', path: '/nonexistent-dir' } }), /existing folder/);
});

test('G17: the catalog lists the four Paperclip teams; installing one adds its agents under a manager and its routine paused', async t => {
  const h = await wave1(t);
  const { teams } = await h.s.invoke('org.teams.list', {});
  assert.deepEqual(teams.map(x => x.slug).sort(), ['content-machine', 'core-exec-team', 'product-design', 'product-engineering']);
  const core = teams.find(x => x.slug === 'core-exec-team')!; assert.deepEqual(core.agents.map(a => a.slug).sort(), ['ceo', 'cto', 'qa']); assert.equal(core.routines, 1);
  assert.ok(!JSON.stringify(teams).includes('Paperclip'), 'adapted to Muster wording');
  const lead = await h.member('Lead');
  const res = await h.s.invoke('org.import.apply', { source: { kind: 'catalog', key: core.key }, projectId: h.project.id, attachTo: lead.id, activate: true });
  assert.equal(res.created.length, 3); assert.equal(res.routines.length, 1);
  const list = (await h.s.invoke('project.members.list', { projectId: h.project.id })).members; const ceo = list.find(m => m.name === 'CEO')!, cto = list.find(m => m.name === 'CTO')!;
  assert.equal(ceo.reportsTo, lead.id); assert.equal(cto.reportsTo, ceo.id); assert.ok(!ceo.pausedAt, 'a bundled team starts running');
  const caps = (await h.s.invoke('project.agent.gov.get', { projectId: h.project.id, memberId: cto.id })).governance.capabilities; assert.equal(typeof caps.canHire, 'boolean');
  assert.equal((await h.s.invoke('automations.list', undefined)).filter(a => a.paused).length, 1);
  await assert.rejects(h.s.invoke('org.import.preview', { source: { kind: 'catalog', key: 'bundled/x/y' } }), /not in the catalog/);
});
