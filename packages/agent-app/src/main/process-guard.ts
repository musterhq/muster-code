/**
 * R3: main-process exception guard. The agent runtime runs inside the main process (service-loader.ts), so a
 * stray throw in a timer or an unawaited promise anywhere in a runtime domain would otherwise take the whole
 * app down with every running chat. This guard logs the fault (secrets and the home path redacted), tells the
 * renderer once per distinct fault, and keeps the app alive — unless the faults arrive as a storm, or the
 * error is one the process cannot survive (out of memory, stack exhaustion in startup), in which case it asks
 * the caller to shut down cleanly instead of limping on.
 *
 * Electron-free and process-injectable so it runs under node:test with a fake process.
 */
import {homedir} from 'node:os';
import {redactSecrets} from '../runtime/secret-redaction.ts';

export type FaultKind = 'uncaughtException' | 'unhandledRejection';

export interface ProcessGuardOptions {
  log: (line: string) => void;
  /** Surface a short notice in the renderer (it is shown as an error notice). */
  notify: (message: string) => void;
  /** Called once when continuing is unsafe; the caller shuts down cleanly. */
  onFatal: (reason: string) => void;
  now?: () => number;
  home?: string;
  /** More than `stormLimit` faults inside `stormWindowMs` is treated as unrecoverable. */
  stormLimit?: number;
  stormWindowMs?: number;
  /** A notice for the same fault text is shown at most once per this interval. */
  noticeIntervalMs?: number;
}

export interface GuardedProcess {
  on(event: 'uncaughtException', listener: (error: unknown) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  off(event: 'uncaughtException', listener: (error: unknown) => void): unknown;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One redacted, single-string description of a fault, safe for logs and notices. */
export function describeFault(error: unknown, home = homedir()): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack.split('\n').slice(1, 8).join('\n')}` : ''}`
    : typeof error === 'string' ? error : (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
  let text = redactSecrets(String(raw ?? 'unknown error'));
  if (home && home.length > 1) text = text.replace(new RegExp(escapeRegExp(home), 'g'), '~');
  return text.slice(0, 4000);
}

/** Errors the process cannot meaningfully continue after. */
export function isFatalFault(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as {code?: unknown}).code;
  if (code === 'ERR_OUT_OF_MEMORY' || code === 'ERR_WORKER_OUT_OF_MEMORY') return true;
  return /\bout of memory\b|allocation failed/i.test(error.message);
}

export function installProcessGuard(proc: GuardedProcess, options: ProcessGuardOptions): {dispose(): void; faults(): number} {
  const now = options.now ?? Date.now;
  const home = options.home ?? homedir();
  const stormLimit = options.stormLimit ?? 25;
  const stormWindowMs = options.stormWindowMs ?? 10_000;
  const noticeIntervalMs = options.noticeIntervalMs ?? 60_000;
  const recent: number[] = [];
  const lastNotice = new Map<string, number>();
  let total = 0;
  let fatal = false;

  const handle = (kind: FaultKind, error: unknown): void => {
    total++;
    const at = now();
    const text = describeFault(error, home);
    try { options.log(`[muster] ${kind}: ${text}`); } catch {}
    if (fatal) return;
    recent.push(at);
    while (recent.length && at - recent[0]! > stormWindowMs) recent.shift();
    if (isFatalFault(error) || recent.length > stormLimit) {
      fatal = true;
      try { options.onFatal(isFatalFault(error) ? 'unrecoverable error' : 'repeated internal errors'); } catch {}
      return;
    }
    const headline = text.split('\n')[0]!.slice(0, 160);
    const seen = lastNotice.get(headline);
    if (seen !== undefined && at - seen < noticeIntervalMs) return;
    lastNotice.set(headline, at);
    if (lastNotice.size > 50) lastNotice.delete(lastNotice.keys().next().value!);
    try { options.notify(`Muster hit an internal error and kept running: ${headline}`); } catch {}
  };
  const onException = (error: unknown): void => handle('uncaughtException', error);
  const onRejection = (reason: unknown): void => handle('unhandledRejection', reason);
  proc.on('uncaughtException', onException);
  proc.on('unhandledRejection', onRejection);
  return {
    dispose() { proc.off('uncaughtException', onException); proc.off('unhandledRejection', onRejection); },
    faults: () => total,
  };
}
