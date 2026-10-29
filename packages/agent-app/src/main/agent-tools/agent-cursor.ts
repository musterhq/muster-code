/**
 * The agent's visible cursor in a page the person can see (#721).
 *
 * One idempotent script installs `globalThis.__musterCursor` in the agent's isolated world. The overlay lives in a
 * closed shadow root on a fixed, click-through host, so page styles cannot reach it and it never takes input.
 * Motion: the cursor glides to the target on a gentle arc (duration grows with distance), presses with a ripple on
 * click, rings a field while typing, and fades out once the agent has been quiet for a moment. Reduce motion turns
 * glides into jumps and keeps only short opacity fades. Model screenshots hide it, so the model never sees itself.
 */
export const CURSOR_IDLE_MS = 1600;
export const CURSOR_FADE_MS = 520;
export const CURSOR_MIN_GLIDE_MS = 140;
export const CURSOR_MAX_GLIDE_MS = 520;
export type CursorMode = 'click' | 'double' | 'hover' | 'type' | 'move';

const INSTALL = `(() => {
  if (globalThis.__musterCursor?.version === 2) return globalThis.__musterCursor;
  const IDLE = ${CURSOR_IDLE_MS}, FADE = ${CURSOR_FADE_MS}, MIN = ${CURSOR_MIN_GLIDE_MS}, MAX = ${CURSOR_MAX_GLIDE_MS};
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let host, root, cursor, arrow, pill, ring, lastMs = 0, x = -1, y = -1, opacity = 0, idleTimer, ringFor = null, hidden = false;
  const css = \`
    :host{all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict}
    .c{position:absolute;left:0;top:0;opacity:0;will-change:transform,opacity}
    .a{position:absolute;left:-1.5px;top:-1.5px;width:20px;height:22px;transform-origin:1.5px 1.5px;filter:drop-shadow(0 1.5px 2.5px rgba(0,0,0,.32)) drop-shadow(0 0 1px rgba(0,0,0,.25))}
    .p{position:absolute;left:15px;top:19px;padding:2px 8px 3px;border-radius:999px;background:#D2943E;color:#1d1406;font:600 11px/15px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;letter-spacing:.01em;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.18),0 4px 12px rgba(0,0,0,.18),inset 0 0 0 1px rgba(255,255,255,.28)}
    .r{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #D2943E;box-sizing:border-box;opacity:0}
    .g{position:absolute;opacity:0;box-shadow:0 0 0 2px rgba(210,148,62,.9),0 0 0 6px rgba(210,148,62,.18);transition:opacity 160ms ease}\`;
  function mount() {
    if (host?.isConnected) return;
    host = document.createElement('muster-agent-cursor');
    root = host.attachShadow({mode: 'closed'});
    root.innerHTML = '<style>' + css + '</style><div class="g"></div><div class="c"><svg class="a" viewBox="0 0 20 22" aria-hidden="true"><path d="M1.5 1.5v15.6l4.3-4.1 2.9 6.4 2.8-1.2-2.8-6.3h6z" fill="#D2943E" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><div class="p"></div></div>';
    ring = root.querySelector('.g'); cursor = root.querySelector('.c'); arrow = root.querySelector('.a'); pill = root.querySelector('.p');
    (document.documentElement || document.body).appendChild(host);
    if (x >= 0) place(x, y);
    cursor.style.opacity = String(opacity);
    host.style.visibility = hidden ? 'hidden' : '';
  }
  const place = (px, py) => { x = px; y = py; cursor.style.transform = 'translate3d(' + px + 'px,' + py + 'px,0)'; };
  function fadeTo(value, ms) {
    opacity = value;
    const from = getComputedStyle(cursor).opacity;
    cursor.getAnimations().filter(a => a.id === 'fade').forEach(a => a.cancel());
    const anim = cursor.animate([{opacity: from}, {opacity: String(value)}], {duration: ms, easing: value ? 'cubic-bezier(.2,.8,.2,1)' : 'cubic-bezier(.4,0,.6,1)', fill: 'forwards'});
    anim.id = 'fade';
    cursor.style.opacity = String(value);
    return anim.finished.catch(() => {});
  }
  function rest() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { fadeTo(0, reduced() ? 160 : FADE); ring.style.opacity = '0'; ringFor = null; }, IDLE);
  }
  const target = (el) => {
    const r = el.getBoundingClientRect();
    return {r, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)};
  };
  async function glide(tx, ty) {
    const instant = reduced();
    if (opacity < 1) {
      if (x < 0 || instant) place(tx, ty);
      else place(x, y);
      await fadeTo(1, instant ? 120 : 140);
      if (x === tx && y === ty) return 0;
    }
    const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy);
    if (instant || d < 2) { place(tx, ty); return 0; }
    const ms = Math.round(Math.min(MAX, Math.max(MIN, 110 + d * 0.42)));
    const bend = Math.min(40, d * 0.08), mx = x + dx / 2 + (-dy / d) * bend, my = y + dy / 2 + (dx / d) * bend;
    const from = 'translate3d(' + x + 'px,' + y + 'px,0)', mid = 'translate3d(' + mx + 'px,' + my + 'px,0)', to = 'translate3d(' + tx + 'px,' + ty + 'px,0)';
    const anim = cursor.animate([{transform: from}, {transform: mid, offset: 0.5}, {transform: to}], {duration: ms, easing: 'cubic-bezier(.3,.7,.2,1)'});
    place(tx, ty);
    await anim.finished.catch(() => {});
    return ms;
  }
  function press(double) {
    if (reduced()) return;
    for (let i = 0; i < (double ? 2 : 1); i++) {
      arrow.animate([{transform: 'scale(1)'}, {transform: 'scale(.84)', offset: 0.33}, {transform: 'scale(1)'}], {duration: 210, delay: i * 170, easing: 'ease-out'});
      const ripple = document.createElement('div'); ripple.className = 'r';
      ripple.style.left = x + 'px'; ripple.style.top = y + 'px';
      root.appendChild(ripple);
      ripple.animate([{transform: 'scale(.6)', opacity: .6}, {transform: 'scale(3.4)', opacity: 0}], {duration: 440, delay: 60 + i * 170, easing: 'cubic-bezier(.2,.7,.3,1)'}).finished.finally(() => ripple.remove());
    }
  }
  function halo(el, r) {
    const radius = getComputedStyle(el).borderRadius || '6px';
    Object.assign(ring.style, {left: (r.left - 2) + 'px', top: (r.top - 2) + 'px', width: (r.width + 4) + 'px', height: (r.height + 4) + 'px', borderRadius: radius});
    ringFor = el; ring.style.opacity = '1';
  }
  const api = {
    version: 2,
    async to(el, mode, label) {
      mount();
      clearTimeout(idleTimer);
      pill.textContent = label || 'Muster';
      if (ringFor && ringFor !== el) { ring.style.opacity = '0'; ringFor = null; }
      const t = target(el);
      const at = mode === 'type' ? {x: Math.round(t.r.left + Math.min(22, t.r.width * 0.2)), y: Math.round(t.r.top + t.r.height * 0.62)} : t;
      const ms = lastMs = await glide(at.x, at.y);
      if (mode === 'click' || mode === 'double') press(mode === 'double');
      if (mode === 'type') halo(el, t.r);
      rest();
      return {x, y, ms};
    },
    hide(value) { hidden = !!value; if (host) host.style.visibility = hidden ? 'hidden' : ''; return hidden; },
    debug() { return {x, y, opacity: cursor ? Number(getComputedStyle(cursor).opacity) : 0, ring: ring ? Number(ring.style.opacity || 0) : 0, label: pill?.textContent ?? '', glideMs: lastMs, hidden, mounted: !!host?.isConnected}; },
  };
  globalThis.__musterCursor = api;
  return api;
})()`;

/** Glides the cursor to a ref/selector target and resolves once it has arrived (so the press lands under it). */
export function cursorToScript(ref: string, selector: string, mode: CursorMode, label = 'Muster'): string {
  return `(async () => {
  const cursor = ${INSTALL};
  const ref = ${JSON.stringify(ref)}, selector = ${JSON.stringify(selector)};
  const el = ref ? globalThis.__musterRefs?.get(ref)?.deref() : selector ? document.querySelector(selector) : null;
  if (!el || !el.isConnected) return {error: 'no target'};
  return cursor.to(el, ${JSON.stringify(mode)}, ${JSON.stringify(label.slice(0, 40))});
})()`;
}
/** Hides the cursor for a model screenshot and shows it again afterwards. */
export const cursorHideScript = (hidden: boolean) => `(async () => {
  const c = globalThis.__musterCursor;
  if (!c) return null;
  const state = c.hide(${hidden});
  if (${hidden}) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return state;
})()`;
export const cursorDebugScript = `(() => globalThis.__musterCursor?.debug() ?? null)()`;
