/** Setup domain contract (R9): the guided first run and the Settings › General "Setup checklist". Detection only;
 *  nothing here signs in, installs or prompts for a macOS permission. */
import type { ProviderInfo } from '../protocol.ts';
import type { CliTool } from './providers-protocol.ts';
import { plural } from '../wording.ts';

/** The guided first-run steps, in order. */
export const SETUP_STEPS = ['welcome', 'connect', 'folder', 'capabilities', 'done'] as const;
export type SetupStep = typeof SETUP_STEPS[number];
export const isSetupStep = (value: unknown): value is SetupStep => typeof value === 'string' && (SETUP_STEPS as readonly string[]).includes(value);

/** One provider CLI as the first run sees it. `ready` means Muster lists a runnable provider for it right now. */
export interface SetupCli {
  tool: CliTool; label: string;
  installed: boolean; version: string | null; managed: boolean;
  /** A local sign-in was found (a credential file or account metadata). Not a verified entitlement. */
  signedIn: boolean;
  /** True when sign-in may live in the Keychain, so "not signed in" cannot be claimed from files alone. */
  signInUnknown: boolean;
  ready: boolean;
  /** Masked account or credential description; never a token or an unmasked email. */
  account: string;
  /** The exact command `setup.openTerminal` would type for this CLI's sign-in. */
  loginCommand: string;
  detail: string;
}
/** A connection that is not a CLI sign-in: a gateway from the user's Codex config, a connection added in Muster, an env API key, or a local model server. */
export interface SetupConnection { id: string; name: string; kind: 'gateway' | 'custom' | 'env' | 'local'; ready: boolean; detail: string }
export interface SetupDocker {
  installed: boolean;
  /** null when not installed, or when the check timed out. */
  running: boolean | null;
  version: string | null;
  detail: string;
}
export interface SetupGit { available: boolean; version: string | null; detail: string }
export interface SetupStatus {
  checkedAt: string; platform: string;
  clis: SetupCli[];
  connections: SetupConnection[];
  /** Every provider Muster can run a chat with right now. Empty means "Connect a model to start". */
  /** `cli` names the CLI the provider runs through, so the guide can pair a CLI row with its ready route. */
  readyProviders: { id: string; name: string; cli?: CliTool }[];
  git: SetupGit;
  docker: SetupDocker;
}
/** Persisted so the guide resumes where it stopped, including across restarts. */
export interface SetupProgress {
  step: SetupStep;
  startedAt: string | null;
  completedAt: string | null;
  /** "Set up later": the guide stops opening on launch; Settings › General reopens it. */
  dismissedAt: string | null;
  /** Optional steps passed over with Skip, so the checklist can say so. */
  skipped: SetupStep[];
}
/** R9 automatic detection: pushed at launch, on focus and when a sign-in or profile file changes, with the fresh list. */
export interface ProvidersChange {
  providers: ProviderInfo[];
  /** Providers that became ready since the previous listing; empty on the launch listing. */
  connected: { id: string; name: string; models: number }[];
  reason: 'launch' | 'focus' | 'files';
}
/** What a user calls a provider in a notice: a Codex/OpenAI Direct sign-in is their ChatGPT account. */
export function connectionLabel(provider: { id: string; name: string }): string {
  return /^(openai-direct|codex)(?:_[0-9a-f]{10})?$/.test(provider.id) ? 'ChatGPT' : provider.name;
}
/** "ChatGPT connected · 12 models available"; several at once are joined. */
export function connectedNotice(connected: ProvidersChange['connected']): string {
  return connected.map(row => `${connectionLabel(row)} connected · ${plural(row.models, 'model')} available`).join('; ');
}
/** What the automatic default remembers. `userSetAt`: the user set, changed or reset the default model themselves
 *  (from the UI, a reset or a settings import), after which Muster never picks one again. */
export interface AutoDefaultMemory {
  userSetAt: string | null;
  auto: { appliedAt: string; providerId: string; model: string; /** Sorted ids of the ready providers it was chosen from. */ providers: string } | null;
}
export const readyProviderSet = (providers: readonly ProviderInfo[]): string => providers.filter(provider => provider.available && provider.models.length > 0).map(provider => provider.id).sort().join(',');
/** The default model to set automatically: none is set, the user never chose or reset one, exactly one provider is
 *  ready, and this same set of ready providers has not already had its automatic pick. */
export function automaticDefaultModel(providers: readonly ProviderInfo[], current: unknown, memory?: AutoDefaultMemory | null): { providerId: string; model: string } | null {
  if (current || memory?.userSetAt) return null;
  const ready = providers.filter(provider => provider.available && provider.models.length > 0);
  if (ready.length !== 1 || memory?.auto?.providers === readyProviderSet(providers)) return null;
  return { providerId: ready[0]!.id, model: ready[0]!.models[0]!.id };
}
export type SetupSettingsPane = 'screen' | 'accessibility' | 'notifications';
export interface SetupCommands {
  'setup.status': { input: Record<string, never>; output: SetupStatus };
  /** Re-probe providers now (window focus or resume). Emits `providersChanged` when readiness changed. */
  'setup.refresh': { input: Record<string, never>; output: { providers: ProviderInfo[] } };
  'setup.progress': { input: Record<string, never>; output: SetupProgress };
  'setup.saveProgress': { input: Partial<SetupProgress>; output: SetupProgress };
  /** Types the CLI's sign-in command into a new Terminal window (macOS). The command is fixed per tool, never renderer text. */
  'setup.openTerminal': { input: { tool: CliTool }; output: { opened: boolean; command: string } };
  /** Opens the matching System Settings pane. Never requests the permission itself. */
  'setup.openSystemSettings': { input: { pane: SetupSettingsPane }; output: void };
}
export type SetupEvent = { type: 'setupProgress'; progress: SetupProgress } | ({ type: 'providersChanged' } & ProvidersChange);
export const SETUP_COMMANDS = {'setup.status': true, 'setup.refresh': true, 'setup.progress': true, 'setup.saveProgress': true, 'setup.openTerminal': true, 'setup.openSystemSettings': true} as const satisfies Record<keyof SetupCommands, true>;
