/**
 * The per-chat binding every local agent tool host checks: the chat id a stdio MCP process sends is only believed when it
 * comes with MUSTER_CHAT_TOKEN, an HMAC of that chat id under the host's secret. Only the run's own MCP process is given
 * the token (in its environment), so one chat's tools cannot speak as another chat even though they share the endpoint
 * file and its bearer token.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The header the stdio MCP process sends MUSTER_CHAT_TOKEN in. */
export const CHAT_TOKEN_HEADER = 'x-muster-chat-token';
/** The plain error a tool host returns when the chat id and its token do not match. */
export const CHAT_BINDING_REFUSED = 'This tool call was refused: its chat token does not match the chat id.';

export class ChatBinding {
  constructor(private readonly secret: Buffer = randomBytes(32)) {}
  /** The value for the run's MUSTER_CHAT_TOKEN: an HMAC of the chat id under this host's secret. */
  token(chatId: string): string { return createHmac('sha256', this.secret).update(chatId).digest('hex'); }
  /** True only when `header` is the token for exactly this chat id. */
  verify(chatId: unknown, header: string | string[] | undefined): boolean {
    if (typeof chatId !== 'string' || typeof header !== 'string' || !/^[a-f0-9]{64}$/.test(header)) return false;
    const want = Buffer.from(this.token(chatId), 'hex'), got = Buffer.from(header, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  }
}

/** Main-process tool hosts register how to mint their chat tokens, so the runtime's run options can inject them (the
 *  runtime and main may be separate bundles, hence a global slot, as with the sandbox registry). */
type Issuer = (chatId: string) => string;
const SLOT = Symbol.for('muster.agentToolChatTokenIssuers');
const issuers = (): Map<string, Issuer> => ((globalThis as Record<symbol, unknown>)[SLOT] ??= new Map<string, Issuer>()) as Map<string, Issuer>;
export function registerChatTokenIssuer(server: string, issuer: Issuer): () => void {
  issuers().set(server, issuer);
  return () => { if (issuers().get(server) === issuer) issuers().delete(server); };
}
export function chatTokenIssuer(server: string): Issuer | undefined { return issuers().get(server); }
