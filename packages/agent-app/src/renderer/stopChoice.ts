/** #44: what Stop should stop when the chat started chats that are still working. The host (StopChildrenSheet) asks. */
export type StopChoice = 'all' | 'one' | 'cancel';
export interface StopPrompt { title: string; names: string[]; resolve(choice: StopChoice): void }
let prompt: StopPrompt | null = null, hosts = 0;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
export const subscribeStopPrompt = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const currentStopPrompt = () => prompt;
export function registerStopHost(): () => void { hosts++; return () => { hosts--; prompt?.resolve('cancel'); }; }

/** Asks the mounted host; without one (a detached window) it stops only the chat, as Stop always did. */
export function askStopChoice(title: string, names: string[]): Promise<StopChoice> {
  if (!hosts) return Promise.resolve('one');
  prompt?.resolve('cancel');
  return new Promise(resolve => { prompt = { title, names, resolve: choice => { prompt = null; changed(); resolve(choice); } }; changed(); });
}
