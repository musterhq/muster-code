/**
 * The remote-agent client (Wave 4, G28): what runs on the agent's own machine. `agent join` claims an invite once and keeps the credential in a
 * 0600 file; the other commands call the server's agent API with it. It reads nothing from a server data directory and needs no account.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { flag, jsonMode, out, request, table, UsageError, type Parsed } from './cli.ts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
interface Creds { server: string; credential: string; projectId: string; memberId: string; agent: string }
const homeDir = () => process.env.MUSTER_AGENT_HOME ?? join(homedir(), '.muster-agent');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';

/** https only; plain http for this computer. A credential never travels in clear text over a network. */
function origin(input: string): string {
  let u: URL; try { u = new URL(input); } catch { throw new UsageError('Give the server address, for example https://muster.example.com.'); }
  if (u.username || u.password) throw new UsageError('Leave the user name and password out of the address.');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) throw new UsageError('Use https://. Plain http:// is only for a server on this computer.');
  return u.origin;
}
async function api<T = any>(server: string, path: string, init: { method?: string; credential?: string; body?: unknown } = {}): Promise<T> {
  const r = await request(`${server}${path}`, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', ...(init.credential ? { authorization: `Bearer ${init.credential}` } : {}), host: new URL(server).host }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  let j: any; try { j = JSON.parse(r.body); } catch { throw new Error(`The server answered HTTP ${r.status}, not JSON.`); }
  if (!j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}
function loadCreds(p: Parsed): Creds {
  const file = flag(p, 'creds') ?? process.env.MUSTER_AGENT_CREDENTIALS ?? (() => { const d = homeDir(); const f = existsSync(d) ? readdirSync(d).filter(n => n.endsWith('.json')) : []; if (f.length === 1) return join(d, f[0]!); throw new UsageError(f.length ? `Several agents are saved in ${d}: choose one with --creds FILE.` : 'No agent credentials yet. Run: muster-server agent join <server-url> --invite <token>'); })();
  if (!existsSync(file)) throw new UsageError(`No credentials file ${file}.`);
  return JSON.parse(readFileSync(file, 'utf8')) as Creds;
}

export async function runAgentClient(p: Parsed): Promise<void> {
  const [, sub, ...rest] = p.cmd;
  if (sub === 'join') {
    const server = origin(rest[0] ?? ''), invite = flag(p, 'invite') ?? process.env.MUSTER_AGENT_INVITE;
    if (!invite) throw new UsageError('Usage: agent join <server-url> --invite <token> [--out FILE]');
    const r = await api<any>(server, `/api/agent-invites/${encodeURIComponent(invite)}/claim`, { method: 'POST', body: {} });
    const dir = homeDir(), file = resolve(flag(p, 'out') ?? join(dir, `${slug(r.agent)}.json`));
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    const creds: Creds = { server: r.server ?? server, credential: r.credential, projectId: r.projectId, memberId: r.memberId, agent: r.agent };
    writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 }); try { chmodSync(file, 0o600); } catch { /* no modes */ }
    return out(`Joined as ${r.agent}. The credential is saved in ${file} (readable only by you; it is never printed). It expires ${r.expiresAt ?? 'never'}.`, { ok: true, agent: r.agent, projectId: r.projectId, file });
  }
  const c = loadCreds(p), call = <T = any>(path: string, init?: { method?: string; body?: unknown }) => api<T>(c.server, `/agent/v1/${path}`, { credential: c.credential, ...init });
  if (sub === 'me') { const r = await call('me'); return out(`${r.agent.name} on ${r.agent.project ?? r.agent.projectId} (expires ${r.agent.expiresAt ?? 'never'})`, r); }
  if (!sub || sub === 'tasks') { const r = await call('tasks'); return out(table(r.tasks.map((t: any) => ({ key: t.key, state: t.state, priority: t.priority, title: t.title, id: t.id })), ['key', 'state', 'priority', 'title', 'id']), r); }
  const taskId = async (ref: string | undefined) => { if (!ref) throw new UsageError('Name the task (key like OSS-3, or id).'); const r = await call('tasks'); const t = r.tasks.find((x: any) => x.id === ref || x.key.toLowerCase() === ref.toLowerCase()); if (!t) throw new Error(`No task "${ref}" is assigned to this agent.`); return t.id as string; };
  if (sub === 'task') { const r = await call(`tasks/${await taskId(rest[0])}`); return out([`${r.key} ${r.title} [${r.state}]`, r.acceptance ? `Acceptance:\n${r.acceptance}` : '', r.subtasks.length ? `Subtasks:\n${r.subtasks.map((s: any) => `  ${s.key} [${s.state}] ${s.title}`).join('\n')}` : '', r.comments.length ? `Recent:\n${r.comments.map((x: any) => `  ${x.at.slice(0, 16)} ${x.text}`).join('\n')}` : ''].filter(Boolean).join('\n'), r); }
  if (sub === 'comment') { const body = rest.slice(1).join(' '); if (!body) throw new UsageError('Usage: agent comment <task> <text…>'); await call(`tasks/${await taskId(rest[0])}/comment`, { method: 'POST', body: { body } }); return out('Commented.', { ok: true }); }
  if (sub === 'state') { const state = rest[1]; if (!state) throw new UsageError('Usage: agent state <task> <implemented|blocked|review> [--comment "…"]'); const r = await call(`tasks/${await taskId(rest[0])}/state`, { method: 'POST', body: { state, comment: flag(p, 'comment') } }); return out(`${r.key} is now ${r.state}.`, r); }
  if (sub === 'doc') { const file = flag(p, 'file'); if (!rest[1] || !file) throw new UsageError('Usage: agent doc <task> <key> --file FILE [--note "…"]'); const r = await call(`tasks/${await taskId(rest[0])}/doc`, { method: 'POST', body: { key: rest[1], text: readFileSync(file, 'utf8'), note: flag(p, 'note') } }); return out(`Saved ${rest[1]} (revision ${r.rev}).`, r); }
  if (sub === 'wait') { const r = await call(`wait?timeout=${Number(flag(p, 'timeout') ?? 25)}`); if (!jsonMode()) process.exitCode = r.changed ? 0 : 4; return out(r.changed ? 'Something changed in the project.' : 'Nothing changed.', r); }
  throw new UsageError('Usage: agent join | me | tasks | task | comment | state | doc | wait');
}
