import fs from 'node:fs';
import path from 'node:path';
import type { TerminalAccess } from '../../shared/domains/terminal-protocol.ts';
import { TERMINAL_MCP, TERMINAL_MCP_LAUNCHER_ENV } from '../terminal-agent-tools.ts';
import type { DomainContext, DomainModule } from './types.ts';

const chatId = (input: Record<string, unknown>): string => {
  const value = input.chatId;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid chat id.');
  return value;
};

/** The muster_terminal MCP server for a chat the user allowed, once main's endpoint is listening. */
export function terminalRunOptions(chat: { id: string }, allowed: boolean, launcher = process.env[TERMINAL_MCP_LAUNCHER_ENV]) {
  if (!allowed || !launcher || !path.isAbsolute(launcher) || !fs.existsSync(launcher)) return null;
  return { configOverrides: { [`mcp_servers.${TERMINAL_MCP}.command`]: launcher, [`mcp_servers.${TERMINAL_MCP}.env.MUSTER_CHAT_ID`]: chat.id, [`mcp_servers.${TERMINAL_MCP}.tool_timeout_sec`]: 30 } };
}

/** Terminal domain: explicit, per-chat, revocable consent for the agent's read-only terminal tool (off by default). */
export function createTerminalDomain(ctx: DomainContext): DomainModule {
  const db = ctx.db();
  db.exec('CREATE TABLE IF NOT EXISTS chat_terminal_access (chat_id TEXT PRIMARY KEY, allowed_at TEXT NOT NULL)');
  const read = (id: string): TerminalAccess => {
    const row = db.prepare('SELECT allowed_at FROM chat_terminal_access WHERE chat_id = ?').get(id) as { allowed_at: string } | undefined;
    return row ? { chatId: id, allowed: true, allowedAt: row.allowed_at } : { chatId: id, allowed: false };
  };
  const off = ctx.hooks.addRunOptionsContributor(async chat => terminalRunOptions(chat, read(chat.id).allowed));
  return {
    handlers: {
      'terminalAccess.get': input => read(chatId(input)),
      'terminalAccess.set': input => {
        const id = chatId(input);
        if (typeof input.allowed !== 'boolean') throw new Error('Choose whether the agent may read this terminal.');
        if (input.allowed) {
          if (!ctx.store.chat(id)) throw new Error('Chat does not exist.');
          db.prepare('INSERT INTO chat_terminal_access (chat_id, allowed_at) VALUES (?, ?) ON CONFLICT(chat_id) DO NOTHING').run(id, new Date().toISOString());
        } else db.prepare('DELETE FROM chat_terminal_access WHERE chat_id = ?').run(id);
        const access = read(id);
        ctx.emit({ type: 'terminalAccessChanged', access });
        return access;
      },
    },
    dispose() { off(); },
  };
}
