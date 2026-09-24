/**
 * Sandbox domain (SBX-01, USER-37): a chat can run its agent work inside the scoped Linux container instead of on this Mac.
 *
 * Design choice (documented per the brief): the Codex app-server keeps running on the host. Running it inside the
 * container is not feasible here: the bundled container image is a slim Linux node image with no Codex binary for it,
 * the provider auth lives in the host keychain/config, and the bundled core bind-mounts only its own app-data workspace.
 * So a 'sandbox' chat gets the fallback the brief names: the `muster_sandbox` MCP tool set (sandbox_exec, sandbox_read,
 * sandbox_write, sandbox_list, see runtime/sandbox-agent-tools.ts) routed through the W4-C style agent-tools host,
 * the chat's host access set to read-only (the provider's own read-only sandbox mode, since `sandbox*` config overrides
 * are filtered by provider.ts), and the run's cwd switched to the host side of the container's /workspace bind mount so
 * host-side reads see exactly what the container sees. Mode 'copy' seeds that workspace from the chat's folder;
 * 'mount' is refused with its reason until the core can bind a caller-supplied folder.
 */
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Chat, ChatPermissionMode } from '../../shared/protocol.ts';
import type { ChatBrowserPlacement, ChatEnvironmentKind, ChatEnvironmentMode, ChatEnvironmentStatus, SandboxChange, SandboxChanges, SandboxFileDiff } from '../../shared/domains/sandbox-protocol.ts';
import type { ScopedComputerRef } from '../../shared/scoped-computer-protocol.ts';
import { currentAgentSandboxHost, type AgentSandboxHost } from '../sandbox-registry.ts';
import { SANDBOX_MCP } from '../sandbox-agent-tools.ts';
import type { DomainContext, DomainModule } from './types.ts';

export const SANDBOX_ENV_LABEL = 'Sandbox · Linux container';
export const HOST_ENV_LABEL = 'This Mac';
export const SANDBOX_NOT_READY = `${SANDBOX_ENV_LABEL} is not running for this chat. Start it in the Sandbox tab (or switch the chat back to ${HOST_ENV_LABEL}), then send again.`;
export const MOUNT_UNSUPPORTED = 'Mounting the folder itself into the container is not available yet: the container core binds only its own workspace. Choose the isolated copy.';
/** Turn note for a sandbox chat; the tools describe themselves, this fixes where work happens. */
export const SANDBOX_NOTE = `This chat runs in ${SANDBOX_ENV_LABEL}. The working folder you see is the host side of the container's /workspace (an isolated copy of the project). Run every command with the sandbox_exec tool and make every file change with sandbox_write; the host shell and host writes are disabled for this chat. Paths passed to sandbox tools are relative to /workspace. The user applies your changes to their Mac later through a diff review. The agent browser, when available, runs on the user's Mac, not in the container.`;
/** SBX-11: the note's browser sentence when the chat's browser runs inside the container instead. */
export const SANDBOX_BROWSER_ENDPOINT = 'http://127.0.0.1:9222';
export const SANDBOX_BROWSER_NOTE = SANDBOX_NOTE.replace('The agent browser, when available, runs on the user\'s Mac, not in the container.', `This chat's browser runs inside the container, not on the user's Mac: headless Chromium with its DevTools endpoint at ${SANDBOX_BROWSER_ENDPOINT} (reachable only inside the container). Drive it from sandbox_exec (for example a CDP or Playwright script); do not use host browser tools for this chat's pages.`);
const SKIP = new Set(['node_modules', '.DS_Store']);
const COMPARE_SKIP = new Set(['node_modules', '.DS_Store', '.git']);
const MAX_SEED_BYTES = 2 * 1024 ** 3, MAX_WALK = 100_000, MAX_CHANGES = 2000, MAX_DIFF = 1024 * 1024, MAX_COMPARE = 32 * 1024 * 1024;

interface Row { chat_id: string; env: ChatEnvironmentKind; mode: ChatEnvironmentMode; previous_permission: string | null; seeded_at: string | null; workspace_path: string | null; browser?: ChatBrowserPlacement | null }
const chatIdOf = (input: Record<string, unknown>): string => {
  const value = input.chatId;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid chat id.');
  return value;
};
/** One scope per chat, matching the renderer's sandboxTarget: the project's sandbox when the chat has one, else the chat's own. */
export const scopeForChat = (chat: Pick<Chat, 'id' | 'projectId'>): ScopedComputerRef => chat.projectId ? { kind: 'project', id: chat.projectId } : { kind: 'chat', id: chat.id };
const relPath = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0')) throw new Error('Invalid path.');
  const parts = value.split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.includes('..')) throw new Error('Invalid path.');
  return parts.join('/');
};
async function* walk(root: string, skip: Set<string>): AsyncGenerator<{ path: string; size: number }> {
  const stack = [root]; let seen = 0;
  while (stack.length) {
    const current = stack.pop()!;
    let entries; try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (skip.has(entry.name) || ++seen > MAX_WALK) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) yield { path: relative(root, path).split(sep).join('/'), size: (await lstat(path)).size };
    }
  }
}
const sameBytes = async (a: string, b: string, size: number): Promise<boolean> => size > MAX_COMPARE ? false : (await readFile(a)).equals(await readFile(b));
const gitDiff = (cwd: string, before: string, after: string): Promise<string> => new Promise(resolve =>
  execFile('git', ['diff', '--no-index', '--no-color', '--', before, after], { cwd, timeout: 15_000, maxBuffer: MAX_DIFF * 2, windowsHide: true }, (_error, out) => resolve(typeof out === 'string' ? out : '')));

export function createSandboxDomain(ctx: DomainContext): DomainModule {
  const db = ctx.db();
  db.exec('CREATE TABLE IF NOT EXISTS chat_environments (chat_id TEXT PRIMARY KEY, env TEXT NOT NULL, mode TEXT NOT NULL, previous_permission TEXT, seeded_at TEXT, workspace_path TEXT, updated_at TEXT NOT NULL)');
  // SBX-11 column, added in place for databases created before browser placement existed.
  if (!(db.prepare('PRAGMA table_info(chat_environments)').all() as {name: string}[]).some(column => column.name === 'browser')) db.exec("ALTER TABLE chat_environments ADD COLUMN browser TEXT NOT NULL DEFAULT 'host'");
  const row = (chatId: string): Row | undefined => db.prepare('SELECT chat_id, env, mode, previous_permission, seeded_at, workspace_path, browser FROM chat_environments WHERE chat_id = ?').get(chatId) as Row | undefined;
  const save = (r: Row) => db.prepare('INSERT INTO chat_environments (chat_id, env, mode, previous_permission, seeded_at, workspace_path, browser, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET env = excluded.env, mode = excluded.mode, previous_permission = excluded.previous_permission, seeded_at = excluded.seeded_at, workspace_path = excluded.workspace_path, browser = excluded.browser, updated_at = excluded.updated_at')
    .run(r.chat_id, r.env, r.mode, r.previous_permission, r.seeded_at, r.workspace_path, r.env === 'sandbox' && r.browser === 'sandbox' ? 'sandbox' : 'host', new Date().toISOString());
  const browserOf = (r: Row | undefined): ChatBrowserPlacement => r?.env === 'sandbox' && r.browser === 'sandbox' ? 'sandbox' : 'host';
  const inSandbox = (chatId: string): Row | undefined => { const r = row(chatId); return r?.env === 'sandbox' ? r : undefined; };
  const chatFor = (chatId: string): Chat => { const chat = ctx.store.chat(chatId); if (!chat) throw new Error('This chat no longer exists.'); return chat; };
  const running = (chat: Chat) => chat.status === 'running' || chat.status === 'stopping';
  const host = (): AgentSandboxHost => { const found = currentAgentSandboxHost(); if (!found) throw new Error('Sandbox execution is available in the Muster desktop app only.'); return found; };

  async function status(chat: Chat): Promise<ChatEnvironmentStatus> {
    const r = row(chat.id);
    const base = { chatId: chat.id, browser: browserOf(r), ...(r?.seeded_at ? { seededAt: r.seeded_at } : {}), ...(r?.workspace_path ? { workspacePath: r.workspace_path } : {}) };
    if (!r || r.env === 'host') return { ...base, env: 'host', mode: r?.mode ?? 'copy', ready: true };
    let ready = false, reason: string | undefined;
    try { const ws = await host().agentWorkspace(scopeForChat(chat)); ready = ws.running; reason = ws.reason; } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    let browserService: ChatEnvironmentStatus['browserService'];
    if (base.browser === 'sandbox') {
      try { const service = await host().browserServiceStatus?.(scopeForChat(chat)); if (service) browserService = { ...service, endpoint: SANDBOX_BROWSER_ENDPOINT }; }
      catch (error) { browserService = { state: 'unknown', reason: error instanceof Error ? error.message : String(error), endpoint: SANDBOX_BROWSER_ENDPOINT }; }
    }
    return { ...base, env: 'sandbox', mode: r.mode, ready, ...(ready ? {} : { reason: reason ?? SANDBOX_NOT_READY }), ...(browserService ? { browserService } : {}) };
  }
  const announce = async (chat: Chat) => { const environment = await status(chat); ctx.emit({ type: 'sandboxEnvironment', chatId: chat.id, environment }); return environment; };

  /** Copies the folder into the workspace (the isolated copy). `fresh` first clears what the copy holds. */
  async function seed(chat: Chat, r: Row, fresh: boolean): Promise<string> {
    const ws = await host().agentWorkspace(scopeForChat(chat));
    await mkdir(ws.hostPath, { recursive: true, mode: 0o700 });
    if (fresh) for (const entry of await readdir(ws.hostPath)) await rm(join(ws.hostPath, entry), { recursive: true, force: true });
    if (chat.folderId) {
      const folder = ctx.folderFor(chat.folderId);
      let bytes = 0; for await (const file of walk(folder.path, SKIP)) { bytes += file.size; if (bytes > MAX_SEED_BYTES) throw new Error('This folder is too large to copy into the sandbox (limit 2 GB without node_modules).'); }
      await cp(folder.path, ws.hostPath, { recursive: true, force: true, dereference: false, errorOnExist: false, filter: source => !SKIP.has(source.split(sep).at(-1)!) });
    }
    save({ ...r, seeded_at: new Date().toISOString(), workspace_path: ws.hostPath });
    return ws.hostPath;
  }
  const copyPaths = async (chat: Chat): Promise<{ folder: string; copy: string; folderId: string }> => {
    const r = inSandbox(chat.id);
    if (!r) throw new Error(`This chat runs on ${HOST_ENV_LABEL}; there is no isolated copy.`);
    if (!chat.folderId) throw new Error('This chat has no folder to apply changes to.');
    const copy = r.workspace_path ?? (await host().agentWorkspace(scopeForChat(chat))).hostPath;
    return { folder: ctx.folderFor(chat.folderId).path, copy, folderId: chat.folderId };
  };
  async function changes(chat: Chat): Promise<SandboxChanges> {
    const { folder, copy, folderId } = await copyPaths(chat);
    const files: SandboxChange[] = []; let truncated = false;
    const inCopy = new Map<string, number>();
    for await (const file of walk(copy, COMPARE_SKIP)) {
      inCopy.set(file.path, file.size);
      let other; try { other = await lstat(join(folder, file.path)); } catch { other = undefined; }
      if (!other || !other.isFile()) files.push({ path: file.path, status: 'added', bytes: file.size });
      else if (other.size !== file.size || !(await sameBytes(join(folder, file.path), join(copy, file.path), file.size))) files.push({ path: file.path, status: 'modified', bytes: file.size });
      if (files.length >= MAX_CHANGES) { truncated = true; break; }
    }
    if (!truncated) for await (const file of walk(folder, COMPARE_SKIP)) { if (!inCopy.has(file.path)) files.push({ path: file.path, status: 'deleted', bytes: file.size }); if (files.length >= MAX_CHANGES) { truncated = true; break; } }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { chatId: chat.id, folderId, files, truncated };
  }

  ctx.hooks.setRunEnvironmentResolver(async (chat, defaultCwd) => {
    const r = inSandbox(chat.id);
    if (!r) return { cwd: defaultCwd };
    if (r.mode === 'mount') throw new Error(MOUNT_UNSUPPORTED);
    const ws = await host().agentWorkspace(scopeForChat(chat));
    if (!ws.running) throw new Error(`${SANDBOX_NOT_READY}${ws.reason ? ` (${ws.reason})` : ''}`);
    const cwd = r.seeded_at && r.workspace_path === ws.hostPath ? ws.hostPath : await seed(chat, r, false);
    return { cwd };
  });
  const unsubscribe = ctx.hooks.addRunOptionsContributor(async chat => {
    if (!inSandbox(chat.id)) return null;
    const launcher = await host().agentToolsLauncher(async chatId => scopeForChat(chatFor(chatId)));
    return { developerInstructions: browserOf(row(chat.id)) === 'sandbox' ? SANDBOX_BROWSER_NOTE : SANDBOX_NOTE, configOverrides: { [`mcp_servers.${SANDBOX_MCP}.command`]: launcher, [`mcp_servers.${SANDBOX_MCP}.env.MUSTER_CHAT_ID`]: chat.id, [`mcp_servers.${SANDBOX_MCP}.tool_timeout_sec`]: 1830 } };
  });

  return {
    handlers: {
      'sandbox.chatEnvironment.get': input => status(chatFor(chatIdOf(input))),
      'sandbox.chatEnvironment.set': async input => {
        const chat = chatFor(chatIdOf(input)), env = input.env, mode = input.mode ?? row(chat.id)?.mode ?? 'copy';
        if (env !== 'host' && env !== 'sandbox') throw new Error('Invalid environment.');
        if (mode !== 'copy' && mode !== 'mount') throw new Error('Invalid sandbox mode.');
        if (running(chat)) throw new Error('Stop the chat before changing where it runs.');
        if (env === 'sandbox' && mode === 'mount') throw new Error(MOUNT_UNSUPPORTED);
        const current = row(chat.id);
        if (env === 'sandbox') {
          host();
          if (current?.env !== 'sandbox') {
            const previous = chat.permissionMode ?? 'workspace';
            // Host access becomes read-only: commands and edits go through the sandbox tools instead.
            if (previous !== 'read-only') await ctx.invoke('chat.setPermissionMode', { id: chat.id, permissionMode: 'read-only' });
            save({ chat_id: chat.id, env, mode, previous_permission: previous, seeded_at: null, workspace_path: null });
          } else save({ ...current, mode });
        } else {
          // Restore whatever access policy the chat had before sandboxing (not just 'workspace'); 'full' needs its own re-acknowledgement gate.
          if (current?.env === 'sandbox' && current.previous_permission && current.previous_permission !== 'read-only' && chat.permissionMode === 'read-only') {
            const restore = current.previous_permission as ChatPermissionMode;
            await ctx.invoke('chat.setPermissionMode', { id: chat.id, permissionMode: restore, ...(restore === 'full' ? { acknowledgeFullAccess: true } : {}) });
          }
          if (browserOf(current) === 'sandbox') await host().browserService?.(scopeForChat(chat), false).catch(() => undefined);
          save({ chat_id: chat.id, env, mode, previous_permission: null, seeded_at: current?.seeded_at ?? null, workspace_path: current?.workspace_path ?? null, browser: 'host' });
        }
        return announce(chatFor(chat.id));
      },
      'sandbox.syncFromHost': async input => {
        const chat = chatFor(chatIdOf(input)), r = inSandbox(chat.id);
        if (!r) throw new Error(`This chat runs on ${HOST_ENV_LABEL}.`);
        if (running(chat)) throw new Error('Stop the chat before refreshing its copy.');
        await seed(chat, r, true);
        return announce(chat);
      },
      'sandbox.browserPlacement.set': async input => {
        const chat = chatFor(chatIdOf(input)), browser = input.browser;
        if (browser !== 'host' && browser !== 'sandbox') throw new Error('Choose where the browser runs.');
        if (running(chat)) throw new Error('Stop the chat before changing where its browser runs.');
        const r = row(chat.id);
        if (browser === 'sandbox' && r?.env !== 'sandbox') throw new Error(`Run this chat in the ${SANDBOX_ENV_LABEL} before moving its browser there.`);
        if (r && browserOf(r) !== browser) {
          const service = host();
          if (!service.browserService) throw new Error('This build cannot run a browser inside the sandbox.');
          await service.browserService(scopeForChat(chat), browser === 'sandbox');
          save({ ...r, browser });
        }
        return announce(chatFor(chat.id));
      },
      'sandbox.changes': input => changes(chatFor(chatIdOf(input))),
      'sandbox.fileDiff': async input => {
        const chat = chatFor(chatIdOf(input)), path = relPath(input.path), { folder, copy } = await copyPaths(chat);
        const before = join(folder, path), after = join(copy, path);
        const has = async (file: string) => { try { return (await lstat(file)).isFile(); } catch { return false; } };
        const [inHost, inCopy] = await Promise.all([has(before), has(after)]);
        if (!inHost && !inCopy) throw new Error('That file exists in neither place.');
        const status: SandboxFileDiff['status'] = !inHost ? 'added' : !inCopy ? 'deleted' : 'modified';
        const raw = await gitDiff(folder, inHost ? before : '/dev/null', inCopy ? after : '/dev/null');
        // Header lines carry a/<absolute host path>; show a/<workspace-relative path> instead.
        const patch = raw.split('\n').map(line => /^(diff --git|---|\+\+\+) /.test(line) ? line.split(before).join(`/${path}`).split(after).join(`/${path}`) : line).join('\n');
        return { path, status, patch: patch.slice(0, MAX_DIFF), truncated: patch.length > MAX_DIFF };
      },
      'sandbox.applyToHost': async input => {
        const chat = chatFor(chatIdOf(input));
        if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > MAX_CHANGES) throw new Error('Choose the files to apply.');
        const paths = input.paths.map(relPath), { folder, copy, folderId } = await copyPaths(chat);
        const applied: string[] = [];
        for (const path of paths) {
          const source = join(copy, path), target = join(folder, path);
          let present; try { present = (await lstat(source)).isFile(); } catch { present = false; }
          if (present) { await mkdir(dirname(target), { recursive: true }); await cp(source, target, { force: true, dereference: false }); }
          else { try { if ((await stat(target)).isFile()) await rm(target); } catch { continue; } }
          applied.push(path);
        }
        ctx.emit({ type: 'workspaceChanged', folderId });
        return { applied };
      },
    },
    dispose() { unsubscribe(); ctx.hooks.setRunEnvironmentResolver(undefined); },
  };
}
