/**
 * The envs domain (Wave 4: G21 SSH hosts, G22 runtime services and previews). Contract: shared/domains/envs-protocol.ts.
 * Hosts, chat bindings and service declarations live in one 0600 file. Nothing runs until you press something: no probes, no timers.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatSsh, PreviewItem, ServiceDecl, ServiceView, SshHost } from '../../shared/domains/envs-protocol.ts';
import { ToolHost, toolText, type ToolSpec } from '../governance/tool-host.ts';
import { checkKeyFile, explainSshError, forgetHostKey, scanHostKey, shq, sshExec, trustHostKey, validateHost } from '../envs/ssh.ts';
import { ServiceRunner } from '../envs/services.ts';
import type { McpToolResult } from '../sandbox-registry.ts';
import type { DomainContext, DomainModule } from './types.ts';

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const id = (v: unknown, field = 'id'): string => { if (typeof v !== 'string' || !ID.test(v)) throw new Error(`Invalid ${field}.`); return v; };
export const SSH_MCP = 'muster_ssh';
const S = { type: 'string' } as const;
export const SSH_TOOL_SPECS: ToolSpec[] = [
  { name: 'ssh_exec', description: 'Run a shell command on the chat’s SSH host, from its remote folder (or cwd under it). Output is capped.', inputSchema: { type: 'object', properties: { command: S, cwd: S, timeout_sec: { type: 'number' } }, required: ['command'] } },
  { name: 'ssh_read', description: 'Read a text file on the SSH host (path under the remote folder, or absolute).', inputSchema: { type: 'object', properties: { path: S }, required: ['path'] } },
  { name: 'ssh_write', description: 'Write a text file on the SSH host (creates folders). Needs write access in this chat.', inputSchema: { type: 'object', properties: { path: S, text: S }, required: ['path', 'text'] } },
  { name: 'ssh_list', description: 'List a folder on the SSH host.', inputSchema: { type: 'object', properties: { path: S } } },
];
interface Stored { version: 1; hosts: SshHost[]; chats: Record<string, { hostId: string; remoteDir: string }>; services: ServiceDecl[] }

export function createEnvsDomain(ctx: DomainContext): DomainModule {
  const file = join(ctx.dataDir, 'muster-envs.json');
  let state: Stored = { version: 1, hosts: [], chats: {}, services: [] };
  try { if (existsSync(file)) state = { ...state, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<Stored>) }; } catch { /* a damaged file starts empty */ }
  const save = () => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); renameSync(tmp, file); try { chmodSync(file, 0o600); } catch { /* no modes */ } };
  const inv = <T = unknown>(command: string, input: Record<string, unknown>): Promise<T> => ctx.invoke(command as never, input as never) as Promise<T>;
  const emit = (scope: 'ssh' | 'services', projectId?: string) => ctx.emit({ type: 'envsChanged', scope, ...(projectId ? { projectId } : {}) } as never);
  const host = (hid: string) => { const h = state.hosts.find(x => x.id === hid); if (!h) throw new Error('That SSH host no longer exists.'); return h; };

  // ── SSH tools for chats bound to a host ─────────────────────────────────────
  const bound = (chatId: string): { host: SshHost; dir: string } | null => { const b = state.chats[chatId]; const h = b && state.hosts.find(x => x.id === b.hostId); return b && h ? { host: h, dir: b.remoteDir } : null; };
  const under = (dir: string, p: string | undefined) => !p ? dir : p.startsWith('/') || p.startsWith('~') ? p : `${dir.replace(/\/$/, '')}/${p}`;
  async function runSshTool(chatId: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const b = bound(chatId); if (!b) return toolText('This chat is not set to an SSH host.', true);
    if (!b.host.trusted) return toolText(`The host key of ${b.host.name} is not trusted yet. Trust it in Settings, Environments.`, true);
    const chat = ctx.store.chat(chatId), write = chat?.permissionMode !== 'read-only';
    const fail = (r: { stderr: string; code: number | null; timedOut: boolean }) => toolText(r.timedOut ? 'The command timed out.' : explainSshError(r.stderr) || `exit ${r.code}`, true);
    const keyIssue = checkKeyFile(b.host.keyPath); if (keyIssue) return toolText(keyIssue, true);
    switch (tool) {
      case 'ssh_exec': {
        if (!write) return toolText('This chat is read-only: it cannot run commands on the host. Use ssh_read and ssh_list, or raise the chat’s access.', true);
        const command = typeof args.command === 'string' ? args.command : ''; if (!command.trim() || command.length > 20_000) return toolText('Give the command (up to 20,000 characters).', true);
        const r = await sshExec(ctx.dataDir, b.host, under(b.dir, typeof args.cwd === 'string' ? args.cwd : undefined), command, { timeoutSec: typeof args.timeout_sec === 'number' ? args.timeout_sec : 60 });
        const out = [r.stdout, r.stderr && `[stderr]\n${r.stderr}`].filter(Boolean).join('\n');
        return toolText(`${r.timedOut ? '[timed out] ' : ''}exit ${r.code}${r.truncated ? ' (output cut)' : ''}\n${out}`.trimEnd(), r.code !== 0);
      }
      case 'ssh_read': {
        const p = typeof args.path === 'string' ? args.path : ''; if (!p) return toolText('Give the path.', true);
        const r = await sshExec(ctx.dataDir, b.host, b.dir, `cat -- ${shq(under('.', p))}`); return r.code === 0 ? toolText(r.stdout + (r.truncated ? '\n[cut]' : '')) : fail(r);
      }
      case 'ssh_list': {
        const r = await sshExec(ctx.dataDir, b.host, b.dir, `ls -la -- ${shq(under('.', typeof args.path === 'string' ? args.path : '.'))}`); return r.code === 0 ? toolText(r.stdout) : fail(r);
      }
      case 'ssh_write': {
        if (!write) return toolText('This chat is read-only: it cannot write on the host.', true);
        const p = typeof args.path === 'string' ? args.path : '', text = typeof args.text === 'string' ? args.text : null; if (!p || text === null || text.length > 1_000_000) return toolText('Give a path and the text (up to 1 MB).', true);
        const target = shq(under('.', p));
        const r = await sshExec(ctx.dataDir, b.host, b.dir, `mkdir -p -- "$(dirname -- ${target})" && cat > ${target}`, { stdin: text }); return r.code === 0 ? toolText(`Wrote ${p} (${text.length} characters).`) : fail(r);
      }
      default: return toolText(`Unknown tool ${tool}.`, true);
    }
  }
  let sshHost: ToolHost | undefined;
  const toolHost = () => sshHost ??= new ToolHost({ dir: join(ctx.dataDir, 'agent-tools', 'ssh'), name: SSH_MCP, title: 'Muster SSH', specs: SSH_TOOL_SPECS, execPath: process.execPath, run: runSshTool,
    // ssh_exec may run for up to 600 s (the provider's tool timeout is 600 too), so the MCP process waits a little longer; ssh_write takes up to 1 MB of text.
    timeoutMs: 610_000, maxBody: 8 * 1024 * 1024 });
  const offOptions = ctx.hooks.addRunOptionsContributor(async chat => {
    if (!bound(chat.id)) return null;
    const launcher = await toolHost().start();
    return { configOverrides: { [`mcp_servers.${SSH_MCP}.command`]: launcher, [`mcp_servers.${SSH_MCP}.env.MUSTER_CHAT_ID`]: chat.id, [`mcp_servers.${SSH_MCP}.env.MUSTER_CHAT_TOKEN`]: toolHost().chatToken(chat.id), [`mcp_servers.${SSH_MCP}.tool_timeout_sec`]: 600 } };
  });
  const offPrompt = ctx.hooks.addPromptContributor(async ({ chat }) => {
    const b = bound(chat.id); if (!b) return null;
    return { label: 'ssh', text: `The user set this chat to the SSH host “${b.host.name}” (${b.host.user}@${b.host.host}), remote folder ${b.dir}. Do the work on that host with the muster_ssh tools (ssh_exec, ssh_read, ssh_write, ssh_list); your own shell runs on the user's computer, not the host.${chat.permissionMode === 'read-only' ? ' This chat is read-only: ssh_exec and ssh_write are refused.' : ''}` };
  });

  // ── services ────────────────────────────────────────────────────────────────
  const runner = new ServiceRunner(ctx.dataDir, () => { for (const p of new Set([...runner.running.values()].map(r => r.decl.projectId))) emit('services', p); });
  const taskKey = async (_d: ServiceDecl): Promise<string | null> => null;
  const view = async (d: ServiceDecl): Promise<ServiceView> => {
    const r = runner.running.get(d.id);
    return { ...d, state: r?.state ?? 'stopped', pid: r && !r.endedAt ? r.child.pid ?? null : null, url: r && (r.state === 'running' || r.state === 'starting') ? r.url : null, startedAt: r?.startedAt ?? null, endedAt: r?.endedAt ?? null, exitCode: r?.exitCode ?? null, logTail: (r?.log ?? '').slice(-1500), taskKey: await taskKey(d) };
  };
  const decl = (projectId: string, sid: string) => { const d = state.services.find(x => x.id === sid && x.projectId === projectId); if (!d) throw new Error('That service no longer exists.'); return d; };
  async function cwdFor(d: ServiceDecl): Promise<string> {
    if (d.folderId) return ctx.folderFor(d.folderId).path;
    const p = (await inv<{ id: string; primaryFolderId: string | null; folderIds: string[] }[]>('project.list', {})).find(x => x.id === d.projectId);
    const fid = p?.primaryFolderId ?? p?.folderIds[0]; if (!fid) throw new Error('Link a folder to the project (or choose one for this service): the command needs somewhere to run.');
    return ctx.folderFor(fid).path;
  }
  const stopForTask = (projectId: string, taskId: string) => { for (const r of runner.running.values()) if (r.decl.projectId === projectId && r.decl.taskId === taskId && !r.endedAt) void runner.stop(r.decl.id); };
  const offCommand = ctx.hooks.onCommand?.(({ command, input, output }) => {
    try {
      const pid = typeof input.projectId === 'string' ? input.projectId : '', tid = typeof input.id === 'string' ? input.id : '';
      if (command === 'project.tasks.setState' && (input.state === 'verified' || input.state === 'cancelled')) stopForTask(pid, tid);
      else if (command === 'project.tasks.verify' || command === 'project.tasks.delete') stopForTask(pid, tid);
      else if (command === 'project.delete' || command === 'project.archive') for (const r of runner.running.values()) if (r.decl.projectId === (typeof input.id === 'string' ? input.id : '')) void runner.stop(r.decl.id);
      if (command === 'project.delete' && typeof input.id === 'string') { state.services = state.services.filter(s => s.projectId !== input.id); save(); }
      void output;
    } catch { /* observers never fail a command */ }
  });

  return {
    handlers: {
      'ssh.hosts.list': () => ({ hosts: state.hosts }),
      'ssh.hosts.save': input => {
        const v = validateHost(input), existing = typeof input.id === 'string' ? host(input.id) : undefined;
        if (state.hosts.some(h => h.id !== existing?.id && h.name.toLowerCase() === v.name.toLowerCase())) throw new Error(`There is already a host called ${v.name}.`);
        const moved = existing && (existing.host !== v.host || existing.port !== v.port);
        if (moved) forgetHostKey(ctx.dataDir, existing);
        const next: SshHost = { id: existing?.id ?? randomUUID(), ...v, trusted: moved ? null : existing?.trusted ?? null, lastTest: existing?.lastTest ?? null };
        state.hosts = existing ? state.hosts.map(h => h.id === existing.id ? next : h) : [...state.hosts, next]; save(); emit('ssh'); return next;
      },
      'ssh.hosts.remove': input => { const h = host(id(input.id)); forgetHostKey(ctx.dataDir, h); state.hosts = state.hosts.filter(x => x.id !== h.id); for (const [c, b] of Object.entries(state.chats)) if (b.hostId === h.id) delete state.chats[c]; save(); emit('ssh'); return { removed: true as const }; },
      'ssh.hostkey.scan': async input => { const { type, fingerprint } = await scanHostKey(host(id(input.id))); return { type, fingerprint }; },
      'ssh.hostkey.trust': async input => {
        const h = host(id(input.id)), seen = typeof input.fingerprint === 'string' ? input.fingerprint.trim() : '', now = await scanHostKey(h);
        if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(seen)) throw new Error('Paste the fingerprint exactly as shown (SHA256:…).');
        if (now.fingerprint !== seen) throw new Error('The host’s key is not the one you confirmed. Scan again and compare.');
        trustHostKey(ctx.dataDir, h, now.line);
        const next = { ...h, trusted: { type: now.type, fingerprint: now.fingerprint, at: new Date().toISOString() } }; state.hosts = state.hosts.map(x => x.id === h.id ? next : x); save(); emit('ssh'); return next;
      },
      'ssh.test': async input => {
        const h = host(id(input.id)), t0 = Date.now(), fail = (detail: string) => { state.hosts = state.hosts.map(x => x.id === h.id ? { ...x, lastTest: { ok: false, at: new Date().toISOString(), detail } } : x); save(); emit('ssh'); return { ok: false, detail, ms: Date.now() - t0, os: null, cwd: null }; };
        if (!h.trusted) return fail('Trust the host key first.');
        const issue = checkKeyFile(h.keyPath); if (issue) return fail(issue);
        const r = await sshExec(ctx.dataDir, h, h.remoteDir, 'uname -sm && pwd', { timeoutSec: 20 });
        if (r.code !== 0) return fail(explainSshError(r.stderr));
        const [os, cwd] = r.stdout.trim().split('\n');
        state.hosts = state.hosts.map(x => x.id === h.id ? { ...x, lastTest: { ok: true, at: new Date().toISOString(), detail: `${os} · ${cwd}` } } : x); save(); emit('ssh');
        return { ok: true, detail: `Signed in as ${h.user}. ${os} · ${cwd}`, ms: Date.now() - t0, os: os ?? null, cwd: cwd ?? null };
      },
      'ssh.chat.get': input => { const b = bound(id(input.chatId, 'chat id')); return { chatId: String(input.chatId), hostId: b?.host.id ?? null, hostName: b?.host.name ?? null, remoteDir: b?.dir ?? null } satisfies ChatSsh; },
      'ssh.chat.set': input => {
        const chatId = id(input.chatId, 'chat id'); if (!ctx.store.chat(chatId)) throw new Error('That chat no longer exists.');
        if (input.hostId === null) { delete state.chats[chatId]; save(); emit('ssh'); return { chatId, hostId: null, hostName: null, remoteDir: null }; }
        const h = host(id(input.hostId, 'host id')); if (!h.trusted) throw new Error('Trust this host’s key before using it in a chat.');
        const dir = typeof input.remoteDir === 'string' && input.remoteDir.trim() ? input.remoteDir.trim().slice(0, 500) : h.remoteDir;
        state.chats[chatId] = { hostId: h.id, remoteDir: dir }; save(); emit('ssh'); return { chatId, hostId: h.id, hostName: h.name, remoteDir: dir };
      },
      'services.list': async input => { const pid = id(input.projectId, 'project id'); return { services: await Promise.all(state.services.filter(s => s.projectId === pid && (typeof input.taskId !== 'string' || s.taskId === input.taskId)).map(view)) }; },
      'services.save': async input => {
        const projectId = id(input.projectId, 'project id'), taskId = id(input.taskId, 'task id'), name = typeof input.name === 'string' ? input.name.trim() : '', command = typeof input.command === 'string' ? input.command.trim() : '';
        if (!name || name.length > 80) throw new Error('Name the service (up to 80 characters).');
        if (!command || command.length > 2000 || command.includes('\0')) throw new Error('Give the command that starts it (up to 2,000 characters).');
        const port = input.port === null || input.port === undefined || input.port === '' ? null : Number(input.port);
        if (port !== null && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('The port is 1024 to 65535 (or leave it empty and Muster reads it from the output).');
        const folderId = typeof input.folderId === 'string' && input.folderId ? id(input.folderId, 'folder id') : null;
        const w = await inv<{ tasks: { items: { id: string }[] } }>('project.work', { projectId, activityLimit: 1 }); if (!w.tasks.items.some(t => t.id === taskId)) throw new Error('That task does not exist in this project.');
        const cur = typeof input.id === 'string' ? decl(projectId, input.id) : undefined;
        if (cur && runner.running.get(cur.id) && ['starting', 'running'].includes(runner.running.get(cur.id)!.state)) throw new Error('Stop the service before changing it.');
        const next: ServiceDecl = { id: cur?.id ?? randomUUID(), projectId, taskId, name, command, port, folderId };
        state.services = cur ? state.services.map(s => s.id === cur.id ? next : s) : [...state.services, next]; save(); emit('services', projectId); return next;
      },
      'services.remove': async input => { const d = decl(id(input.projectId, 'project id'), id(input.id)); await runner.stop(d.id); runner.running.delete(d.id); state.services = state.services.filter(s => s.id !== d.id); save(); emit('services', d.projectId); return { removed: true as const }; },
      'services.start': async input => {
        const d = decl(id(input.projectId, 'project id'), id(input.id)), cwd = await cwdFor(d);
        runner.start(d, cwd); emit('services', d.projectId); return view(d);
      },
      'services.stop': async input => { const d = decl(id(input.projectId, 'project id'), id(input.id)); await runner.stop(d.id); emit('services', d.projectId); return view(d); },
      'services.previews': async input => {
        const pid = id(input.projectId, 'project id'), out: PreviewItem[] = [];
        for (const d of state.services.filter(s => s.projectId === pid)) { const r = runner.running.get(d.id); if (r?.url && (r.state === 'running' || r.state === 'starting')) out.push({ id: `preview:${d.id}`, title: d.name, url: r.url, taskId: d.taskId, serviceId: d.id, state: r.state, at: r.startedAt }); }
        return { previews: out };
      },
    },
    dispose() { offOptions(); offPrompt(); offCommand?.(); sshHost?.dispose(); sshHost = undefined; void runner.stopAll(); },
  };
}
