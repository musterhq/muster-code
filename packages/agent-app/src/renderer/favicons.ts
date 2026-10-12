import {useEffect, useState} from 'react';
import {invoke} from './bridge';

/** Site icons for source stacks, fetched once per host through main's cache. Until one arrives (or when a site
 *  has none) callers draw a letter tile, so a render never waits on the network. */
const known = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();
const MAX_KNOWN = 512;

export function faviconFor(host: string): Promise<string | null> {
  if (known.has(host)) return Promise.resolve(known.get(host)!);
  let task = pending.get(host);
  if (!task) {
    task = invoke('favicon.get', {url: `https://${host}`}).then(result => result?.dataUrl ?? null, () => null).then(value => {
      known.set(host, value); pending.delete(host);
      if (known.size > MAX_KNOWN) known.delete(known.keys().next().value!);
      return value;
    });
    pending.set(host, task);
  }
  return task;
}

/** The icon for `host` once known; undefined while loading, null when there is none. */
export function useFavicon(host: string): string | null | undefined {
  const [value, setValue] = useState(() => known.get(host));
  useEffect(() => {
    if (known.has(host)) { setValue(known.get(host)); return; }
    let live = true;
    void faviconFor(host).then(result => { if (live) setValue(result); });
    return () => { live = false; };
  }, [host]);
  return value;
}
