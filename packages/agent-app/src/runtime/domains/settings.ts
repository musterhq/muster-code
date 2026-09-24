import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, homedir, release, userInfo } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import {
  MAX_SETTINGS_IMPORT_BYTES, SETTING_DEFAULTS, diagnosticsText, isModelPreference, resolveChatDefaults, type ModelPreference, type ResolvedChatDefaults, redactDiagnostics, SETTING_KEYS, isSettingKey, normalizeSettings, parseSettingsImport, settingsExport, validateSetting,
  type AppSettings, type CleanableCategory, type CleanupItem, type CleanupPreview, type DiagnosticsReport, type ProcessMetric, type SettingKey, type StorageCategory, type StorageCategoryId, type StorageReport,
} from '../../shared/domains/settings-protocol.ts';
import type { DomainContext, DomainModule } from './types.ts';
import { availableShells, loginShell, resolveTerminalShell } from '../terminal-shell.ts';

interface Contents { setZoomFactor(factor: number): void; on(event: 'did-finish-load', fn: () => void): void; isDestroyed?(): boolean }
interface Win { webContents: Contents; isDestroyed(): boolean }
interface DialogResult { canceled: boolean; filePath?: string; filePaths?: string[] }
/** The slice of Electron's main-process API this domain uses. Absent in plain Node (tests), where every use degrades. */
export interface ElectronApi {
  app: { getName(): string; getVersion(): string; getPath(name: 'documents'): string; getAppMetrics(): Array<{ pid: number; type: string; name?: string; serviceName?: string; cpu: { percentCPUUsage: number }; memory: { workingSetSize: number } }>; on(event: 'browser-window-created', fn: (event: unknown, win: Win) => void): void; off(event: 'browser-window-created', fn: (event: unknown, win: Win) => void): void };
  BrowserWindow: { getAllWindows(): Win[]; getFocusedWindow(): Win | null };
  dialog: { showSaveDialog(win: Win | undefined, options: object): Promise<DialogResult>; showOpenDialog(win: Win | undefined, options: object): Promise<DialogResult> };
  shell: { showItemInFolder(path: string): void };
}

function loadElectron(): ElectronApi | undefined {
  try {
    const mod = createRequire(typeof __filename === 'string' ? __filename : join(process.cwd(), 'index.js'))('electron') as unknown;
    // Outside Electron the npm package resolves to the binary path string.
    return mod && typeof mod === 'object' && 'app' in mod && (mod as ElectronApi).app ? mod as ElectronApi : undefined;
  } catch { return undefined; }
}

function coreLifecycle(): number | null {
  try {
    if (typeof __dirname !== 'string') return null;
    const core = createRequire(__filename)(join(__dirname, 'core-client.cjs')) as { CODEX_RUN_LIFECYCLE_VERSION?: unknown };
    return typeof core.CODEX_RUN_LIFECYCLE_VERSION === 'number' ? core.CODEX_RUN_LIFECYCLE_VERSION : null;
  } catch { return null; }
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
  try { chmodSync(path, 0o600); } catch { /* filesystems without modes */ }
}

const ENTRY_BUDGET = 25_000;
/** Size of a file or tree. Symlinks count as themselves and are never followed; walks stop after ENTRY_BUDGET entries. */
async function usage(path: string): Promise<{ bytes: number; files: number; truncated: boolean }> {
  let bytes = 0, files = 0, seen = 0;
  const stack = [path];
  while (stack.length) {
    if (++seen > ENTRY_BUDGET) return { bytes, files, truncated: true };
    const current = stack.pop()!;
    const info = await fs.lstat(current).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) { for (const name of await fs.readdir(current).catch(() => [] as string[])) stack.push(join(current, name)); continue; }
    bytes += info.size; files++;
  }
  return { bytes, files, truncated: false };
}

const LABELS: Record<StorageCategoryId, string> = { attachments: 'Attachments', scratch: 'Chat scratch folders', 'scoped-computers': 'Scoped computers', memory: 'Memory', sqlite: 'Chat history database', worktrees: 'Git worktrees', logs: 'Logs', other: 'Other app data' };
export function storageCategoryOf(name: string): StorageCategoryId {
  if (name === 'attachments' || name === 'scratch' || name === 'scoped-computers' || name === 'worktrees' || name === 'logs') return name;
  if (name === 'memory' || name === 'workspace-memory' || name === '.muster' || name === 'memory-config.json') return 'memory';
  if (/\.sqlite(-wal|-shm|-journal)?$/.test(name)) return 'sqlite';
  return 'other';
}

const identity = (): { home: string; user?: string } => { try { return { home: homedir(), user: userInfo().username }; } catch { return { home: homedir() }; } };
const LOG_LIMIT = 1024 * 1024;
const MAX_BACKUPS = 10;
const FRESH_MS = 10 * 60_000;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Settings domain: whitelisted preferences in dataDir/settings.json, diagnostics, storage usage and guarded cleanup. */
export function createSettingsDomain(ctx: DomainContext, electron: ElectronApi | undefined = loadElectron()): DomainModule {
  const file = () => join(ctx.dataDir, 'settings.json');
  const logPath = () => join(ctx.dataDir, 'logs', 'runtime.log');
  const log = (line: string) => {
    try {
      const path = logPath();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try { if (statSync(path).size > LOG_LIMIT) renameSync(path, `${path}.1`); } catch { /* first write */ }
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch { /* logging never breaks a command */ }
  };
  let cached: AppSettings | undefined;
  const read = (): AppSettings => {
    if (cached) return cached;
    let raw: unknown;
    try { raw = (JSON.parse(readFileSync(file(), 'utf8')) as { values?: unknown }).values; } catch { raw = undefined; }
    return cached = normalizeSettings(raw);
  };
  const zoom = () => read()['appearance.textSize'] / 100;
  const applyZoom = (win: Win) => { try { if (!win.isDestroyed()) win.webContents.setZoomFactor(zoom()); } catch { /* window closing */ } };
  const watch = (win: Win) => { win.webContents.on('did-finish-load', () => applyZoom(win)); applyZoom(win); };
  const onWindow = (_event: unknown, win: Win) => watch(win);
  const write = (values: AppSettings): AppSettings => {
    const previous = read();
    writeAtomic(file(), JSON.stringify({ version: 1, values }, null, 2));
    const zoomChanged = values['appearance.textSize'] !== previous['appearance.textSize'];
    const defaultChanged = JSON.stringify(values['general.defaultModel']) !== JSON.stringify(previous['general.defaultModel']);
    cached = values;
    if (zoomChanged) for (const win of electron?.BrowserWindow.getAllWindows() ?? []) applyZoom(win);
    ctx.emit({ type: 'settingsChanged', values });
    if (defaultChanged) ctx.emit({ type: 'chatDefaultsChanged' });
    return values;
  };

  // Project defaults live beside settings.json (not in it): they are per-Project, never exported, and survive Reset.
  const projectFile = () => join(ctx.dataDir, 'project-model-defaults.json');
  let projectCache: Record<string, ModelPreference> | undefined;
  const projectDefaults = (): Record<string, ModelPreference> => {
    if (projectCache) return projectCache;
    const next: Record<string, ModelPreference> = Object.create(null);
    try {
      const raw = (JSON.parse(readFileSync(projectFile(), 'utf8')) as { projects?: unknown }).projects;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [key, value] of Object.entries(raw)) if (PROJECT_ID.test(key) && isModelPreference(value)) next[key] = value;
    } catch { /* no project defaults yet */ }
    return projectCache = next;
  };
  const projectStore = () => ctx.store as { project?(id: string): { folderIds?: string[] } | undefined } | undefined;
  /** Defaults of deleted Projects are dropped (and the file rewritten) the next time the map is read, so a
   *  deleted Project leaves nothing behind. Without a store to ask (bare tests) nothing is pruned. */
  const livingProjectDefaults = (): Record<string, ModelPreference> => {
    const all = projectDefaults(), store = projectStore();
    if (typeof store?.project !== 'function') return all;
    const orphans = Object.keys(all).filter(id => !store.project!(id));
    if (!orphans.length) return all;
    const next: Record<string, ModelPreference> = Object.assign(Object.create(null) as Record<string, ModelPreference>, all);
    for (const id of orphans) delete next[id];
    try { writeAtomic(projectFile(), JSON.stringify({ version: 1, projects: next }, null, 2)); } catch { /* retried on the next read */ }
    return projectCache = next;
  };
  const projectDefault = (id: string): ModelPreference | undefined => { const all = livingProjectDefaults(); return Object.hasOwn(all, id) ? all[id] : undefined; };
  /** A chat started in a folder belongs to the one Project that folder is attached to (with a default of its own);
   *  a folder shared by several Projects is ambiguous, so none of them wins. */
  const projectForFolder = (folderId: string): string | undefined => {
    const store = projectStore();
    if (typeof store?.project !== 'function') return undefined;
    const owners = Object.keys(livingProjectDefaults()).filter(id => store.project!(id)?.folderIds?.includes(folderId));
    return owners.length === 1 ? owners[0] : undefined;
  };
  const projectId = (value: unknown): string => {
    if (typeof value !== 'string' || !PROJECT_ID.test(value)) throw new Error('Choose a project.');
    const store = ctx.store as { project?(id: string): unknown } | undefined;
    if (typeof store?.project === 'function' && !store.project(value)) throw new Error('Project not found.');
    return value;
  };
  // CMP-23: folder defaults live beside the Project ones (same rules: never exported, survive Reset, dropped with the folder).
  const folderFile = () => join(ctx.dataDir, 'folder-model-defaults.json');
  let folderCache: Record<string, ModelPreference> | undefined;
  const folderExists = (id: string) => { const store = ctx.store as { folder?(id: string): unknown } | undefined; return typeof store?.folder !== 'function' || Boolean(store.folder(id)); };
  const folderDefaults = (): Record<string, ModelPreference> => {
    if (!folderCache) {
      const next: Record<string, ModelPreference> = Object.create(null);
      try {
        const raw = (JSON.parse(readFileSync(folderFile(), 'utf8')) as { folders?: unknown }).folders;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [key, value] of Object.entries(raw)) if (PROJECT_ID.test(key) && isModelPreference(value)) next[key] = value;
      } catch { /* no folder defaults yet */ }
      folderCache = next;
    }
    const orphans = Object.keys(folderCache).filter(id => !folderExists(id));
    if (!orphans.length) return folderCache;
    const next: Record<string, ModelPreference> = Object.assign(Object.create(null) as Record<string, ModelPreference>, folderCache);
    for (const id of orphans) delete next[id];
    try { writeAtomic(folderFile(), JSON.stringify({ version: 1, folders: next }, null, 2)); } catch { /* retried on the next read */ }
    return folderCache = next;
  };
  const folderDefault = (id: string): ModelPreference | undefined => { const all = folderDefaults(); return Object.hasOwn(all, id) ? all[id] : undefined; };
  const folderId = (value: unknown): string => {
    if (typeof value !== 'string' || !PROJECT_ID.test(value)) throw new Error('Choose a folder.');
    if (!folderExists(value)) throw new Error('Folder not found.');
    return value;
  };
  /** Project default → folder default → user default → built-in; a level whose provider or model is no longer ready is skipped. */
  const resolveDefaults = (input: { folderId?: string; projectId?: string }): ResolvedChatDefaults => {
    const catalog = ctx.modelCatalog?.() ?? { providers: [], builtin: { providerId: '', model: '' } };
    livingProjectDefaults(); // drops defaults of Projects deleted since the last read
    const projectId = input.projectId ?? (input.folderId ? projectForFolder(input.folderId) : undefined);
    const project = projectId ? projectDefault(projectId) : undefined;
    const folder = input.folderId ? folderDefault(input.folderId) : undefined;
    return resolveChatDefaults({ project, folder, user: read()['general.defaultModel'], providers: catalog.providers, builtin: catalog.builtin });
  };
  // Built-in results add nothing: chat.create keeps its own fallback, exactly as before defaults existed.
  ctx.hooks?.setChatDefaults(input => {
    const resolved = resolveDefaults(input);
    return resolved.source === 'runtime' ? undefined : { providerId: resolved.providerId, model: resolved.model, ...(resolved.effort ? { effort: resolved.effort } : {}) };
  });
  if (ctx.dataDir) {
    log(`runtime started · pid ${process.pid} · node ${process.versions.node}${process.versions.electron ? ` · electron ${process.versions.electron}` : ''}`);
    if (electron) { electron.app.on('browser-window-created', onWindow); for (const win of electron.BrowserWindow.getAllWindows()) watch(win); }
  }
  const window = () => electron?.BrowserWindow.getFocusedWindow() ?? undefined;
  const need = () => { if (!electron) throw new Error('This action needs the desktop app.'); return electron; };

  const categoryRoot = (category: CleanableCategory) => join(ctx.dataDir, category);
  /** Null when the index cannot be read: then nothing in that chat is offered. */
  const known = (chatId: string): Set<string> | null => {
    try { return new Set((ctx.db().prepare('SELECT path FROM attachments WHERE chat_id = ?').all(chatId) as Array<{ path: string }>).map(row => row.path)); }
    catch { return null; }
  };
  /** Only scratch folders of deleted chats and attachment files no chat references are ever offered. */
  async function preview(category: CleanableCategory): Promise<CleanupPreview> {
    const root = categoryRoot(category), items: CleanupItem[] = [];
    const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of dirs) {
      if (items.length >= 500) break;
      const path = join(root, entry.name), chat = ctx.store.chat(entry.name);
      if (!chat) { items.push({ name: entry.name, bytes: (await usage(path)).bytes, reason: 'Chat no longer exists' }); continue; }
      if (category !== 'attachments' || !entry.isDirectory()) continue;
      const referenced = known(entry.name);
      if (!referenced) continue;
      for (const child of await fs.readdir(path, { withFileTypes: true }).catch(() => [])) {
        const full = join(path, child.name);
        if (referenced.has(full)) continue;
        // A file written moments ago may be a staging upload whose row is not committed yet.
        const info = await fs.lstat(full).catch(() => null);
        if (info && Date.now() - info.mtimeMs > FRESH_MS) items.push({ name: `${entry.name}/${child.name}`, bytes: (await usage(full)).bytes, reason: 'Discarded attachment' });
      }
    }
    return { category, items, bytes: items.reduce((sum, item) => sum + item.bytes, 0) };
  }
  const category = (value: unknown): CleanableCategory => { if (value === 'attachments' || value === 'scratch') return value; throw new Error('Only attachments and scratch folders can be cleaned up.'); };
  const values = (keys: unknown): SettingKey[] => {
    if (keys === undefined) return SETTING_KEYS;
    if (!Array.isArray(keys) || keys.length > SETTING_KEYS.length || !keys.every(isSettingKey)) throw new Error('Choose settings to reset.');
    return keys as SettingKey[];
  };

  return {
    handlers: {
      'settings.get': () => ({ values: read() }),
      'settings.terminalShells': () => ({ shells: availableShells(), selected: resolveTerminalShell(read()['terminal.shell'], loginShell) }),
      'settings.set': input => {
        const key = input.key as SettingKey, value = validateSetting(key, input.value);
        const current = read();
        return { values: current[key] === value ? current : write({ ...current, [key]: value }) };
      },
      'settings.reset': input => {
        const next = { ...read() } as Record<SettingKey, unknown>;
        for (const key of values(input.keys)) next[key] = SETTING_DEFAULTS[key];
        return { values: write(next as unknown as AppSettings) };
      },
      'settings.export': async () => {
        const api = need();
        const result = await api.dialog.showSaveDialog(window(), { title: 'Export settings', defaultPath: join(api.app.getPath('documents'), 'muster-settings.json'), filters: [{ name: 'Muster settings', extensions: ['json'] }] });
        if (result.canceled || !result.filePath) return { path: null };
        await fs.writeFile(result.filePath, `${JSON.stringify(settingsExport(read()), null, 2)}\n`, { mode: 0o600 });
        log(`settings exported to ${basename(result.filePath)}`);
        return { path: result.filePath };
      },
      'settings.import': async () => {
        const api = need();
        const result = await api.dialog.showOpenDialog(window(), { title: 'Import settings', properties: ['openFile'], filters: [{ name: 'Muster settings', extensions: ['json'] }] });
        const path = result.filePaths?.[0];
        if (result.canceled || !path) return { cancelled: true };
        return importSettings(path);
      },
      'settings.diagnostics': (): DiagnosticsReport => {
        let processes: ProcessMetric[] = [];
        try { processes = (electron?.app.getAppMetrics() ?? []).map(metric => ({ pid: metric.pid, type: metric.type, ...(metric.serviceName || metric.name ? { name: metric.serviceName || metric.name } : {}), memoryKB: metric.memory.workingSetSize, cpuPercent: metric.cpu.percentCPUUsage })); } catch { processes = []; }
        const report = {
          collectedAt: new Date().toISOString(),
          app: { name: electron?.app.getName() ?? 'Muster Agent', version: electron?.app.getVersion() ?? 'development' },
          electron: process.versions.electron ?? null, chrome: process.versions.chrome ?? null, node: process.versions.node,
          platform: process.platform, arch: arch(), osRelease: release(),
          coreLifecycle: coreLifecycle(), dataDir: ctx.dataDir, logPath: logPath(), uptimeSeconds: process.uptime(), processes,
        };
        const { home, user } = identity();
        return { ...report, redactedText: redactDiagnostics(diagnosticsText(report), home, user) };
      },
      'settings.reveal': input => {
        const api = need();
        if (input.target === 'log') { log('log revealed'); api.shell.showItemInFolder(logPath()); }
        else if (input.target === 'dataDir') api.shell.showItemInFolder(join(ctx.dataDir, 'settings.json'));
        else throw new Error('Unknown location.');
      },
      'settings.storage': async (): Promise<StorageReport> => {
        const totals = new Map<StorageCategoryId, StorageCategory>();
        for (const name of await fs.readdir(ctx.dataDir).catch(() => [] as string[])) {
          const id = storageCategoryOf(name), size = await usage(join(ctx.dataDir, name));
          const row = totals.get(id) ?? { id, label: LABELS[id], bytes: 0, files: 0, truncated: false, cleanable: id === 'attachments' || id === 'scratch' };
          totals.set(id, { ...row, bytes: row.bytes + size.bytes, files: row.files + size.files, truncated: row.truncated || size.truncated });
        }
        const categories = [...totals.values()].sort((a, b) => b.bytes - a.bytes);
        return { dataDir: ctx.dataDir, total: categories.reduce((sum, row) => sum + row.bytes, 0), categories };
      },
      'settings.storage.preview': input => preview(category(input.category)),
      'settings.projectModel.get': input => ({ value: projectDefault(projectId(input.projectId)) ?? null }),
      'settings.projectModel.set': input => {
        const id = projectId(input.projectId), value = input.value ?? null;
        if (value !== null && !isModelPreference(value)) throw new Error('Choose a provider and model.');
        // Null-prototype like the loaded map, so an id such as `constructor` or `__proto__` is just a key.
        const next: Record<string, ModelPreference> = Object.assign(Object.create(null) as Record<string, ModelPreference>, livingProjectDefaults());
        if (value) next[id] = { providerId: value.providerId, model: value.model.trim(), ...(value.effort ? { effort: value.effort } : {}) }; else delete next[id];
        writeAtomic(projectFile(), JSON.stringify({ version: 1, projects: next }, null, 2));
        projectCache = next;
        ctx.emit({ type: 'chatDefaultsChanged', projectId: id });
        return { value: Object.hasOwn(next, id) ? next[id]! : null };
      },
      'settings.folderModel.get': input => ({ value: folderDefault(folderId(input.folderId)) ?? null }),
      'settings.folderModel.set': input => {
        const id = folderId(input.folderId), value = input.value ?? null;
        if (value !== null && !isModelPreference(value)) throw new Error('Choose a provider and model.');
        const next: Record<string, ModelPreference> = Object.assign(Object.create(null) as Record<string, ModelPreference>, folderDefaults());
        if (value) next[id] = { providerId: value.providerId, model: value.model.trim(), ...(value.effort ? { effort: value.effort } : {}) }; else delete next[id];
        writeAtomic(folderFile(), JSON.stringify({ version: 1, folders: next }, null, 2));
        folderCache = next;
        ctx.emit({ type: 'chatDefaultsChanged', folderId: id });
        return { value: Object.hasOwn(next, id) ? next[id]! : null };
      },
      'chat.defaults': async input => {
        const folderId = typeof input.folderId === 'string' ? input.folderId : undefined, project = typeof input.projectId === 'string' && PROJECT_ID.test(input.projectId) ? input.projectId : undefined;
        // Right after launch providers are still being probed and none reads as available yet; wait briefly for
        // the first probe so a new chat doesn't fall back to the built-in model just because it was early.
        await ctx.modelCatalogReady?.();
        return resolveDefaults({ ...(folderId ? { folderId } : {}), ...(project ? { projectId: project } : {}) });
      },
      'settings.storage.cleanup': async input => {
        if (input.confirm !== true) throw new Error('Confirm the cleanup first.');
        const which = category(input.category), names = input.names;
        if (!Array.isArray(names) || names.length > 500 || !names.every(name => typeof name === 'string')) throw new Error('Choose items to remove.');
        // Re-check eligibility now: a chat restored or a file staged since the preview is kept.
        const eligible = new Map((await preview(which)).items.map(item => [item.name, item]));
        const root = categoryRoot(which);
        let removed = 0, bytes = 0;
        for (const name of new Set(names as string[])) {
          const item = eligible.get(name), path = join(root, name);
          if (!item || !path.startsWith(root + sep)) continue;
          await fs.rm(path, { recursive: true, force: true });
          removed++; bytes += item.bytes;
        }
        log(`storage cleanup · ${which} · removed ${removed} item(s), ${bytes} bytes`);
        return { removed, bytes };
      },
    },
    dispose() { electron?.app.off('browser-window-created', onWindow); ctx.hooks?.setChatDefaults(undefined); },
  };

  async function importSettings(path: string) {
    const info = await fs.stat(path);
    if (!info.isFile() || info.size > MAX_SETTINGS_IMPORT_BYTES) throw new Error('Choose a settings file under 64 KB.');
    const parsed = parseSettingsImport(await fs.readFile(path, 'utf8'));
    const current = read();
    const backupDir = join(ctx.dataDir, 'settings-backups');
    const backupPath = join(backupDir, `settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeAtomic(backupPath, JSON.stringify(settingsExport(current), null, 2));
    const old = (await fs.readdir(backupDir).catch(() => [] as string[])).filter(name => /^settings-.*\.json$/.test(name)).sort();
    for (const name of old.slice(0, Math.max(0, old.length - MAX_BACKUPS))) await fs.rm(join(backupDir, name), { force: true });
    const next = write({ ...current, ...parsed.settings });
    log(`settings imported · ${Object.keys(parsed.settings).length} applied · backup ${basename(backupPath)}`);
    return { cancelled: false as const, values: next, applied: Object.keys(parsed.settings) as SettingKey[], ignored: parsed.ignored, backupPath };
  }
}

