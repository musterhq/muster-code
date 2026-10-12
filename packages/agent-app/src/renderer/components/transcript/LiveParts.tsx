import React, {useEffect, useRef, useState} from 'react';
import {formatDuration} from '../turnStatusModel';

/**
 * Whether `ref` is on screen and the window is visible. Animations and clocks run only while this is true,
 * so an off-screen or hidden transcript costs nothing.
 */
export function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    let onScreen = true;
    const sync = () => setVisible(onScreen && document.visibilityState !== 'hidden');
    const observer = typeof IntersectionObserver === 'function' && ref.current ? new IntersectionObserver(entries => { onScreen = entries.at(-1)?.isIntersecting ?? true; sync(); }) : null;
    if (observer && ref.current) observer.observe(ref.current);
    document.addEventListener('visibilitychange', sync);
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', sync); };
  }, [ref]);
  return visible;
}

/**
 * A clock that writes "Working for 42s" straight into its own text node once a second. React renders it once;
 * ticks never re-render the transcript. It stops while hidden or off screen.
 */
export function ElapsedText({since, prefix = '', running = true, endedMs}: {since?: string; prefix?: string; running?: boolean; endedMs?: number}) {
  const ref = useRef<HTMLSpanElement>(null);
  const visible = useOnScreen(ref);
  const start = since ? Date.parse(since) : NaN;
  const text = (now: number) => `${prefix}${formatDuration(Number.isFinite(start) ? Math.max(0, now - start) : 0)}`;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.textContent = text(running ? Date.now() : endedMs ?? Date.now());
    if (!running || !visible) return;
    const timer = window.setInterval(() => { node.textContent = text(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [since, running, visible, endedMs, prefix]);
  return <span ref={ref} className="tx-elapsed"/>;
}

/** Stepped pulse on live text; paused off screen, and static under reduced motion (CSS). */
export function LiveText({children, active = true}: {children: React.ReactNode; active?: boolean}) {
  const ref = useRef<HTMLSpanElement>(null);
  const visible = useOnScreen(ref);
  return <span ref={ref} className={active && visible ? 'tx-live-text is-animated' : 'tx-live-text'}>{children}</span>;
}
