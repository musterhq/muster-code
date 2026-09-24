/**
 * UX-13: below NAV_AUTO_COLLAPSE_WIDTH the sidebar steps aside so the conversation keeps a usable column,
 * and comes back when the window widens again. The collapse is not persisted, and a manual toggle while
 * narrow takes over (we never re-open a sidebar the user closed, or close one they re-opened).
 */
export const NAV_AUTO_COLLAPSE_WIDTH = 900;

export function nextAutoNav(input: {narrow: boolean; navHidden: boolean; autoCollapsed: boolean}): {navHidden: boolean; autoCollapsed: boolean} | null {
  if (input.narrow && !input.navHidden && !input.autoCollapsed) return {navHidden: true, autoCollapsed: true};
  if (!input.narrow && input.autoCollapsed) return {navHidden: false, autoCollapsed: false};
  return null;
}

export interface NavAccess { navHidden(): boolean; setNavHidden(hidden: boolean, options: {persist: false}): void }

export function installResponsiveNav(nav: NavAccess, win: Window = window): () => void {
  if (typeof win.matchMedia !== 'function') return () => {};
  const query = win.matchMedia(`(max-width: ${NAV_AUTO_COLLAPSE_WIDTH - 1}px)`);
  let autoCollapsed = false;
  let expectHidden: boolean | null = null;
  const apply = () => {
    const navHidden = nav.navHidden();
    // The user toggled while we held the sidebar collapsed: their choice wins from here on.
    if (autoCollapsed && expectHidden !== null && navHidden !== expectHidden) autoCollapsed = false;
    const next = nextAutoNav({narrow: query.matches, navHidden, autoCollapsed});
    if (!next) return;
    autoCollapsed = next.autoCollapsed;
    expectHidden = next.autoCollapsed ? next.navHidden : null;
    if (next.navHidden !== navHidden) nav.setNavHidden(next.navHidden, {persist: false});
  };
  apply();
  query.addEventListener?.('change', apply);
  return () => query.removeEventListener?.('change', apply);
}
