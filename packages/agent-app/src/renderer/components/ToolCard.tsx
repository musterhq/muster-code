import {ToolOutput,ToolDetail} from './ToolOutput';
import {useDisclosure} from './useDisclosure';
import {copyText} from '../clipboard';
import { Bot, Check, ChevronDown, ChevronRight, Copy, FileText, Pencil, ListChecks, Plug, Search, SquareTerminal, Wrench } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { TimelineItem } from '../../shared/protocol';
import { classifyTool, commandLabel, type ToolKind } from './toolPresentation';
import './tool-card.css';
import {Collapsible} from '@base-ui/react/collapsible';

const ICONS: Record<ToolKind, React.ComponentType<{size?: number; 'aria-hidden'?: boolean | 'true'}>> = {
  read: FileText, edit: Pencil, search: Search, list: ListChecks, command: SquareTerminal, subagent: Bot, mcp: Plug, generic: Wrench,
};
export function ToolGlyph({kind,running=false}:{kind:ToolKind;running?:boolean}) { const Icon=ICONS[kind];return <span className={running?'tool-glyph is-active':'tool-glyph'} aria-hidden="true"><Icon size={14}/></span>; }

function Metadata({item}:{item:TimelineItem}) {
  const d=item.data??{};
  const pretty=(value:unknown)=>{if(typeof value==='string'){try{return JSON.stringify(JSON.parse(value),null,2);}catch{return value;}}return JSON.stringify(value,null,2);};
  const changes=Array.isArray(d.changes)?d.changes as Record<string,unknown>[]:[];
  const blocks=[['Arguments',d.arguments],['Result',d.result],['Error',d.error],['Task',d.prompt],['Agent status',d.agentsStates],['Output',d.contentItems]];
  return <div className="tool-details">
    {typeof d.command==='string'&&classifyTool(d).kind!=='command'&&<ToolDetail id={item.id+':command'} label="Command" text={d.command} language="shell"/>}
    <dl>{typeof d.cwd==='string'&&<><dt>Folder</dt><dd>{d.cwd}</dd></>}
      {typeof d.durationMs==='number'&&<><dt>Duration</dt><dd>{(d.durationMs/1000).toFixed(2)}s</dd></>}
      {typeof d.exitCode==='number'&&<><dt>Exit code</dt><dd>{d.exitCode}</dd></>}
      {typeof d.model==='string'&&<><dt>Model</dt><dd>{d.model}</dd></>}
    </dl>
    {changes.map((change,index)=><ToolDetail key={index} id={item.id+':patch:'+index} label={String(change.path??'File change')} text={String(change.diff??'Patch details were not supplied by the provider.')} language="diff"/>)}
    {blocks.filter(([,value])=>value!=null).map(([label,value])=><ToolDetail key={String(label)} id={item.id+':'+label} label={String(label)} text={pretty(value)??''}/>)}
    {Array.isArray(d.receiverThreadIds)&&<div className="tool-child-ids">Agents: {d.receiverThreadIds.join(', ')}</div>}
  </div>;
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    void copyText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }, () => setCopied(false));
  };
  return [copied, copy];
}

export function ToolCard({item}: {item: TimelineItem}) {
  const [open, setOpen] = useDisclosure('tool:'+item.id);
  const [copied, copy] = useCopy();
  const p = classifyTool(item.data);
  const running = item.status === 'running';
  const failed = item.status === 'failed';
  const state = running ? p.runningVerb : failed ? 'Failed' : item.status === 'interrupted' ? 'Interrupted' : item.status === 'cancelled' ? 'Cancelled' : item.status === 'completed' ? p.verb : 'Tool';
  const raw = p.subject || 'Tool';
  const prefix=typeof item.data?.name==='string'?item.data.name:raw;
  const output = typeof item.data?.output==='string'?item.data.output:item.text.startsWith(prefix) ? item.text.slice(prefix.length).replace(/^\n/, '') : item.text;
  const bodyId = `tool-body-${item.id}`;


  const subject=p.kind==='command'?commandLabel(raw):(p.kind==='read'||p.kind==='edit')?p.subject.split(', ').map(path=>path.split('/').filter(Boolean).at(-1)||path).join(', '):p.subject;
  const duration=typeof item.data?.durationMs==='number'&&item.status!=='running'?item.data.durationMs:null;
  return <Collapsible.Root open={open} onOpenChange={setOpen} className={`tool-row-card kind-${p.kind}${running ? ' is-running' : ''}${failed ? ' is-failed' : ''}`}>
    <Collapsible.Trigger className="tool-row-head">
      <ToolGlyph kind={p.kind} running={running}/>
      <span className="tool-row-state">{state}</span>
      {subject ? <span className="tool-row-subject" title={p.subject}>{subject}</span> : <span className="tool-row-subject" />}
      {duration!=null&&duration>=1000&&<span className="tool-row-duration">in {Math.round(duration/1000)}s</span>}
      <ChevronRight className="tool-chevron" size={12}/>
    </Collapsible.Trigger>
    <Collapsible.Panel className="activity-disclosure"><div className="tool-row-body" id={bodyId}>
      {p.subject ? <div className="tool-row-source"><code>{p.subject}</code><button className="icon-button" aria-label={copied ? 'Copied' : p.kind==='command'?'Copy command':'Copy'} onClick={()=>copy(p.subject)}>{copied ? <Check size={13}/> : <Copy size={13}/>}</button></div> : null}
      {(output||p.kind==='command')&&<ToolOutput id={item.id} text={output || (running ? 'Waiting for output…' : 'No output')}/>}
      <Metadata item={item}/>
    </div></Collapsible.Panel>
  </Collapsible.Root>;
}
