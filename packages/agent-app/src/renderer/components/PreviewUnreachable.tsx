/**
 * #html-preview: the page a browser tab shows when its page cannot be reached (a dev server that is down, a refused or
 * reset connection, DNS). Adapted from T3 Code's PreviewUnreachable (MIT; see THIRD-PARTY-NOTICES.md): a plain headline,
 * the host and the reason in words, the raw error code, a Details list of what to try, and Reload. Muster's own
 * interstitial styles; no new design.
 */
import React, {useState} from 'react';
import {Unplug} from 'lucide-react';
import {describeLoadError, looksLikeServerDown} from '../../shared/preview';

export interface PreviewUnreachableProps {
  url: string;
  code: number;
  description: string;
  onReload(): void;
  onOpenExternal?(): void;
}

const hostOf = (url: string) => { try { return new URL(url).host || url; } catch { return url; } };

export function PreviewUnreachable({url, code, description, onReload, onOpenExternal}: PreviewUnreachableProps): React.ReactElement {
  const [details, setDetails] = useState(false);
  const local = looksLikeServerDown(url, description);
  const label = description || `ERR_${Math.abs(code) || 'FAILED'}`;
  return <div className="browser-interstitial browser-unreachable" role="alert">
    <Unplug size={28} aria-hidden="true"/>
    <p>{local ? 'This preview isn’t running' : 'This site can’t be reached'}</p>
    <span><b>{hostOf(url)}</b>: {describeLoadError(description)}.{local ? ' Start the dev server (or ask the agent to), then reload.' : ''}</span>
    {details && <ul className="browser-unreachable-tips">
      {local && <li>Check that the dev server is running and listening on this port</li>}
      <li>Check the address for typos</li>
      {!local && <li>Check your connection, proxy and firewall</li>}
    </ul>}
    <code className="browser-unreachable-code">{label}</code>
    <div className="browser-actions">
      <button className="is-primary" onClick={onReload}>Reload</button>
      <button aria-expanded={details} onClick={() => setDetails(value => !value)}>{details ? 'Hide details' : 'Details'}</button>
      {onOpenExternal && !local && <button onClick={onOpenExternal}>Open in default browser</button>}
    </div>
  </div>;
}
