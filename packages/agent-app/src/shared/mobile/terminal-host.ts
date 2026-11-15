/**
 * The desktop's terminal sessions as the phone bridge sees them (#326 phase 6). The terminals live in the app's main process;
 * the runtime, loaded in the same process, finds them through one host registered on the process (a symbol on globalThis, so
 * the two bundles share it). Nothing else is reachable through it: list a chat's terminals, read one's output so far, write
 * input to one, and hear new output.
 */
export interface PhoneTerminalInfo { id: string; title: string; status: string }
export type PhoneTerminalEvent = {type: 'data'; id: string; data: string} | {type: 'exit'; id: string};
export interface PhoneTerminalHost {
  list(chatId: string): Promise<PhoneTerminalInfo[]>;
  /** What the terminal printed so far (the desktop's bounded ring). */
  snapshot(id: string): Promise<{data: string}>;
  input(id: string, data: string): Promise<void>;
  subscribe(listener: (event: PhoneTerminalEvent) => void): () => void;
}
const KEY = Symbol.for('muster.phoneTerminalHost');
export function setPhoneTerminalHost(host: PhoneTerminalHost | undefined): void { (globalThis as Record<symbol, unknown>)[KEY] = host; }
export const phoneTerminalHost = (): PhoneTerminalHost | undefined => (globalThis as Record<symbol, unknown>)[KEY] as PhoneTerminalHost | undefined;
