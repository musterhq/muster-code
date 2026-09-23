/**
 * F18: the composer embeds a picked `@file`/`@folder` chip into the sent text verbatim, as plain
 * `@path` (or `@"quoted path"` when the path has whitespace) — see `chipToken`/`quote` in
 * composerMenus.ts. Nothing structural about the pick survives the send, so the timeline item is
 * just text. This recovers the mention spans from that text so the sent user bubble can render them
 * as the same clickable chip the composer showed, instead of dead "@apps/api/src/x.ts" text.
 */
export interface MentionSpan { start: number; end: number; folderId: string; path: string }

/** A bare (unquoted) token only becomes a chip when it looks like a real path — it has a slash or a
 *  file extension — so casual chat mentions ("@here", "@channel") never turn into broken file links. */
function looksLikePath(value: string): boolean {
  return value.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(value);
}

const MENTION_RE = /(^|[\s([{"'])@("(?:[^"\\]|\\.)*"|[^\s]+)/g;

/** Sentence punctuation that can trail a mention with no space before it ("…recurrence.ts.") and is
 *  never itself part of a real path segment. `resolveToolPath` only checks shape, not that the file
 *  exists, so it happily "resolves" the punctuation-included form too — stripping this first, and
 *  preferring that shorter match, is what keeps it out of the chip. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/**
 * Finds every `@mention` in `text` that `resolve` (typically `resolveToolPath` against the chat's
 * folders) can turn into a real folder-relative path. `@chat:"…"` mentions are left as text (not a
 * file).
 */
export function findMentionSpans(text: string, resolve: (raw: string) => { folderId: string; path: string } | undefined): MentionSpan[] {
  const spans: MentionSpan[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const lead = match[1], body = match[2];
    if (body.startsWith('chat:')) continue;
    const at = (match.index ?? 0) + lead.length;
    if (body.startsWith('"') && body.endsWith('"') && body.length >= 2) {
      let value: string | undefined;
      try { value = JSON.parse(body); } catch { value = undefined; }
      const target = value !== undefined ? resolve(value) : undefined;
      if (target) spans.push({ start: at, end: at + 1 + body.length, folderId: target.folderId, path: target.path });
      continue;
    }
    const stripped = body.replace(TRAILING_PUNCTUATION, '');
    const candidate = stripped && stripped !== body && looksLikePath(stripped) && resolve(stripped) ? stripped : body;
    if (!looksLikePath(candidate)) continue;
    const target = resolve(candidate);
    if (target) spans.push({ start: at, end: at + 1 + candidate.length, folderId: target.folderId, path: target.path });
  }
  return spans;
}
