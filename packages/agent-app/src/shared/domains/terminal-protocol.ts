/** Terminal domain contract (C3.b4 / CR-19): per-chat consent for the agent's read-only terminal tool. */
export interface TerminalAccess { chatId: string; allowed: boolean; allowedAt?: string }
export interface TerminalCommands {
  /** Whether this chat's agent may read the user's terminal output (off unless the user turned it on). */
  'terminalAccess.get': { input: { chatId: string }; output: TerminalAccess };
  /** Explicit user consent, per chat; `allowed: false` revokes it. Applies from the chat's next turn. */
  'terminalAccess.set': { input: { chatId: string; allowed: boolean }; output: TerminalAccess };
}
export type TerminalEvent = { type: 'terminalAccessChanged'; access: TerminalAccess };
export const TERMINAL_COMMANDS = { 'terminalAccess.get': true, 'terminalAccess.set': true } as const satisfies Record<keyof TerminalCommands, true>;
