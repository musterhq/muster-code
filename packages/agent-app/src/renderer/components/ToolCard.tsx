import { ChevronDown, ChevronRight, Terminal, Copy, Check } from 'lucide-react';
import React, { useState } from 'react';
import type { TimelineItem } from '../../shared/protocol';

/** Display-only normalization. The original command remains available expanded. */
function commandLabel(raw: string): string {
  const shell = raw.match(/^(?:\/\S+\/)?(?:zsh|bash|sh)\s+-[a-z]*c\s+([\s\S]+)$/);
  const wrapped = shell ? shell[1] : raw;
  return /^(['"])[\s\S]*\1$/.test(wrapped) ? wrapped.slice(1, -1) : wrapped;
}

export function ToolCard({item}: {item: TimelineItem}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const raw = typeof item.data?.name === 'string' ? item.data.name : 'Tool';
  const command = commandLabel(raw);
  const output = item.text.startsWith(raw) ? item.text.slice(raw.length).replace(/^\n/, '') : item.text;
  const running = item.status === 'running';
  return <div className={`command-card${running ? ' is-running' : ''}`}>
    <button className="command-head" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>
      <Terminal size={14} aria-hidden="true" />
      <span className="command-label" title={command}>{command}</span>
      <span className="command-state">{running ? 'Running' : item.status === 'failed' ? 'Failed' : 'Ran'}</span>
      {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
    </button>
    {open ? <div className="command-body">
      <div className="command-source"><code>{raw}</code><button className="icon-button" aria-label={copied ? 'Command copied' : 'Copy command'} onClick={()=>{void navigator.clipboard.writeText(raw).then(()=>setCopied(true),()=>setCopied(false));}}>{copied ? <Check size={13}/> : <Copy size={13}/>}</button></div>
      <pre className="tool-output">{output || (running ? 'Waiting for output…' : 'No output')}</pre>
    </div> : output ? <pre className="command-preview" aria-hidden="true">{output.slice(0,400)}</pre> : null}
  </div>;
}
