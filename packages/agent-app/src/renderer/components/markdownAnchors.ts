/**
 * Keep document-internal anchors predictable without accepting arbitrary HTML.
 * The prefix avoids colliding with ids owned by the surrounding application.
 */
export function markdownHeadingId(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `muster-heading-${slug || 'section'}`;
}

/** A fragment is only an in-document target when it has visible text. */
export function markdownFragmentId(fragment: string): string | null {
  try {
    const decoded = decodeURIComponent(fragment.replace(/^#/, '')).trim();
    return decoded ? markdownHeadingId(decoded) : null;
  } catch {
    return null;
  }
}
