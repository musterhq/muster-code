/** Settings domain contract. Add commands here; the allowlist and service dispatch pick them up. */
import type { ProviderInfo, ReasoningEffort } from '../protocol.ts';
export type SendKey = 'enter' | 'mod-enter';
/** 'system' follows macOS; 'reduce' forces the reduced variant whatever the OS preference. */
export type AccessibilityOverride = 'system' | 'reduce';
/** UX-19: 'system' follows macOS Appearance; the app ships dark by default. */
export type ThemePreference = 'system' | 'dark' | 'light';
export const THEME_PREFERENCES = ['system', 'dark', 'light'] as const;

/** Every persisted preference. Only these keys are accepted, stored, exported or imported; none are secret. */
export interface AppSettings {
  'general.sendKey': SendKey;
  'general.spellcheck': boolean;
  'appearance.theme': ThemePreference;
  'appearance.textSize': number;
  'appearance.reducedMotion': AccessibilityOverride;
  'appearance.reducedTransparency': AccessibilityOverride;
  'chat.inlineDiffs': boolean;
  /** The model new chats start with, unless their Project sets one. Null follows the app's built-in default. */
  'general.defaultModel': ModelPreference | null;
  /** CHAT-16: archive chats idle for this many days (0 = never). Pinned, running, snoozed and needs-attention chats are never auto-archived. */
  'chats.autoArchiveDays': AutoArchiveDays;
  /** AUT-05: OS notifications when a run finishes out of sight. 'failures' keeps only failed runs; 'off' silences them. */
  'notifications.runs': RunNotifications;
  /** AUT-05: dock badge and bounce for approvals and questions waiting on you. */
  'notifications.attention': boolean;
  /** AUT-05: every notification is muted until this ISO time; null when not muted. */
  'notifications.mutedUntil': string | null;
  /** CR-18 Integrated terminal shell for new terminals: 'system' (login shell), a named shell, or an absolute path. */
  'terminal.shell': TerminalShellPreference;
}
/** CR-18: named shells resolve on this machine; any other value is a custom absolute path. */
export const TERMINAL_SHELL_NAMES = ['zsh', 'bash', 'fish'] as const;
export type TerminalShellName = typeof TERMINAL_SHELL_NAMES[number];
export type TerminalShellPreference = 'system' | TerminalShellName | string;
export interface TerminalShellOption { id: TerminalShellName; label: string; path: string }
/** Shape check only (whether the file exists is checked when a terminal starts, which then falls back to the login shell). */
export const isTerminalShellPreference = (value: unknown): value is TerminalShellPreference => typeof value === 'string'
  && (value === 'system' || (TERMINAL_SHELL_NAMES as readonly string[]).includes(value) || (value.startsWith('/') && value.length <= 1024 && !/[\x00-\x1f]/.test(value)));
export type RunNotifications = 'all' | 'failures' | 'off';
export const AUTO_ARCHIVE_DAYS = [0, 7, 14, 30, 60, 90] as const;
export type AutoArchiveDays = typeof AUTO_ARCHIVE_DAYS[number];
/** A provider + model (+ optional reasoning effort) chosen as a default. */
export interface ModelPreference { providerId: string; model: string; effort?: ReasoningEffort }
/** Where a resolved default came from: the chat's Project, the user's General setting, or the runtime's built-in model. */
export type ChatDefaultsSource = 'project' | 'folder' | 'user' | 'runtime';
/** What a new chat will use. `effort` is absent when the model lists no reasoning levels and none was chosen. */
export interface ResolvedChatDefaults { providerId: string; model: string; effort?: ReasoningEffort; source: ChatDefaultsSource }
export type SettingKey = keyof AppSettings;

export const SETTING_DEFAULTS: AppSettings = {
  'general.sendKey': 'enter',
  'general.spellcheck': true,
  'appearance.theme': 'dark',
  'appearance.textSize': 100,
  'appearance.reducedMotion': 'system',
  'appearance.reducedTransparency': 'system',
  'chat.inlineDiffs': true,
  'general.defaultModel': null,
  'chats.autoArchiveDays': 0,
  'notifications.runs': 'all',
  'notifications.attention': true,
  'notifications.mutedUntil': null,
  'terminal.shell': 'system',
};
export const TEXT_SIZES = [90, 100, 110, 120, 130] as const;
export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

const oneOf = <T extends string>(values: readonly T[]) => (value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value);
const bool = (value: unknown): value is boolean => typeof value === 'boolean';
const EFFORT_VALUES: readonly string[] = ['low', 'medium', 'high', 'xhigh'];
const PROVIDER_ID = /^[a-zA-Z0-9_-]{1,128}$/;
/** Shape check only; whether the provider is still ready is decided when a chat is created. */
export function isModelPreference(value: unknown): value is ModelPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => key !== 'providerId' && key !== 'model' && key !== 'effort')) return false;
  return typeof v.providerId === 'string' && PROVIDER_ID.test(v.providerId)
    && typeof v.model === 'string' && v.model.trim().length > 0 && v.model.length <= 256 && !/[\x00-\x1f]/.test(v.model)
    && (v.effort === undefined || (typeof v.effort === 'string' && EFFORT_VALUES.includes(v.effort)));
}
const modelPreference = (value: unknown): value is ModelPreference | null => value === null || isModelPreference(value);
const CHECKS: { [K in SettingKey]: { valid(value: unknown): value is AppSettings[K]; expected: string } } = {
  'general.sendKey': { valid: oneOf<SendKey>(['enter', 'mod-enter']), expected: '"enter" or "mod-enter"' },
  'general.spellcheck': { valid: bool, expected: 'true or false' },
  'appearance.theme': { valid: oneOf<ThemePreference>(THEME_PREFERENCES), expected: '"system", "dark" or "light"' },
  'appearance.textSize': { valid: (value): value is number => typeof value === 'number' && (TEXT_SIZES as readonly number[]).includes(value), expected: `one of ${TEXT_SIZES.join(', ')}` },
  'appearance.reducedMotion': { valid: oneOf<AccessibilityOverride>(['system', 'reduce']), expected: '"system" or "reduce"' },
  'appearance.reducedTransparency': { valid: oneOf<AccessibilityOverride>(['system', 'reduce']), expected: '"system" or "reduce"' },
  'chat.inlineDiffs': { valid: bool, expected: 'true or false' },
  'general.defaultModel': { valid: modelPreference, expected: 'null or {providerId, model, effort?}' },
  'notifications.runs': { valid: oneOf<RunNotifications>(['all', 'failures', 'off']), expected: '"all", "failures" or "off"' },
  'notifications.attention': { valid: bool, expected: 'true or false' },
  'notifications.mutedUntil': { valid: (value): value is string | null => value === null || (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))), expected: 'null or an ISO date-time' },
  'terminal.shell': { valid: isTerminalShellPreference, expected: '"system", "zsh", "bash", "fish" or an absolute path' },
  'chats.autoArchiveDays': { valid: (value): value is AutoArchiveDays => typeof value === 'number' && (AUTO_ARCHIVE_DAYS as readonly number[]).includes(value), expected: `one of ${AUTO_ARCHIVE_DAYS.join(', ')} (days; 0 = never)` },
};

export const isSettingKey = (key: unknown): key is SettingKey => typeof key === 'string' && Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, key);

/** Throws a sentence naming the key and the accepted values. */
export function validateSetting<K extends SettingKey>(key: K | string, value: unknown): AppSettings[K] {
  if (!isSettingKey(key)) throw new Error(`Unknown setting ${JSON.stringify(String(key).slice(0, 64))}.`);
  const check = CHECKS[key];
  if (!check.valid(value)) throw new Error(`${key} must be ${check.expected}.`);
  return value as AppSettings[K];
}

/** Known keys with valid values override defaults; anything else in a stored file is dropped. */
export function normalizeSettings(raw: unknown): AppSettings {
  const next: Record<string, unknown> = { ...SETTING_DEFAULTS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const key of SETTING_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (CHECKS[key].valid(value)) next[key] = value;
  }
  return next as unknown as AppSettings;
}

/** A preference is usable while its provider is ready and still lists the model (a provider with no model list runs only the built-in model). */
function usable(preference: ModelPreference | null | undefined, providers: readonly ProviderInfo[], builtin: { providerId: string; model: string }) {
  if (!preference) return undefined;
  const provider = providers.find(entry => entry.id === preference.providerId && entry.available);
  if (!provider) return undefined;
  const model = provider.models.find(entry => entry.id === preference.model);
  if (!model && !(provider.models.length === 0 && preference.model === builtin.model)) return undefined;
  return { preference, model };
}
function effortFor(model: ProviderInfo['models'][number] | undefined, chosen: ReasoningEffort | undefined): ReasoningEffort | undefined {
  const allowed = model?.efforts ?? (EFFORT_VALUES as ReasoningEffort[]);
  if (chosen && allowed.includes(chosen)) return chosen;
  return model?.defaultEffort && allowed.includes(model.defaultEffort) ? model.defaultEffort : undefined;
}
/** The runtime default when nothing was chosen: the first ready provider and its first model. Empty ids when no
 *  provider is ready on this machine: the UI then shows "Connect a model" instead of assuming any provider. */
export function firstReadyModel(providers: readonly ProviderInfo[]): { providerId: string; model: string } {
  const ready = providers.find(entry => entry.available && entry.models.length) ?? providers.find(entry => entry.available);
  return ready ? { providerId: ready.id, model: ready.models[0]?.id ?? '' } : { providerId: '', model: '' };
}
/** Project default, then folder, then the user default, then the first ready provider (`builtin`). A level whose provider or model is gone is skipped silently. */
export function resolveChatDefaults(input: { project?: ModelPreference | null; folder?: ModelPreference | null; user?: ModelPreference | null; providers: readonly ProviderInfo[]; builtin: { providerId: string; model: string } }): ResolvedChatDefaults {
  for (const [source, preference] of [['project', input.project], ['folder', input.folder], ['user', input.user]] as const) {
    const hit = usable(preference, input.providers, input.builtin);
    if (!hit) continue;
    const effort = effortFor(hit.model, hit.preference.effort);
    return { providerId: hit.preference.providerId, model: hit.preference.model, ...(effort ? { effort } : {}), source };
  }
  const model = input.providers.find(entry => entry.id === input.builtin.providerId)?.models.find(entry => entry.id === input.builtin.model);
  const effort = effortFor(model, undefined);
  return { providerId: input.builtin.providerId, model: input.builtin.model, ...(effort ? { effort } : {}), source: 'runtime' };
}

export const SETTINGS_EXPORT_FORMAT = 'muster-settings';
export interface SettingsExport { format: typeof SETTINGS_EXPORT_FORMAT; version: 1; exportedAt: string; settings: AppSettings }
export const MAX_SETTINGS_IMPORT_BYTES = 64 * 1024;

export function settingsExport(settings: AppSettings, now = new Date()): SettingsExport {
  return { format: SETTINGS_EXPORT_FORMAT, version: 1, exportedAt: now.toISOString(), settings: normalizeSettings(settings) };
}

/** Schema validation for an import: each error names its JSON path. Unknown keys are reported, never applied. */
export function parseSettingsImport(text: string): { settings: Partial<AppSettings>; ignored: string[] } {
  if (text.length > MAX_SETTINGS_IMPORT_BYTES) throw new Error('This settings file is larger than 64 KB.');
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('$: expected a Muster settings export.');
  const root = data as Record<string, unknown>;
  if (root.format !== SETTINGS_EXPORT_FORMAT) throw new Error(`$.format: expected "${SETTINGS_EXPORT_FORMAT}".`);
  if (root.version !== 1) throw new Error('$.version: this app reads version 1 settings exports.');
  const settings = root.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('$.settings: expected an object.');
  const out: Record<string, unknown> = {}, ignored: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (!isSettingKey(key)) { ignored.push(key.slice(0, 64)); continue; }
    try { out[key] = validateSetting(key, value); } catch (error) { throw new Error(`$.settings.${(error as Error).message}`); }
  }
  if (!Object.keys(out).length) throw new Error('$.settings: no recognised settings to import.');
  return { settings: out as Partial<AppSettings>, ignored };
}

export interface ProcessMetric { pid: number; type: string; name?: string; memoryKB: number; cpuPercent: number }
export interface DiagnosticsReport {
  collectedAt: string;
  app: { name: string; version: string };
  electron: string | null; chrome: string | null; node: string;
  platform: string; arch: string; osRelease: string;
  /** CODEX_RUN_LIFECYCLE_VERSION of the bundled core client; null when the bundle lacks it or cannot load. */
  coreLifecycle: number | null;
  dataDir: string; logPath: string;
  uptimeSeconds: number;
  /** Per-process samples from app.getAppMetrics(); empty outside Electron. */
  processes: ProcessMetric[];
  /** diagnosticsText() with the home directory, account name and emails masked; safe to paste into an issue. */
  redactedText: string;
}

/** Masks the home directory, the account name and every email address. */
export function redactDiagnostics(text: string, home: string, user?: string): string {
  let out = text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>');
  if (home && home.length > 1) out = out.split(home).join('~');
  if (user && user.length > 2) out = out.replace(new RegExp(`(?<![\\w.-])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), '<user>');
  return out;
}

export function diagnosticsText(report: Omit<DiagnosticsReport, 'redactedText'>): string {
  const mb = (kb: number) => `${(kb / 1024).toFixed(1)} MB`;
  return [
    `Muster diagnostics · ${report.collectedAt}`,
    `App: ${report.app.name} ${report.app.version}`,
    `Electron: ${report.electron ?? 'n/a'} · Chromium: ${report.chrome ?? 'n/a'} · Node: ${report.node}`,
    `OS: ${report.platform} ${report.osRelease} (${report.arch})`,
    `Bundled core run lifecycle: ${report.coreLifecycle ?? 'missing'}`,
    `Data: ${report.dataDir}`,
    `Log: ${report.logPath}`,
    `Uptime: ${Math.round(report.uptimeSeconds)}s`,
    'Processes:',
    ...report.processes.map(process => `  ${process.type}${process.name ? ` (${process.name})` : ''} pid ${process.pid}: ${mb(process.memoryKB)}, ${process.cpuPercent.toFixed(1)}% CPU`),
  ].join('\n');
}

export type StorageCategoryId = 'attachments' | 'scratch' | 'scoped-computers' | 'memory' | 'sqlite' | 'worktrees' | 'logs' | 'other';
export type CleanableCategory = 'attachments' | 'scratch';
export interface StorageCategory { id: StorageCategoryId; label: string; bytes: number; files: number; truncated: boolean; cleanable: boolean }
export interface StorageReport { dataDir: string; total: number; categories: StorageCategory[] }
/** `name` is relative to the category folder; cleanup removes only names a fresh preview still lists. */
export interface CleanupItem { name: string; bytes: number; reason: string }
export interface CleanupPreview { category: CleanableCategory; items: CleanupItem[]; bytes: number }

export interface SettingsCommands {
  'settings.get': { input: Record<string, never>; output: { values: AppSettings } };
  'settings.set': { input: { key: SettingKey; value: unknown }; output: { values: AppSettings } };
  /** No keys resets everything. */
  'settings.reset': { input: { keys?: SettingKey[] }; output: { values: AppSettings } };
  /** Opens a save dialog and writes the non-secret settings JSON; path is null when cancelled. */
  'settings.export': { input: Record<string, never>; output: { path: string | null } };
  /** Opens a file dialog, validates, backs up the current file, then applies. */
  'settings.import': { input: Record<string, never>; output: { cancelled: true } | { cancelled: false; values: AppSettings; applied: SettingKey[]; ignored: string[]; backupPath: string } };
  'settings.diagnostics': { input: Record<string, never>; output: DiagnosticsReport };
  'settings.reveal': { input: { target: 'dataDir' | 'log' }; output: void };
  'settings.storage': { input: Record<string, never>; output: StorageReport };
  'settings.storage.preview': { input: { category: CleanableCategory }; output: CleanupPreview };
  'settings.storage.cleanup': { input: { category: CleanableCategory; names: string[]; confirm: true }; output: { removed: number; bytes: number } };
  /** The Project's default model for new chats started in it; null when the Project follows the user default. */
  'settings.projectModel.get': { input: { projectId: string }; output: { value: ModelPreference | null } };
  'settings.projectModel.set': { input: { projectId: string; value: ModelPreference | null }; output: { value: ModelPreference | null } };
  /** CMP-23: a folder's default model for new chats started in it; null when the folder follows the user default. */
  'settings.folderModel.get': { input: { folderId: string }; output: { value: ModelPreference | null } };
  'settings.folderModel.set': { input: { folderId: string; value: ModelPreference | null }; output: { value: ModelPreference | null } };
  /** Exactly what chat.create would use for a new chat here: Project default → folder default → user default → built-in, skipping levels whose provider is gone. */
  'chat.defaults': { input: { folderId?: string; projectId?: string }; output: ResolvedChatDefaults };
  /** CR-18: installed shells for the picker, and what the current preference launches (`fallback` explains a missing choice). */
  'settings.terminalShells': { input: Record<string, never>; output: { shells: TerminalShellOption[]; selected: { file: string; fallback?: string } } };
}
/** chatDefaultsChanged fires when the user or a Project default changes; re-query chat.defaults then (provider readiness changes do not fire it). */
export type SettingsEvent = { type: 'settingsChanged'; values: AppSettings } | { type: 'chatDefaultsChanged'; projectId?: string; folderId?: string };
export const SETTINGS_COMMANDS = {
  'settings.get': true, 'settings.set': true, 'settings.reset': true, 'settings.export': true, 'settings.import': true,
  'settings.diagnostics': true, 'settings.reveal': true, 'settings.storage': true, 'settings.storage.preview': true, 'settings.storage.cleanup': true,
  'settings.projectModel.get': true, 'settings.projectModel.set': true, 'settings.folderModel.get': true, 'settings.folderModel.set': true, 'chat.defaults': true, 'settings.terminalShells': true,
} as const satisfies Record<keyof SettingsCommands, true>;
