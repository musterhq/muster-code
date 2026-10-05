/**
 * Machine-readable markers that Muster Agent appends to the comments it posts as the
 * signed-in user ("via Muster · local"). They are HTML comments, so Paperclip's comment
 * renderer hides them while the plugin can still read them.
 *
 *   <!-- muster:checkout device="Dhairya's MacBook" device-id="mbp-1" by="Dhairya" at="2026-10-05T09:00:00Z" -->
 *   <!-- muster:activity at="2026-10-05T10:12:00Z" -->        progress, decision, evidence, cost comments
 *   <!-- muster:release at="2026-10-05T11:00:00Z" -->         user let go of the task
 *   <!-- muster:handback at="2026-10-05T11:00:00Z" -->        user finished and handed back to review
 *
 * The plugin itself writes one more marker kind, `muster:reminder`.
 *
 * Attribute values are double-quoted; a literal double quote is written as `&quot;`
 * and `&amp;` stands for an ampersand.
 */
export const MARKER_KINDS = ["checkout", "activity", "release", "handback", "reminder"] as const;
export type MarkerKind = (typeof MARKER_KINDS)[number];

export interface MusterMarker {
  kind: MarkerKind;
  attrs: Record<string, string>;
}

const MARKER_RE = /<!--\s*muster:([a-z][a-z-]*)((?:\s+[a-z][\w-]*="[^"]*")*)\s*-->/gi;
const ATTR_RE = /([a-z][\w-]*)="([^"]*)"/gi;

/** The visible sign-off Muster adds to its comments; counts as activity even without a marker. */
export const VIA_MUSTER_RE = /via Muster\b/i;

function decode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function encode(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/-->/g, "--&gt;");
}

export function parseMarkers(body: string | null | undefined): MusterMarker[] {
  if (!body) return [];
  const markers: MusterMarker[] = [];
  for (const match of body.matchAll(MARKER_RE)) {
    const kind = match[1]!.toLowerCase();
    if (!(MARKER_KINDS as readonly string[]).includes(kind)) continue;
    const attrs: Record<string, string> = {};
    for (const attr of (match[2] ?? "").matchAll(ATTR_RE)) {
      attrs[attr[1]!.toLowerCase()] = decode(attr[2]!);
    }
    markers.push({ kind: kind as MarkerKind, attrs });
  }
  return markers;
}

export function buildMarker(kind: MarkerKind, attrs: Record<string, string | undefined> = {}): string {
  const rendered = Object.entries(attrs)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
    .map(([key, value]) => `${key}="${encode(value)}"`)
    .join(" ");
  return `<!-- muster:${kind}${rendered ? ` ${rendered}` : ""} -->`;
}
