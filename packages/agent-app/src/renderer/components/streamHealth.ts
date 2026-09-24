import {useEffect, useRef, useState} from 'react';
import type {TimelineItem} from '../../shared/protocol';
import {streamPresence, useTransportHealth, type Freshness, type StreamPresence, type TransportState} from '../connectionHealth';
import {probeTimeline} from '../store';
import {useTransportStall} from './RunStates';

/** Probe cadence while a running chat stays silent: 0 s, then backing off to 30 s. */
export const PROBE_BACKOFF_MS = [0, 5_000, 10_000, 20_000, 30_000] as const;

/** PER-14: a running chat's stream health, separating transport from data freshness.
 *  Silence triggers a probe instead of a guess: a newer server revision resyncs (syncing → live),
 *  a failed read marks the transport reconnecting, and a current read means the provider is just working. */
export function useStreamHealth(chatId: string | undefined, items: readonly TimelineItem[], running: boolean): {presence: StreamPresence; transport: TransportState; freshness: Freshness; stalled: boolean} {
  const stalled = useTransportStall(items, running);
  const transport = useTransportHealth().state;
  const [freshness, setFreshness] = useState<Freshness>('live');
  const attempt = useRef(0);
  useEffect(() => { attempt.current = 0; setFreshness('live'); }, [chatId]);
  useEffect(() => {
    if (!chatId || !(stalled || transport !== 'connected') || !running) { attempt.current = 0; return; }
    let alive = true;
    const delay = PROBE_BACKOFF_MS[Math.min(attempt.current, PROBE_BACKOFF_MS.length - 1)]!;
    const timer = setTimeout(() => {
      attempt.current++;
      setFreshness(value => value === 'live' ? value : 'resyncing');
      void probeTimeline(chatId).then(result => {
        if (!alive) return;
        // 'resynced' applied the missed rows already; the view is current again.
        setFreshness(result === 'failed' ? 'stale' : 'live');
      });
    }, delay);
    return () => { alive = false; clearTimeout(timer); };
  }, [chatId, stalled, running, transport, items.length, items.at(-1)?.text.length]);
  return {presence: running ? streamPresence({transport, freshness, stalled}) : transport === 'connected' ? 'live' : transport, transport, freshness, stalled};
}
