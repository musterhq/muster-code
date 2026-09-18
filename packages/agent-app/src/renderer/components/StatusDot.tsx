import React from 'react';
import type { ChatStatus } from '../../shared/protocol';

const LABEL: Record<ChatStatus, string> = {
  idle: 'Idle',
  running: 'Working',
  stopping: 'Stopping',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

export function StatusDot({ status }: { status: ChatStatus }): React.ReactElement {
  return (
    <span
      className={`status-dot status-${status}`}
      role="img"
      aria-label={LABEL[status]}
      title={LABEL[status]}
    />
  );
}
