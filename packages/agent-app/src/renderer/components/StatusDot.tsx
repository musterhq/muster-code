import React from 'react';
import {CheckCircle2,Circle,LoaderCircle,Octagon,XCircle} from 'lucide-react';
import type { ChatStatus } from '../../shared/protocol';

const LABEL: Record<ChatStatus, string> = {
  idle: 'Idle',
  running: 'Working',
  stopping: 'Stopping',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

const ICON: Record<ChatStatus,typeof Circle> = {
  idle: Circle,
  running: LoaderCircle,
  stopping: Octagon,
  completed: CheckCircle2,
  failed: XCircle,
  interrupted: Octagon,
};

export function StatusDot({ status, showLabel=false }: { status: ChatStatus; showLabel?: boolean }): React.ReactElement {
  const Icon=ICON[status];
  return (
    <span
      className={`status-dot status-${status}`}
      data-status={status}
      role="img"
      aria-label={LABEL[status]}
      title={LABEL[status]}
    >
      <Icon size={13} strokeWidth={1.8} aria-hidden="true" />
      {showLabel&&<span className="status-label">{LABEL[status]}</span>}
    </span>
  );
}
