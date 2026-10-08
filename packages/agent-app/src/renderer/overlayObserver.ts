/**
 * Native views (browser pane, Quick Look) hide while a dialog, menu or layout change would sit above them.
 * The old observer watched every attribute and node on the page, so each streamed transcript node queued a
 * frame of forced layout. This one still sees the whole document (an overlay can mount anywhere) but wakes
 * the surface only for a record that can matter: the pane host or one of its ancestors changing, or an
 * overlay-like element appearing, disappearing or toggling.
 */
export const OVERLAY_SELECTOR = '[role="dialog"],[role="menu"],[role="listbox"],[data-native-preview-overlay],[data-browser-overlay]';

const hasOverlay = (node: Node): boolean => node.nodeType === 1 && ((node as Element).matches(OVERLAY_SELECTOR) || (node as Element).querySelector(OVERLAY_SELECTOR) !== null);

export function relevantMutation(record: MutationRecord, host: Element | null): boolean {
  if (record.type === 'attributes') {
    const target = record.target as Element;
    if (host && target.contains(host)) return true; // the host or an ancestor hid, showed or restyled
    if (target.matches(OVERLAY_SELECTOR)) return true;
    // A container revealing a dialog it already holds.
    return record.attributeName !== 'class' && record.attributeName !== 'style' && target.querySelector(OVERLAY_SELECTOR) !== null;
  }
  for (const node of record.addedNodes) if (hasOverlay(node) || (host && node.nodeType === 1 && node.contains(host))) return true;
  for (const node of record.removedNodes) if (hasOverlay(node)) return true;
  return false;
}

/** Observes the document for changes that can move or cover `host()`; returns the disconnect function. */
export function observeOverlayChanges(host: () => Element | null, schedule: () => void, attributeFilter: string[]): () => void {
  const observer = new MutationObserver(records => { const element = host(); if (records.some(record => relevantMutation(record, element))) schedule(); });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter });
  return () => observer.disconnect();
}

export type Bounds = { x: number; y: number; width: number; height: number };
export const sameBounds = (a: Bounds | null, b: Bounds): boolean => !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
