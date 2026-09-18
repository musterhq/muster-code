import { Bot, Check, ChevronDown, ChevronRight, Copy, FileText, ListChecks, Plug, Search, Terminal, Wrench } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { TimelineItem } from '../../shared/protocol';
import { classifyTool, commandLabel, type ToolKind } from './toolPresentation';
import './tool-card.css';

const ICONS: Record<ToolKind, React.ComponentType<{size?: number; 'aria-hidden'?: boolean | 'true'}>> = {
  read: FileText, search: Search, list: ListChecks, command: Terminal, subagent: Bot, mcp: Plug, generic: Wrench,
};

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }, () => setCopied(false));
  };
  return [copied, copy];
}

export function ToolCard({item}: {item: TimelineItem}) {
  const [open, setOpen] = useState(false);
  const [copied, copy] = useCopy();
  const p = classifyTool(item.data);
  const running = item.status === 'running';
  const failed = item.status === 'failed';
  const state = running ? p.runningVerb : failed ? 'Failed' : p.verb;
  const raw = p.subject || 'Tool';
  const output = item.text.startsWith(raw) ? item.text.slice(raw.length).replace(/^\n/, '') : item.text;
  const bodyId = `tool-body-${item.id}`;
  const Icon = ICONS[p.kind];

  if (p.kind === 'command') {
    const command = commandLabel(raw);
    return <div className={`command-card${running ? ' is-running' : ''}`}>
      <button className="command-head" aria-expanded={open} aria-controls={bodyId} onClick={()=>setOpen(v=>!v)}>
        {running ? <span className="tool-run-glyph" aria-hidden="true" /> : <Terminal size={14} aria-hidden="true" />}
        <span className="command-label" title={command}>{command}</span>
        <span className="command-state">{running ? 'Running' : failed ? 'Failed' : 'Ran'}</span>
        {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
      </button>
      {open ? <div className="command-body" id={bodyId}>
        <div className="command-source"><code>{raw}</code><button className="icon-button" aria-label={copied ? 'Command copied' : 'Copy command'} onClick={()=>copy(raw)}>{copied ? <Check size={13}/> : <Copy size={13}/>}</button></div>
        <pre className="tool-output">{output || (running ? 'Waiting for output…' : 'No output')}</pre>
      </div> : output ? <pre className="command-preview" aria-hidden="true">{output.slice(0,400)}</pre> : null}
    </div>;
  }

  return <div className={`tool-row-card kind-${p.kind}${running ? ' is-running' : ''}${failed ? ' is-failed' : ''}`}>
    <button className="tool-row-head" aria-expanded={open} aria-controls={bodyId} onClick={()=>setOpen(v=>!v)}>
      {running ? <span className="tool-run-glyph" aria-hidden="true" /> : <Icon size={14} aria-hidden="true" />}
      <span className="tool-row-state">{state}</span>
      {p.subject ? <span className="tool-row-subject" title={p.subject}>{p.subject}</span> : <span className="tool-row-subject" />}
      {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
    </button>
    {open ? <div className="tool-row-body" id={bodyId}>
      {p.subject ? <div className="tool-row-source"><code>{p.subject}</code><button className="icon-button" aria-label={copied ? 'Copied' : 'Copy'} onClick={()=>copy(p.subject)}>{copied ? <Check size={13}/> : <Copy size={13}/>}</button></div> : null}
      <pre className="tool-output">{output || (running ? 'Waiting for output…' : 'No output')}</pre>
    </div> : null}
  </div>;
}
