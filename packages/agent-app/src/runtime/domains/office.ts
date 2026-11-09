/**
 * The office domain (#789, #772-#775). Contract: shared/domains/office-protocol.ts.
 * Owns Muster's office runtime (<agent-data>/office-runtime) and hands it to the document preview. A download runs in the
 * background; the Settings row follows it through `officeRuntimeChanged` events.
 * Owns the office libraries agent scripts import (<agent-data>/office-libs) and the muster_office agent tools: every
 * agent-mode chat gets them with a note that points at Muster's own skills for documents, spreadsheets, presentations
 * and PDF. While a tool waits on a first download, the chat's tool row shows the progress (`officeToolProgress`).
 */
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgentEvent } from '../../shared/protocol.ts';
import { OfficeRuntime, type OfficeRuntimeOptions } from '../office-runtime.ts';
import { OfficeLibraries, bundledOfficeManifest, localOfficeModules, type OfficeLibrariesOptions } from '../office-libraries.ts';
import { renderOfficeFile, type RenderOfficeOptions } from '../office-render.ts';
import { OFFICE_MCP, OFFICE_TOOL_TIMEOUT_SEC, OfficeToolHost, officeNote } from '../office-agent-tools.ts';
import { musterSkillsDir } from '../office-skills.ts';
import { activeOfficeRuntime, setOfficeRuntime } from '../document-preview.ts';
import { OfficeLivePreviews, type DirWatch } from '../office-live.ts';
import { resolveInside } from '../paths.ts';
import type { OfficeLiveSource } from '../../shared/domains/office-protocol.ts';
import type { DomainContext, DomainModule } from './types.ts';

/** Tests only: fakes for the network, the unpacker and the converter. Unset in the app. */
export const officeRuntimeTesting: {
  options?: Partial<Omit<OfficeRuntimeOptions, 'root' | 'onProgress'>>;
  libraries?: Partial<Omit<OfficeLibrariesOptions, 'root' | 'onProgress'>>;
  render?: Pick<RenderOfficeOptions, 'run' | 'rasterize'>;
  skillsDir?: string;
  /** #829: the folder watch and debounce of live office previews. */
  live?: { watch?: DirWatch; debounceMs?: number };
} = {};

export function createOfficeDomain(ctx: DomainContext): DomainModule {
  // Events go out in order, so the last one a Settings row sees is the latest state.
  let chain: Promise<void> = Promise.resolve();
  const emitStatus = () => { chain = chain.then(async () => { ctx.emit({ type: 'officeRuntimeChanged', status: await runtime.status() } as AgentEvent); }).catch(() => undefined); return chain; };
  const runtime = new OfficeRuntime({ root: join(ctx.dataDir, 'office-runtime'), ...officeRuntimeTesting.options, onProgress: () => { void emitStatus(); } });
  setOfficeRuntime(runtime);

  const skillsDir = officeRuntimeTesting.skillsDir ?? musterSkillsDir();
  const here = typeof __dirname === 'string' ? __dirname : join(process.cwd(), 'src', 'runtime');
  const libraries = new OfficeLibraries({
    root: join(ctx.dataDir, 'office-libs'), execPath: process.execPath,
    manifest: bundledOfficeManifest(dirname(skillsDir)), localModules: localOfficeModules(here),
    ...officeRuntimeTesting.libraries,
  });

  // The folder each chat's last run worked in, for relative paths in office_render.
  const cwds = new Map<string, string>();
  const offStarted = ctx.hooks.onRunStarted(run => { cwds.set(run.chat.id, run.cwd); });
  const chatCwd = (chatId: string): string | undefined => {
    const known = cwds.get(chatId);
    if (known) return known;
    const chat = ctx.store.chat(chatId);
    try { return chat?.folderId ? ctx.folderFor(chat.folderId).path : undefined; } catch { return undefined; }
  };

  let host: OfficeToolHost | undefined, starting: Promise<string> | undefined;
  const launcher = () => starting ??= (async () => {
    host = new OfficeToolHost({
      dir: join(ctx.dataDir, 'agent-tools'), execPath: process.execPath,
      knownChat: chatId => !!ctx.store.chat(chatId),
      deps: {
        libraries,
        render: (file, outDir, options) => renderOfficeFile(file, { runtime, outDir, maxPages: options.maxPages, onProgress: options.onProgress, ...officeRuntimeTesting.render }),
        rendersDir: join(ctx.dataDir, 'office-renders'),
        cwd: chatCwd,
        progress: (chatId, message) => ctx.emit({ type: 'officeToolProgress', chatId, message } as AgentEvent),
      },
    });
    return host.start();
  })().catch(error => { starting = undefined; throw error; });
  // #829: office previews on screen redraw when their file changes. A refresh uses the LibreOffice already there
  // (the user's own or Muster's earlier download) and never starts a download.
  const installedOnly = { ensure: async () => {
    const soffice = await runtime.soffice();
    if (!soffice) throw new Error('LibreOffice is not installed, so the preview cannot be redrawn. Render the file again from the chat, or download it in Settings › Storage.');
    return soffice;
  } };
  const live = new OfficeLivePreviews({
    dir: join(ctx.dataDir, 'office-renders', 'live'),
    resolve: (source: OfficeLiveSource) => resolveLiveSource(source),
    render: (file, outDir, maxPages) => renderOfficeFile(file, { runtime: installedOnly, outDir, maxPages, ...officeRuntimeTesting.render }),
    emit: state => ctx.emit({ type: 'officeLiveChanged', ...state } as AgentEvent),
    ...officeRuntimeTesting.live,
  });
  async function resolveLiveSource(source: OfficeLiveSource): Promise<string> {
    if (!source || typeof source !== 'object' || typeof source.path !== 'string' || !source.path.trim() || source.path.includes('\0')) throw new Error('Invalid preview.');
    if (source.kind === 'file') {
      if (typeof source.folderId !== 'string') throw new Error('Invalid preview.');
      return resolveInside(ctx.folderFor(source.folderId).path, source.path);
    }
    if (source.kind !== 'render' || typeof source.chatId !== 'string' || !ctx.store.chat(source.chatId)) throw new Error('This chat no longer exists.');
    // The same resolution office_render used for the path it was given.
    const base = chatCwd(source.chatId);
    if (!isAbsolute(source.path) && !base) throw new Error('This chat has no working folder.');
    return resolve(base ?? '/', source.path.trim());
  }
  const liveId = (value: unknown): string => { if (typeof value !== 'string' || !value || value.length > 2048 || value.includes('\0')) throw new Error('Invalid preview id.'); return value; };

  const removeRunOptions = ctx.hooks.addRunOptionsContributor(async chat => {
    if (chat.mode !== 'agent') return null;
    const command = await launcher();
    return { developerInstructions: officeNote(skillsDir), configOverrides: { [`mcp_servers.${OFFICE_MCP}.command`]: command, [`mcp_servers.${OFFICE_MCP}.env.MUSTER_CHAT_ID`]: chat.id, [`mcp_servers.${OFFICE_MCP}.tool_timeout_sec`]: OFFICE_TOOL_TIMEOUT_SEC } };
  });

  return {
    handlers: {
      'office.runtime.status': () => runtime.status(),
      'office.runtime.download': async () => {
        const job = runtime.ensure();
        void job.then(emitStatus, emitStatus);
        await Promise.race([job.then(() => undefined, () => undefined), runtime.whenBusy()]);
        return runtime.status();
      },
      'office.runtime.remove': async () => { await runtime.remove(); await emitStatus(); return runtime.status(); },
      'office.libraries.status': () => libraries.status(),
      'office.libraries.remove': async () => { await libraries.remove(); return libraries.status(); },
      'office.live.watch': input => live.watch(liveId(input.id), input.source as OfficeLiveSource, typeof input.since === 'number' && Number.isFinite(input.since) ? input.since : undefined),
      'office.live.unwatch': input => { live.unwatch(liveId(input.id)); },
      'office.live.pages': input => live.pages(liveId(input.id)),
    },
    dispose() {
      removeRunOptions(); offStarted();
      host?.dispose();
      live.dispose();
      if (activeOfficeRuntime() === runtime) setOfficeRuntime(null);
    },
  };
}
