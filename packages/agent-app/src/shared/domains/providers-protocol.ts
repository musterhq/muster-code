/** Providers domain contract. Add commands here; the allowlist and service dispatch pick them up. */
/** Where a provider stops working, in the order it is checked. 'ok' means every local check passed. */
export type ProviderStage = 'ok' | 'executable-missing' | 'profile-invalid' | 'catalog-unreadable' | 'auth-missing' | 'auth-expired' | 'transport';
export interface ProviderDiagnosis {
  id: string; stage: ProviderStage; summary: string; hint?: string;
  /** A shell command that fixes the stage (e.g. `codex login`); the UI can prefill it in a terminal. */
  command?: string;
  /** `<cli> --version`, cached per executable; null when it could not be read. */
  version: string | null;
  checkedAt: string;
  /** Redacted plain-text report for "Copy diagnostics": no tokens, emails or home paths. */
  diagnostics: string;
}
export interface ProviderUsageWindow { usedPercent: number; windowMinutes: number | null; resetsAt: string | null }
/** Codex rate-limit windows. 'live' comes from app-server events this session; 'session-log' from the newest Codex session file. */
export interface ProviderUsage { providerId: string; primary: ProviderUsageWindow | null; secondary: ProviderUsageWindow | null; planType?: string; source: 'live' | 'session-log'; updatedAt: string }
/** The stored key itself never crosses into the renderer. */
export interface ProviderSecretStatus { stored: boolean; updatedAt: string | null; secureStorage: boolean }
/** PRO-11: provider CLIs Muster can keep up to date as managed installs. */
export type CliTool = 'codex' | 'claude' | 'opencode';
export interface CliStatus {
  tool: CliTool; label: string; package: string;
  /** The binary runs would use now: the managed copy when one is active, else the user's own install. */
  installed: { path: string | null; version: string | null; managed: boolean };
  /** Newest published version from the last check; null before any check. */
  latest: string | null; checkedAt: string | null; updateAvailable: boolean;
  managed: { current: string | null; previous: string | null; versions: string[] };
  /** An update requested while chats were running; applied when the last run settles. */
  pending: { version: string; requestedAt: string } | null;
  activeSessions: number; busy: boolean;
  /** Managed installs only. `rollbackTarget` names what a rollback returns to. */
  canRollback: boolean; rollbackTarget: string | null;
  lastError?: string;
}
/** PRO-X2: one Codex sign-in (CODEX_HOME). `default` is the home new chats use unless a default model names another account. */
export interface ProviderAccountRow {
  /** 'default' for the main CODEX_HOME, else the 10-hex account hash used in provider ids (`<id>_<hash>`). */
  id: string; label: string;
  /** Provider ids this account contributes: its ChatGPT route and any gateway its Codex config names. */
  providerIds: string[];
  ready: boolean; removable: boolean;
}
/** The account whose provider new chats use: the one listing `providerId`, else the default sign-in. */
export function activeAccountId(accounts: readonly ProviderAccountRow[], providerId: string | undefined): string {
  return accounts.find(account => providerId && account.providerIds.includes(providerId))?.id ?? 'default';
}
/** Switching accounts keeps the same route (same id without its account suffix) when the target account has it, else its ChatGPT route, else its first route. */
export function accountProviderId(target: ProviderAccountRow, currentProviderId: string | undefined): string | undefined {
  const base = (currentProviderId ?? '').replace(/_[0-9a-f]{10}$/, '') || 'openai-direct';
  const suffix = target.id === 'default' ? '' : `_${target.id}`;
  return [`${base}${suffix}`, `openai-direct${suffix}`].find(id => target.providerIds.includes(id)) ?? target.providerIds[0];
}
export interface CliUpdateResult { outcome: 'updated' | 'deferred' | 'failed'; status: CliStatus }
export interface ProvidersCommands {
  'providers.secret.set': { input: { providerId: string; value: string }; output: ProviderSecretStatus };
  'providers.secret.clear': { input: { providerId: string }; output: ProviderSecretStatus };
  'providers.secret.status': { input: { providerId: string }; output: ProviderSecretStatus };
  'providers.diagnose': { input: { id: string }; output: ProviderDiagnosis };
  /** The account email for a masked identity field, read only on reveal. */
  'providers.identity': { input: { id: string }; output: { identity: string } };
  'providers.usage': { input: { id?: string }; output: ProviderUsage[] };
  /** True while any Muster window is being captured, so secret entry can warn. */
  'providers.captureStatus': { input: undefined; output: { captured: boolean } };
  'providers.cli.status': { input: Record<string, never>; output: CliStatus[] };
  /** Asks the npm registry for the newest published version (no provider or model call). */
  'providers.cli.check': { input: { tool: CliTool }; output: CliStatus };
  /** Installs the version (default: latest) as a managed copy now, or defers it while any chat is running. */
  'providers.cli.update': { input: { tool: CliTool; version?: string }; output: CliUpdateResult };
  /** Managed installs only: back to the previous managed version, or to the user's own install. Refused while chats run. */
  'providers.cli.rollback': { input: { tool: CliTool }; output: CliStatus };
  'providers.cli.cancel': { input: { tool: CliTool }; output: CliStatus };
  /** PRO-X2: every Codex sign-in Muster knows about. Paths never cross into the renderer. */
  'providers.accounts.list': { input: Record<string, never>; output: { accounts: ProviderAccountRow[] } };
  /** Adds (or relabels) an extra CODEX_HOME. The folder must already hold a Codex sign-in or profile. */
  'providers.accounts.add': { input: { codexHome: string; label?: string }; output: { accounts: ProviderAccountRow[] } };
  'providers.accounts.remove': { input: { id: string }; output: { accounts: ProviderAccountRow[] } };
}
export type ProvidersEvent = { type: 'providerUsage'; usage: ProviderUsage } | { type: 'providerCliChanged'; status: CliStatus };
export const PROVIDERS_COMMANDS = {'providers.secret.set': true, 'providers.secret.clear': true, 'providers.secret.status': true, 'providers.diagnose': true, 'providers.identity': true, 'providers.usage': true, 'providers.captureStatus': true, 'providers.cli.status': true, 'providers.cli.check': true, 'providers.cli.update': true, 'providers.cli.rollback': true, 'providers.cli.cancel': true, 'providers.accounts.list': true, 'providers.accounts.add': true, 'providers.accounts.remove': true} as const satisfies Record<keyof ProvidersCommands, true>;
