import React from 'react';
import {CircleAlert,CirclePause,Clock,LoaderCircle,MessageCircle,Octagon,WifiOff,XCircle} from 'lucide-react';
import type { ChatStatus } from '../../shared/protocol';
import './status-dot.css';

const LABEL: Record<ChatStatus, string> = {
  idle: 'Idle',
  running: 'Working',
  stopping: 'Stopping',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  waiting: 'Needs input',
  queued: 'Queued',
  reconnecting: 'Reconnecting',
};

/** Settled chats share one quiet chat glyph (Codex); only live or exceptional states get colour or motion. */
const ICON: Record<ChatStatus,typeof MessageCircle> = {
  idle: MessageCircle,
  running: LoaderCircle,
  stopping: Octagon,
  completed: MessageCircle,
  failed: XCircle,
  interrupted: CircleAlert,
  // Static glyphs: nothing pulses while the run is paused on the user or the transport.
  waiting: CirclePause,
  queued: Clock,
  reconnecting: WifiOff,
};

/** An unseen result replaces the quiet chat glyph with a blue dot until the chat is opened; failures keep their icon. */
export function StatusDot({ status, showLabel=false, unread=false }: { status: ChatStatus; showLabel?: boolean; unread?: boolean }): React.ReactElement {
  const Icon=ICON[status];
  const dot=unread&&Icon===MessageCircle;
  const label=unread?`Unread · ${LABEL[status]}`:LABEL[status];
  return (
    <span
      className={`status-dot status-${status}${unread?' is-unread':''}`}
      data-status={status}
      role="img"
      aria-label={label}
      title={label}
    >
      {dot?<span className="status-unread-dot" aria-hidden="true"/>:<Icon size={13} strokeWidth={1.8} aria-hidden="true" />}
      {showLabel&&<span className="status-label">{LABEL[status]}</span>}
    </span>
  );
}
