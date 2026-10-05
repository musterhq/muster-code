/**
 * `muster://task/<companyId>/<issueId>?host=<URL-encoded server origin>&identifier=<KEY>`: the link the optional Paperclip plugin's "Open in Muster"
 * button writes. It names a task on a server; it never carries credentials or content. The app opens the task and offers Work locally, but only when
 * `host` is a server this Mac is already connected to: otherwise it asks the person to connect first, and never connects by itself.
 */
export interface TaskLink { companyId: string; issueId: string; host: string; identifier: string | null }
const ID = /^[\w:.-]{1,128}$/;
export function parseTaskLink(raw: string): TaskLink | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'muster:' || url.hostname !== 'task' || url.username || url.password || url.hash) return null;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length !== 2 || !parts.every(p => ID.test(p))) return null;
    const hostParam = url.searchParams.get('host');
    if (!hostParam) return null;
    const host = new URL(hostParam);
    if ((host.protocol !== 'https:' && host.protocol !== 'http:') || host.username || host.password) return null;
    const identifier = url.searchParams.get('identifier');
    return { companyId: parts[0]!, issueId: parts[1]!, host: host.origin, identifier: identifier && /^[A-Za-z0-9][A-Za-z0-9-]{0,40}$/.test(identifier) ? identifier : null };
  } catch { return null; }
}
export function taskLinkFromArgs(args: readonly string[]): TaskLink | null { for (const a of args) { const l = parseTaskLink(a); if (l) return l; } return null; }
/** Same server? Compared by origin (scheme, host and port), ignoring a trailing path. */
export function sameOrigin(a: string, b: string): boolean { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } }
