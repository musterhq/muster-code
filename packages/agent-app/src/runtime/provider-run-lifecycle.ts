import type {Chat, ChatPermissionMode} from '../shared/protocol.ts';

/** A task may span many provider turns. Its durable lifetime belongs to the
 * service; core budget support must be feature-detected before dispatch. */
export interface ProviderBudgets {
  idleMs?: number;
  requestMs?: number;
  turnMs?: number;
  taskMs?: number;
}
/** Agent Mode opts into a finite four-hour turn while preserving the existing
 * three-minute idle watchdog. Other core callers keep their legacy defaults. */
export const DEFAULT_AGENT_PROVIDER_BUDGETS = Object.freeze({
  idleMs: 180_000,
  requestMs: 30_000,
  turnMs: 4 * 60 * 60_000,
});
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
/** Automatic retries are deliberately limited to failures proven not to have
 * created a provider turn. A timeout or an unknown dispatch state must go
 * through reconciliation instead; replaying those prompts could duplicate
 * commands or file edits. */
export const MAX_ADMISSION_RETRIES = 2;
export function shouldRetryAdmission(result: DispatchResult & { recovery?: ProviderRecovery }): boolean {
  return result.status === 'failed'
    && result.dispatchState === 'not-dispatched'
    && !result.turnId
    && result.recovery?.kind === 'admission-rejected'
    && result.recovery.retryable;
}
export function admissionRetryDelayMs(attempt: number, retryAfterMs?: number): number {
  const serverDelay = Number.isSafeInteger(retryAfterMs) && (retryAfterMs ?? 0) > 0 ? retryAfterMs! : 0;
  const exponential = Math.min(4_000, 250 * (2 ** Math.max(0, attempt - 1)));
  return Math.min(4_000, Math.max(100, serverDelay || exponential));
}
export function classifyProviderFailure(result: DispatchResult, evidence: { activity: boolean; terminal: boolean; cancelled: boolean }): ProviderRecovery | undefined {
  const definitelyNotDispatched = result.dispatchState === 'not-dispatched' && !result.turnId && !evidence.activity;
  if (evidence.cancelled) return {
    kind: definitelyNotDispatched || evidence.terminal ? 'cancelled' : 'recovery-needed', retryable: false,
    reason: definitelyNotDispatched || evidence.terminal ? 'Stopped. This attempt will not resume automatically.' : 'Stopped locally. Provider cancellation could not be confirmed; inspect the existing thread before continuing.',
  };
  if (result.status !== 'failed') return undefined;
  if (!definitelyNotDispatched && !evidence.terminal) return {
    kind: 'recovery-needed', retryable: false,
    reason: 'The provider may have accepted this turn. Inspect the existing thread before continuing; the prompt was not resent.',
  };
  if (definitelyNotDispatched && ([503, 429].includes(result.failure?.statusCode ?? 0) || /(?:\b(?:503|429)\b|chat admission capacity is temporarily unavailable)/i.test(result.errorMessage ?? ''))) return {
    kind: 'admission-rejected', retryable: true,
    reason: 'Provider admission is temporarily unavailable. No turn was dispatched; retry manually later.',
  };
  return { kind: 'failed', retryable: false, reason: 'The provider attempt failed. No automatic retry was made.' };
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
  approvalPolicy: 'never' | 'on-request';
  networkAccess: boolean;
} {
  if (chat.permissionMode !== undefined && !['read-only', 'workspace', 'full'].includes(chat.permissionMode)) throw new Error('Invalid chat access policy.');
  const permissionMode = chat.mode === 'agent' ? chat.permissionMode ?? 'workspace' : 'read-only';
  return {
    permissionMode,
    sandbox: permissionMode === 'full' ? 'danger-full-access' : permissionMode === 'workspace' ? 'workspace-write' : 'read-only',
    approvalPolicy: permissionMode === 'workspace' ? 'on-request' : 'never',
    networkAccess: permissionMode === 'full',
  };
}
