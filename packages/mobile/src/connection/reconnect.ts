/** What the app does after its link to the computer fails or closes (#326 security review, MUS-SPEC-23-9B).
 *  A network error, a bad frame (4400) or an offline desktop is retried with backoff; only the desktop's revoked close
 *  (4403, sent when it no longer knows this phone's key) shows the phone as revoked. The pairing record is never deleted
 *  here: only the person unpairs, so a forged or mistaken close can't cut the phone off for good. */
import {MobileError} from '../shared';

export type LinkNext = 'retry' | 'revoked';
export const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
export const backoff = (attempt: number): number => BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;

/** After connectPhone rejected. */
export const afterLinkFailure = (error: unknown): LinkNext => error instanceof MobileError && error.code === 'revoked' ? 'revoked' : 'retry';
/** After a live connection closed with `reason`. */
export const afterLinkClose = (reason: string): LinkNext => reason === 'revoked' ? 'revoked' : 'retry';
