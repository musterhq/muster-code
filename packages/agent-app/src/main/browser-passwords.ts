import type {BrowserFillResult, BrowserLogins} from '../shared/browser-protocol.ts';
export interface PasswordFillTarget {
  getURL(): string;
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: {code: string}[], userGesture?: boolean): Promise<unknown>;
  insertText(text: string): Promise<void>;
}
export interface BrowserPasswords {
  logins(pageUrl: string): Promise<BrowserLogins>;
  fill(target: PasswordFillTarget, input: {id: unknown; vault: unknown}): Promise<BrowserFillResult>;
}
export function createBrowserPasswords(_deps: {onePassword(): string | undefined; timeoutMs?: number}): BrowserPasswords {
  return {logins: async () => { throw new Error('Not implemented'); }, fill: async () => { throw new Error('Not implemented'); }};
}
