import React from 'react';
import { Monitor } from 'lucide-react';
import { desktopOnlyText } from '../webHost.ts';

/** What Muster Server's web UI shows in place of a surface that runs on the user's own computer (#199). */
export function DesktopOnlyState({ feature }: { feature: string }): React.ReactElement {
  return <div className="desktop-only-state" role="note"><Monitor size={20} aria-hidden="true"/><strong>Desktop only</strong><span>{desktopOnlyText(feature)}</span></div>;
}
