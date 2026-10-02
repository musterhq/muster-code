/**
 * The work layer from the command line (Wave 4, G39): projects, tasks, roster, approvals, ledger, org packages, remote agents and backups.
 * Each command sends the same runtime command the app sends, through the running server with the caller's token, so a role or a project
 * grant limits the CLI exactly as it limits the web UI. Nothing here has a second code path to the data.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keyPrefixOf } from '../../agent-app/src/shared/domains/project-team-protocol.ts';
import { flag, flagList, out, table, UsageError, type Exec, type Parsed } from './cli.ts';

export const WORK_GROUPS = ['projects', 'tasks', 'roster', 'approvals', 'ledger', 'org', 'agents', 'backups'];
type Row = Record<string, any>;

export async function runWork(p: Parsed, exec: Exec): Promise<void> {
  const [group, sub, ...rest] = p.cmd;
  if (!exec.online && group !== 'agents') throw new Error('Start the server first: this command works on the live projects (muster-server start).');
  const call = <T = any>(command: string, input: Record<string, unknown> = {}) => exec.call(command, input) as Promise<T>;

  // ── lookups ───────────────────────────────────────────────────────────────
  const projects = () => call<Row[]>('project.list');
  const projectRef = async (): Promise<Row> => {
    const list = (await projects()).filter(x => !x.archived), want = flag(p, 'project');
    if (!want) { if (list.length === 1) return list[0]!; throw new UsageError(`Name the project with --project (${list.slice(0, 5).map(x => x.name).join(', ') || 'none yet'}).`); }
    const hit = list.find(x => x.id === want) ?? list.find(x => x.name.toLowerCase() === want.toLowerCase());
    if (!hit) throw new Error(`No project "${want}".`);
    return hit;
  };
  const members = async (projectId: string) => (await call<{ members: Row[] }>('project.members.list', { projectId })).members.filter(m => !m.revokedAt);
  const agentRef = async (projectId: string, name: string | undefined, required = true): Promise<Row | undefined> => {
    if (!name) { if (required) throw new UsageError('Name the agent.'); return undefined; }
    const hit = (await members(projectId)).find(m => m.kind === 'agent' && (m.id === name || m.name.toLowerCase() === name.toLowerCase()));
    if (!hit) throw new Error(`No agent "${name}" in this project.`);
    return hit;
  };
  const keyOf = async (project: Row) => { const s = await call<Row>('project.team.settings', { projectId: project.id }); return (t: Row) => `${s.keyPrefix ?? keyPrefixOf(project.name)}-${t.seq ?? '?'}`; };
  const taskRef = async (project: Row, ref: string | undefined) => {
    if (!ref) throw new UsageError('Name the task (its key like OSS-3, or its id).');
    const key = await keyOf(project), work = await call<Row>('project.work', { projectId: project.id, activityLimit: 40 });
    const t = work.tasks.items.find((x: Row) => x.id === ref || key(x).toLowerCase() === ref.toLowerCase());
    if (!t) throw new Error(`No task "${ref}" in ${project.name}.`);
    return { task: t as Row, key, work };
  };
  const ownerName = (members_: Row[], t: Row) => t.owner.kind === 'user' ? 'you' : members_.find(m => m.id === t.owner.id)?.name ?? 'agent';

  switch (group) {
    case 'projects': {
      if (!sub || sub === 'list') { const list = await projects(); return out(table(list.map(x => ({ id: x.id, name: x.name, goal: String(x.goal ?? '').replace(/\s+/g, ' ').slice(0, 60), archived: x.archived ? 'yes' : '' })), ['id', 'name', 'goal', 'archived']), list); }
      if (sub === 'show') {
        const project = (await projects()).find(x => x.id === rest[0] || x.name.toLowerCase() === (rest[0] ?? '').toLowerCase()); if (!project) throw new Error(`No project "${rest[0] ?? ''}".`);
        const work = await call<Row>('project.work', { projectId: project.id, activityLimit: 5 }), counts: Record<string, number> = {}; for (const t of work.tasks.items) counts[t.state] = (counts[t.state] ?? 0) + 1;
        return out([`${project.name} (${project.id})`, project.goal ? `Goal: ${project.goal}` : '', `Tasks: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`].filter(Boolean).join('\n'), { project, counts });
      }
      throw new UsageError(`Unknown: projects ${sub}`);
    }
    case 'tasks': {
      const project = await projectRef(), key = await keyOf(project), team = await members(project.id);
      if (!sub || sub === 'list') {
        const work = await call<Row>('project.work', { projectId: project.id, activityLimit: 1 }), state = flag(p, 'state'), who = flag(p, 'assignee')?.toLowerCase(), limit = Number(flag(p, 'limit') ?? 100);
        const rows = work.tasks.items.filter((t: Row) => (!state || t.state === state) && (!who || ownerName(team, t).toLowerCase() === who)).slice(0, limit)
          .map((t: Row) => ({ key: key(t), state: t.state, priority: t.priority, assignee: ownerName(team, t), title: t.title }));
        return out(table(rows, ['key', 'state', 'priority', 'assignee', 'title']), rows);
      }
      if (sub === 'show') {
        const { task, work } = await taskRef(project, rest[0]), activity = work.activity.items.filter((a: Row) => a.refId === task.id).slice(0, 8);
        return out([`${key(task)} ${task.title}`, `State ${task.state} · priority ${task.priority} · ${ownerName(team, task)}`, task.acceptance ? `Acceptance:\n${task.acceptance}` : '', activity.length ? `Recent:\n${activity.map((a: Row) => `  ${a.createdAt.slice(0, 16)} ${a.summary.slice(0, 140)}`).join('\n')}` : ''].filter(Boolean).join('\n'), { task, activity });
      }
      if (sub === 'create') {
        const title = flag(p, 'title') ?? rest.join(' '); if (!title.trim()) throw new UsageError('Usage: tasks create --title "…" [--acceptance "…"] [--assignee NAME] [--priority 0-3] [--start]');
        const a = await agentRef(project.id, flag(p, 'assignee'), false), priority = flag(p, 'priority');
        if (priority !== undefined && !/^[0-3]$/.test(priority)) throw new UsageError('--priority is 0 (urgent) to 3 (low).');
        const t = await call<Row>('project.tasks.add', { projectId: project.id, title, acceptance: flag(p, 'acceptance') ?? '', dependencies: [], ...(a ? { owner: { kind: 'agent', id: a.id } } : {}), ...(priority !== undefined ? { priority: Number(priority) } : {}) });
        let started = '';
        if (p.bools.has('start')) { await call('project.tasks.dispatch', { projectId: project.id, id: t.id, revision: t.revision }); started = ' and started'; }
        return out(`Created ${key(t)} “${t.title}”${started}.`, t);
      }
      if (sub === 'state') {
        const { task } = await taskRef(project, rest[0]), state = rest[1]; if (!state) throw new UsageError('Usage: tasks state <task> <backlog|todo|blocked|review|implemented|cancelled> [--reason "…"]');
        const t = await call<Row>('project.tasks.setState', { projectId: project.id, id: task.id, revision: task.revision, state, ...(flag(p, 'reason') ? { reason: flag(p, 'reason') } : {}) });
        return out(`${key(t)} is now ${t.state}.`, t);
      }
      if (sub === 'assign') {
        const { task } = await taskRef(project, rest[0]), a = await agentRef(project.id, rest[1]);
        const t = await call<Row>('project.tasks.edit', { projectId: project.id, id: task.id, revision: task.revision, patch: { owner: { kind: 'agent', id: a!.id } } });
        return out(`${key(t)} now belongs to ${a!.name}.`, t);
      }
      if (sub === 'start') {
        const { task } = await taskRef(project, rest[0]); const r = await call<Row>('project.tasks.dispatch', { projectId: project.id, id: task.id, revision: task.revision });
        return out(`Started ${key(task)} (chat ${r.chatId}).`, r);
      }
      if (sub === 'comment') {
        const { task } = await taskRef(project, rest[0]), body = rest.slice(1).join(' ') || flag(p, 'text'); if (!body) throw new UsageError('Usage: tasks comment <task> <text…>');
        await call('mailbox.send', { to: { kind: 'taskRun', id: task.id }, body, wake: true });
        return out(`Sent your comment to ${key(task)}.`, { ok: true });
      }
      throw new UsageError(`Unknown: tasks ${sub}`);
    }
    case 'roster': {
      const project = await projectRef();
      if (!sub || sub === 'list') {
        const team = await members(project.id), rows = team.filter(m => m.id !== 'agent').map(m => ({ name: m.name, kind: m.kind, title: m.title ?? '', reportsTo: m.reportsTo ? team.find(x => x.id === m.reportsTo)?.name ?? '' : '', runner: m.runner ? `${m.runner.providerId}/${m.runner.model}` : '', state: m.pendingAt ? 'waiting for approval' : m.pausedAt ? 'paused' : 'active' }));
        return out(table(rows, ['name', 'kind', 'title', 'reportsTo', 'runner', 'state']), rows);
      }
      if (sub === 'add') {
        const name = flag(p, 'name') ?? rest.join(' '); if (!name.trim()) throw new UsageError('Usage: roster add --name NAME [--title T] [--reports-to NAME] [--runner provider/model] [--instructions-file FILE]');
        const runner = flag(p, 'runner'), [providerId, ...model] = (runner ?? '').split('/'), boss = await agentRef(project.id, flag(p, 'reports-to'), false), file = flag(p, 'instructions-file');
        if (runner && (!providerId || !model.length)) throw new UsageError('--runner is provider/model, for example codex/gpt-5.');
        if (file && !existsSync(file)) throw new Error(`No file ${file}.`);
        const m = await call<Row>('project.members.add', { projectId: project.id, name, kind: 'agent', role: 'agent', ...(flag(p, 'title') ? { title: flag(p, 'title') } : {}), ...(boss ? { reportsTo: boss.id } : {}), ...(runner ? { runner: { providerId, model: model.join('/') } } : {}), ...(file ? { instructions: readFileSync(file, 'utf8') } : {}) });
        return out(`Added ${m.name}${m.pendingAt ? ' (waiting for approval)' : ''}.`, m);
      }
      if (sub === 'pause' || sub === 'resume') { const a = await agentRef(project.id, rest[0]); await call('project.members.pause', { projectId: project.id, id: a!.id, paused: sub === 'pause' }); return out(`${sub === 'pause' ? 'Paused' : 'Resumed'} ${a!.name}.`, { ok: true }); }
      if (sub === 'remove') { const a = await agentRef(project.id, rest[0]); await call('project.members.revoke', { projectId: project.id, id: a!.id }); return out(`Removed ${a!.name} from the project.`, { ok: true }); }
      throw new UsageError(`Unknown: roster ${sub}`);
    }
    case 'approvals': {
      const project = await projectRef();
      if (!sub || sub === 'list') { const r = await call<{ items: Row[] }>('project.approvals.list', { projectId: project.id, includeDecided: p.bools.has('all') }); return out(table(r.items.map(a => ({ id: a.id.slice(0, 8), kind: a.kind, state: a.state, by: a.requestedBy, title: a.title })), ['id', 'kind', 'state', 'by', 'title']), r.items); }
      const list = (await call<{ items: Row[] }>('project.approvals.list', { projectId: project.id, includeDecided: true })).items, a = list.find(x => x.id === rest[0] || x.id.startsWith(rest[0] ?? '\0'));
      if (!a) throw new Error(`No approval "${rest[0] ?? ''}".`);
      if (sub === 'approve' || sub === 'decline') {
        if (a.kind === 'hire') await call('project.members.decide', { projectId: project.id, id: a.refId, approve: sub === 'approve' });
        else if (a.kind === 'confirmation') await call('project.interactions.answer', { projectId: project.id, id: a.refId, answers: { confirm: sub === 'approve' ? 'Confirm' : 'Decline' } });
        else throw new Error('A secret request needs the value entered by a person: answer it in the app (Project, Secrets).');
        return out(`${sub === 'approve' ? 'Approved' : 'Declined'}: ${a.title}`, { ok: true });
      }
      if (sub === 'comment') { const text = rest.slice(1).join(' '); if (!text) throw new UsageError('Usage: approvals comment <id> <text…>'); await call('project.approvals.comment', { projectId: project.id, id: a.id, text }); return out('Commented.', { ok: true }); }
      if (sub === 'revise') { const note = rest.slice(1).join(' '); if (!note) throw new UsageError('Usage: approvals revise <id> <what to change…>'); await call('project.approvals.requestRevision', { projectId: project.id, id: a.id, note }); return out(`Asked ${a.requestedBy} to change it.`, { ok: true }); }
      throw new UsageError(`Unknown: approvals ${sub}`);
    }
    case 'ledger': {
      const l = await call<{ entries: Row[]; chain: Row }>('paperclip.ledger', { limit: Number(flag(p, 'limit') ?? 30) }), since = flag(p, 'since');
      const rows = l.entries.filter(e => !since || e.endedAt >= since).map(e => ({ ended: String(e.endedAt).slice(0, 16), agent: e.agent, model: e.model ?? '', tokens: e.tokens ? e.tokens.input + e.tokens.output : '', cost: e.costUsd == null ? '' : `$${Number(e.costUsd).toFixed(4)}`, outcome: e.outcome }));
      return out(`${table(rows, ['ended', 'agent', 'model', 'tokens', 'cost', 'outcome'])}\n\nChain ${l.chain.ok ? 'verified' : 'BROKEN'} (${l.chain.entries} entries).`, l);
    }
    case 'org': {
      if (sub === 'teams') { const r = await call<{ teams: Row[] }>('org.teams.list'); return out(table(r.teams.map(t => ({ key: t.key, name: t.name, agents: t.agents.map((a: Row) => a.name).join(', ') })), ['key', 'name', 'agents']), r.teams); }
      if (sub === 'export') {
        const project = await projectRef(), to = flag(p, 'out'); if (!to) throw new UsageError('Usage: org export --project P --out FILE.zip');
        const r = await call<Row>('org.export', { projectId: project.id });
        writeFileSync(resolve(to), Buffer.from(r.zipBase64, 'base64'), { mode: 0o600 });
        return out(`Wrote ${to} (${r.files.length} files, ${r.zipBytes} bytes).${r.warnings.length ? `\n${r.warnings.map((w: string) => `  note: ${w}`).join('\n')}` : ''}`, { ok: true, path: to, files: r.files.map((f: Row) => f.path), warnings: r.warnings });
      }
      if (sub === 'import' || sub === 'preview') {
        const team = flag(p, 'team'), file = rest[0];
        if (!team && !file) throw new UsageError('Usage: org import <package.zip> | --team KEY [--project P | --name NEW] [--collision skip|rename|replace] [--no-tasks] [--dry-run]');
        if (file && !existsSync(file)) throw new Error(`No file ${file}.`);
        const target = flag(p, 'project') ? { projectId: (await projectRef()).id } : { name: flag(p, 'name') };
        const input = { source: team ? { kind: 'catalog', key: team } : { kind: 'zip', base64: readFileSync(file!).toString('base64') }, ...target, collision: flag(p, 'collision') ?? 'skip', activate: p.bools.has('activate'), ...(p.bools.has('no-tasks') ? { includeTasks: false, includeRoutines: false } : {}) };
        const prev = await call<Row>('org.import.preview', input);
        const lines = [`${prev.package.name} (${prev.package.kind}) into ${prev.target.kind === 'new' ? `a new project “${prev.target.name}”` : `“${prev.target.name}”`}`, ...prev.agents.map((a: Row) => `  agent ${a.name}${a.title ? `, ${a.title}` : ''}: ${a.action}`), ...prev.tasks.map((t: Row) => `  ${t.recurring ? 'routine' : 'task'} ${t.name}${t.schedule ? ` (${t.schedule})` : ''}`), ...prev.notes.map((n: string) => `  note: ${n}`)];
        if (sub === 'preview' || p.bools.has('dry-run')) return out(lines.join('\n'), prev);
        const r = await call<Row>('org.import.apply', input);
        return out([...lines, '', `Imported: ${r.created.length} created, ${r.replaced.length} replaced, ${r.skipped.length} skipped, ${r.tasks.length} tasks, ${r.routines.length} routines. ${r.paused} paused: start them with: muster-server org activate --project ${r.projectId}`].join('\n'), r);
      }
      if (sub === 'pending') { const project = await projectRef(), r = await call<Row>('org.imports.pending', { projectId: project.id }); return out(`Paused from imports: ${r.agents.map((a: Row) => a.name).join(', ') || 'no agents'}; ${r.routines.map((a: Row) => a.name).join(', ') || 'no routines'}.`, r); }
      if (sub === 'activate') { const project = await projectRef(), r = await call<Row>('org.activate', { projectId: project.id, ...(flagList(p, 'agent').length ? { agentIds: (await Promise.all(flagList(p, 'agent').map(n => agentRef(project.id, n)))).map(a => a!.id) } : {}) }); return out(`Activated. Still paused: ${r.agents.length} agents, ${r.routines.length} routines.`, r); }
      throw new UsageError('Usage: org teams | export | import | preview | pending | activate');
    }
    case 'agents': {
      if (sub === 'invite') {
        const project = await projectRef(), name = flag(p, 'name'); if (!name) throw new UsageError('Usage: agents invite --project P --name "Remote QA" [--title T] [--expires 24h]');
        const r = await call<Row>('server.agents.invite', { projectId: project.id, name, title: flag(p, 'title'), expires: flag(p, 'expires'), note: flag(p, 'note') });
        return out([`Invite for ${name} on ${project.name} (single use, expires ${r.invite.expiresAt}). On the agent's machine run:`, `  ${r.command}`, '', 'The token is shown once.'].join('\n'), r);
      }
      if (!sub || sub === 'list') {
        const r = await call<Row>('server.agents.list'); const rows = [...r.agents.map((a: Row) => ({ id: a.id.slice(0, 8), agent: a.agentName, project: a.projectName, status: a.status, lastSeen: a.lastUsedAt ?? '', where: a.lastIp ?? '' })), ...r.invites.filter((i: Row) => i.status === 'pending').map((i: Row) => ({ id: i.id.slice(0, 8), agent: i.agentName, project: i.projectName, status: 'invite pending', lastSeen: '', where: `expires ${i.expiresAt.slice(0, 16)}` }))];
        return out(table(rows, ['id', 'agent', 'project', 'status', 'lastSeen', 'where']), r);
      }
      if (sub === 'revoke') {
        if (!rest[0]) throw new UsageError('Usage: agents revoke <id>'); const r = await call<Row>('server.agents.list'), hit = [...r.agents, ...r.invites].find((x: Row) => x.id === rest[0] || x.id.startsWith(rest[0]!));
        if (!hit) throw new Error(`No agent or invite "${rest[0]}".`); await call('server.agents.revoke', { id: hit.id }); return out(`Revoked ${hit.agentName}.`, { ok: true });
      }
      throw new UsageError(`Unknown: agents ${sub}`);
    }
    case 'backups': {
      if (!sub || sub === 'list') { const s = await call<Row>('backups.status'); return out([`Schedule: ${s.settings.enabled ? `every ${s.settings.intervalHours} h, keep ${s.settings.keep}` : 'off'}${s.nextAt ? `, next ${s.nextAt}` : ''}`, table(s.backups.map((b: Row) => ({ id: b.id, at: b.createdAt.slice(0, 16), trigger: b.trigger, size: `${Math.round(b.bytes / 1024)} KB` })), ['id', 'at', 'trigger', 'size']), s.pendingRestore ? `Restore of ${s.pendingRestore.id} waits for the next start.` : ''].filter(Boolean).join('\n'), s); }
      if (sub === 'run') { const b = await call<Row>('backups.run'); return out(`Backed up ${b.files.length} databases (${Math.round(b.bytes / 1024)} KB): ${b.id}`, b); }
      if (sub === 'restore') { if (!rest[0]) throw new UsageError('Usage: backups restore <id>'); await call('backups.restore', { id: rest[0] }); return out('Restore staged. It is applied when the server starts next (stop and start it).', { ok: true }); }
      if (sub === 'settings') { const s = await call<Row>('backups.settings.set', { ...(flag(p, 'enabled') ? { enabled: flag(p, 'enabled') === 'true' } : {}), ...(flag(p, 'every') ? { intervalHours: Number(flag(p, 'every')) } : {}), ...(flag(p, 'keep') ? { keep: Number(flag(p, 'keep')) } : {}) }); return out(`Schedule: ${s.settings.enabled ? `every ${s.settings.intervalHours} h, keep ${s.settings.keep}` : 'off'}.`, s); }
      throw new UsageError(`Unknown: backups ${sub}`);
    }
  }
  throw new UsageError(`Unknown command "${group}".`);
}
