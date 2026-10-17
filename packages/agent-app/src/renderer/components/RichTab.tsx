/** A rich block (diagram, chart, report) opened in the right pane: the same RichBlock and renderers, filling the pane. */
import React from 'react';
import {type WorkspaceTab} from '../store';
import {RichFence} from './RichFence';
import {ResourceState} from './ResourceState';

export function RichTab({tab}: {tab: WorkspaceTab}): React.ReactElement {
  if ((tab.richKind !== 'diagram' && tab.richKind !== 'chart' && tab.richKind !== 'report') || typeof tab.richSource !== 'string') {
    return <ResourceState kind="error" message="This view can’t be opened" detail="It was saved without its content. Open it again from the conversation."/>;
  }
  return <div className="rich-tab"><RichFence kind={tab.richKind} source={tab.richSource} variant="tab"/></div>;
}
