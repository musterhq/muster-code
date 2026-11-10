/**
 * #147 SSH workspaces (phase 1). Contract: shared/domains/remote-protocol.ts.
 * Hosts in Settings, `ssh://` folders whose file tree, editor, search and Git pane work on the host, terminals and port
 * forwards. The runtime sends every file and Git command for such a folder here (see `remoteFolder` in hooks) instead of
 * touching a local path; a command phase 1 does not cover says so instead of running on this computer.
 */
import { posix } from 'node:path';
import type { Folder } from '../../shared/protocol.ts';
import { isRemoteFolderPath, parseRemoteFolderPath, remoteAuthority, type RemoteHost, type RemoteHostInput } from '../../shared/domains/remote-protocol.ts';
import { RemoteHub } from '../remote/hub.ts';
import { RemoteFiles } from '../remote/remote-fs.ts';
import { RemoteGit } from '../remote/remote-git.ts';
import type { DomainContext, DomainModule } from './types.ts';

const str = (v: unknown, label: string, max = 4096) => { if (typeof v !== 'string' || !v || v.length > max || v.includes('\0')) throw new Error(`Choose ${label}.`); return v; };

export function createRemoteDomain(ctx: DomainContext): DomainModule {
  const hub = new RemoteHub(ctx.dataDir, (hostId, status) => ctx.emit({ type: 'remoteChanged', hostId, status } as never));
  const files = new RemoteFiles(hub), git = new RemoteGit(hub);
  const locate = (folder: Folder): { host: RemoteHost; root: string } => {
    const parsed = parseRemoteFolderPath(folder.path); if (!parsed) throw new Error('This folder’s SSH address is not valid.');
    const host = hub.byAuthority(parsed.authority); if (!host) throw new Error(`The SSH host ${parsed.authority} of this folder is no longer in Settings. Add it again in Settings › Environments.`);
    return { host, root: parsed.path };
  };
  const remoteFolder = (folderId: unknown) => {
    const folder = ctx.folderFor(str(folderId, 'a folder', 128));
    if (!isRemoteFolderPath(folder.path)) throw new Error('That folder is on this computer, not on an SSH host.');
    return { folder, ...locate(folder) };
  };
  const changed = (folder: Folder) => ctx.emit({ type: 'workspaceChanged', folderId: folder.id } as never);

  /** File and Git commands for an `ssh://` folder. */
  async function route(command: string, p: Record<string, unknown>, folder: Folder): Promise<unknown> {
    const { host, root } = locate(folder);
    switch (command) {
      case 'files.list': return files.list(host, root, p.path, p.showHidden === true);
      case 'files.read': return files.read(host, root, p.path);
      case 'files.readFull': return files.read(host, root, p.path, true);
      case 'files.write': return files.write(host, root, p.path, p.text, p.expectedRevision === undefined ? undefined : str(p.expectedRevision, 'a revision', 64)).then(r => { changed(folder); return r; });
      case 'files.create': await files.create(host, root, p.path, p.kind); changed(folder); return;
      case 'files.move': await files.move(host, root, p.from, p.to); ctx.emit({ type: 'fileMoved', folderId: folder.id, from: p.from, to: p.to } as never); changed(folder); return;
      case 'files.trash': await files.trash(host, root, p.path); changed(folder); return;
      case 'files.search': return files.search(host, root, p.path, p.query);
      case 'files.quickOpen': return { results: await files.quickOpen(host, root, typeof p.query === 'string' ? p.query.slice(0, 256) : '') };
      case 'files.searchContent': return files.searchContent(host, root, p.query, { regex: p.regex === true, caseSensitive: p.caseSensitive === true, glob: p.glob });
      case 'files.searchContent.cancel': return;
      case 'git.status': return git.status(host, root);
      case 'git.changes': return git.changes(host, root);
      case 'git.diff': return git.diff(host, root, p.path);
      case 'git.mutate': return git.mutate(host, root, p.operation, p.revision, p.paths, p.message).then(r => { changed(folder); return r; });
      case 'git.push': return git.push(host, root, p.revision).then(r => { changed(folder); return r; });
      // Contracts that never fail: say why instead.
      case 'git.pullRequests': return { available: false, reason: `Pull requests for folders on ${host.name} come in a later release.`, items: [] };
      case 'git.compareUrl': return { url: null, reason: `Not available for folders on ${host.name} yet.` };
      default: throw new Error(`This is not available for folders on an SSH host yet (${host.name}). Use the folder’s terminal for it.`);
    }
  }
  ctx.hooks.setRemoteFolderRouter?.(route);

  return {
    handlers: {
      'remote.hosts.list': () => hub.list(),
      'remote.hosts.config': () => hub.configEntries(),
      'remote.hosts.save': input => { const saved = hub.saveHost(input as unknown as RemoteHostInput); ctx.emit({ type: 'remoteChanged', hostId: saved.id } as never); return saved; },
      'remote.hosts.remove': async input => {
        const h = hub.host(input.id), authority = remoteAuthority(h);
        if (ctx.store.snapshot().folders.some(f => parseRemoteFolderPath(f.path)?.authority === authority)) throw new Error(`Remove ${h.name}’s folders from the sidebar first.`);
        await hub.removeHost(h.id); ctx.emit({ type: 'remoteChanged', hostId: h.id } as never); return { removed: true as const };
      },
      'remote.hosts.connect': input => hub.connect(hub.host(input.id).id),
      'remote.hosts.disconnect': input => hub.disconnect(hub.host(input.id).id),
      'remote.hosts.trust': input => hub.trust(hub.host(input.id).id, input.fingerprint),
      'remote.folder.add': async input => {
        const h = hub.host(input.hostId), status = await hub.connect(h.id);
        if (status.state !== 'connected') throw new Error(status.detail);
        const real = await files.resolveFolder(h, input.path);
        const folder = ctx.store.addFolder(`ssh://${remoteAuthority(h)}${real}`, posix.basename(real) || h.name);
        ctx.emitSnapshot(); return folder;
      },
      'remote.terminal.launch': async input => {
        const { folder, host, root } = remoteFolder(input.folderId), launch = await hub.terminal(host, root);
        return { ...launch, title: `${host.name} · ${folder.name}`.slice(0, 80), cwd: folder.path };
      },
      'remote.forward.open': async input => { const { host } = remoteFolder(input.folderId); return hub.openForward(host, input.port); },
      'remote.forward.close': async input => { const { host } = remoteFolder(input.folderId); return { closed: await hub.closeForward(host, input.port) }; },
      'remote.forward.list': input => ({ forwards: hub.listForwards(input.folderId === undefined ? undefined : remoteFolder(input.folderId).host.id) }),
    },
    async dispose() { ctx.hooks.setRemoteFolderRouter?.(undefined); await hub.dispose(); },
  };
}
