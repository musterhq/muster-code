import type {Chat, ChatPermissionMode} from '../shared/protocol.ts';

/** A task may span many provider turns. Its durable lifetime belongs to the
 * service; core budget support must be feature-detected before dispatch. */
export interface ProviderBudgets {
  idleMs?: number;
  requestMs?: number;
  turnMs?: number;
  taskMs?: number;
}
/** The largest budget the core accepts (≈24.8 days): effectively no limit. */
export const UNLIMITED_MS = 2_147_483_647;
/** Agent Mode never cuts a turn off: no absolute turn ceiling and no silence
 * watchdog (long, quiet builds and subagent waits are normal). A run ends when it
 * finishes or the user stops it. Only individual RPC requests keep a timeout. */
export const DEFAULT_AGENT_PROVIDER_BUDGETS = Object.freeze({
  idleMs: UNLIMITED_MS,
  requestMs: 30_000,
  turnMs: UNLIMITED_MS,
});
/** Ceiling the core applies when budgets are unsupported: max(idle*8, 15min) with its legacy 180s idle default. */
export const LEGACY_CORE_TURN_CEILING_MS = Math.max(180_000 * 8, 15 * 60_000);
/** One line that states which ceiling a turn really runs under; for logs and diagnostics. */
export function lifecycleDiagnostic(lifecycleSupported: boolean): string {
  const minutes = (ms: number) => `${Math.round(ms / 60_000)}m`;
  if (lifecycleSupported) return `Core run lifecycle v1: no turn or idle cutoff (runs end when finished or stopped); request timeout ${Math.round(DEFAULT_AGENT_PROVIDER_BUDGETS.requestMs / 1000)}s; cancellation is native.`;
  return `Bundled core has no CODEX_RUN_LIFECYCLE_VERSION: only the idle timeout is honoured and every turn is killed at the legacy ceiling of ${LEGACY_CORE_TURN_CEILING_MS}ms (${minutes(LEGACY_CORE_TURN_CEILING_MS)}). Rebuild dist/runtime/core-client.cjs with MUSTER_CORE_CLIENT_ENTRY pointing at a lifecycle-aware core.`;
}
export function coreBudgetOptions(budgets?: ProviderBudgets, lifecycleSupported = false): { timeoutMs?: number; budgets?: Omit<ProviderBudgets, 'taskMs'> } {
  for (const [name, value] of Object.entries(budgets ?? {})) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`Provider ${name} must be a positive finite millisecond budget no greater than 2147483647.`);
    }
    if (name === 'taskMs' || !['idleMs', 'requestMs', 'turnMs'].includes(name) || (!lifecycleSupported && name !== 'idleMs')) throw new Error(`Independent provider ${name} is unsupported by the bundled core. No turn was started.`);
  }
  if (lifecycleSupported) return {budgets: {
    idleMs: budgets?.idleMs ?? DEFAULT_AGENT_PROVIDER_BUDGETS.idleMs,
    requestMs: budgets?.requestMs ?? DEFAULT_AGENT_PROVIDER_BUDGETS.requestMs,
    turnMs: budgets?.turnMs ?? DEFAULT_AGENT_PROVIDER_BUDGETS.turnMs,
  }};
  return budgets?.idleMs === undefined ? {} : { timeoutMs: budgets.idleMs };
}

export interface ProviderRecovery {
  kind: 'admission-rejected' | 'recovery-needed' | 'failed' | 'cancelled';
  /** Advisory only. This adapter never resends a prompt automatically. */
  retryable: boolean;
  reason: string;
}
export interface DispatchResult {
  status: 'completed' | 'failed';
  errorMessage?: string;
  dispatchState?: 'not-dispatched' | 'dispatched' | 'unknown';
  turnId?: string;
  failure?: {statusCode?: number};
}
export function classifyProviderFailure(result: DispatchResult, evidence: { activity: boolean; terminal: boolean; cancelled: boolean; resetEta?: string }): ProviderRecovery | undefined {
  const definitelyNotDispatched = result.dispatchState === 'not-dispatched' && !result.turnId && !evidence.activity;
  // A user Stop is a normal ending, never a failure. The native app-server is
  // local and owned by this chat: once it is interrupted (or closed after the
  // grace period) nothing keeps running for this turn, so the chat settles idle
  // and the composer stays usable (F42/F43).
  if (evidence.cancelled) return {
    kind: 'cancelled', retryable: false,
    reason: definitelyNotDispatched || evidence.terminal ? 'Stopped. This attempt will not resume automatically.' : 'Stopped. The provider process for this turn was shut down.',
  };
  if (result.status !== 'failed') return undefined;
  if (!definitelyNotDispatched && !evidence.terminal) return {
    kind: 'recovery-needed', retryable: false,
    reason: 'The provider may have accepted this turn. Inspect the existing thread before continuing; the prompt was not resent.',
  };
  if (definitelyNotDispatched && ([503, 429].includes(result.failure?.statusCode ?? 0) || /(?:\b(?:503|429)\b|chat admission capacity is temporarily unavailable)/i.test(result.errorMessage ?? ''))) return {
    kind: 'admission-rejected', retryable: true,
    reason: `Provider admission is temporarily unavailable. No turn was dispatched; retry manually later.${evidence.resetEta ? ` ${evidence.resetEta}` : ''}`,
  };
  // Keep the provider's own words: a generic sentence hid the real cause (F19/F45/F55).
  // A turn that provably never dispatched is safe to resend, so it is retryable.
  const detail = (result.errorMessage ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
  return { kind: 'failed', retryable: definitelyNotDispatched, reason: detail ? `The provider attempt failed: ${detail}` : 'The provider attempt failed.' };
}

/** Resolves a pending host approval as declined on cancellation and always
 * removes the listener. A late host answer cannot approve cancelled work. */
export async function requestWhileOwned<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let release = () => {};
  const cancelled = new Promise<undefined>(resolve => {
    const listener = () => resolve(undefined);
    signal.addEventListener('abort', listener, { once: true });
    release = () => signal.removeEventListener('abort', listener);
  });
  try {
    const response = await Promise.race([Promise.resolve().then(() => signal.aborted ? undefined : request()), cancelled]);
    return signal.aborted ? undefined : response;
  } finally { release(); }
}


/** Stored access is independent of conversation mode. Ask/Plan always clamp
 * effective privileges, including a saved Full selection for future Agent turns. */
export function providerAccessPolicy(chat: Pick<Chat, 'mode' | 'permissionMode'>): {
  permissionMode: ChatPermissionMode;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'never' | 'on-request' | 'untrusted';
  networkAccess: boolean;
} {
  if (chat.permissionMode !== undefined && !['read-only', 'workspace', 'full'].includes(chat.permissionMode)) throw new Error('Invalid chat access policy.');
  const permissionMode = chat.mode === 'agent' ? chat.permissionMode ?? 'workspace' : 'read-only';
  return {
    permissionMode,
    sandbox: permissionMode === 'full' ? 'danger-full-access' : permissionMode === 'workspace' ? 'workspace-write' : 'read-only',
    // R5: Full still asks (and Muster auto-accepts) so a command that would stop the user's own processes can be held for approval.
    approvalPolicy: permissionMode === 'workspace' ? 'on-request' : permissionMode === 'full' ? 'untrusted' : 'never',
    networkAccess: permissionMode === 'full',
  };
}
