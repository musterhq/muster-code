import {useLayoutEffect, useRef, useState} from 'react';
import {startActiveInterval} from './windowActivity';

/** Where the toast stack sits (#627): the window's bottom-right corner, 8px above the status row. */
export interface Box { left: number; top: number; right: number; bottom: number }
export interface NoticePlacement { bottom: number; maxHeight: number }

const EDGE = 16;        // gap to the window's right edge (and to the bottom when there is no status row)
const GAP = 8;          // gap kept to the status row, composer and summary card
const HEADER = 52;      // top limit when no summary card is in the way
const STACK_WIDTH = 380;
const MIN_ROOM = 72;    // one toast always fits (the room includes the stack's 24px of shadow padding), even when the card reaches nearly down to the composer

/**
 * Pure placement. The stack keeps the corner (16px in, up to 380px wide) with its bottom edge 8px above the status row.
 * If the composer or status row reach under that column there is no clear corner, so the stack lifts above the
 * composer instead. A summary card that reaches into the column limits how high the stack may grow (8px below it).
 * Absent or hidden pieces are `null` and take no part.
 */
export function placeNotices(window: {width: number; height: number}, composer: Box | null, status: Box | null, card: Box | null): NoticePlacement {
  const right = window.width - EDGE, left = window.width - EDGE - Math.min(STACK_WIDTH, window.width - 2 * EDGE);
  let lowest = status ? status.top - GAP : window.height - EDGE;
  const columnEnd = Math.max(composer?.right ?? 0, status?.right ?? 0);
  if (composer && left < columnEnd) lowest = Math.min(lowest, composer.top - GAP);
  let highest = HEADER;
  if (card && card.right > left && card.left < right) highest = Math.max(highest, card.bottom + GAP);
  lowest = Math.min(Math.round(lowest), window.height);
  return {bottom: window.height - lowest, maxHeight: Math.max(MIN_ROOM, Math.round(lowest - highest))};
}

/** Nothing to place against when an element is missing or not laid out (display: none reports an empty box). */
function boxOf(element: Element | null): Box | null {
  if (!element) return null;
  const {left, top, right, bottom} = element.getBoundingClientRect();
  return right - left > 0 || bottom - top > 0 ? {left, top, right, bottom} : null;
}

const parts = () => ({
  center: document.querySelector<HTMLElement>('main.center'),
  composer: document.querySelector<HTMLElement>('.composer'),
  status: document.querySelector<HTMLElement>('.env-footer'),
  card: document.querySelector<HTMLElement>('.summary-card:not([hidden])'),
});

export function measureNotices(): NoticePlacement {
  const {composer, status, card} = parts();
  return placeNotices({width: window.innerWidth, height: window.innerHeight}, boxOf(composer), boxOf(status), boxOf(card));
}

/**
 * Placement for a mounted stack, kept current while it shows: on window resize, when the pieces it avoids change
 * size (composer growing, summary card folding, right pane opening) and on a light poll for ones that mount or leave.
 * `count` scrolls the newest toast into view when a short stack has to scroll.
 */
export function useNoticePlacement(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<NoticePlacement | null>(null);
  const shown = count > 0;
  useLayoutEffect(() => {
    if (!shown) return;
    const update = () => setPlacement(previous => {
      const next = measureNotices();
      return previous && previous.bottom === next.bottom && previous.maxHeight === next.maxHeight ? previous : next;
    });
    update();
    window.addEventListener('resize', update);
    const stopPoll = startActiveInterval(update, 700);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    for (const element of Object.values(parts())) if (element) observer?.observe(element);
    return () => { window.removeEventListener('resize', update); stopPoll(); observer?.disconnect(); };
  }, [shown]);
  useLayoutEffect(() => { const element = ref.current; if (element) element.scrollTop = element.scrollHeight; }, [count]);
  return {ref, style: placement ?? undefined};
}
