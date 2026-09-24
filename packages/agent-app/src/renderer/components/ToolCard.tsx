import {ToolOutput,ToolDetail} from './ToolOutput';
import {useDisclosure} from './useDisclosure';
import {copyText} from '../clipboard';
import { Blocks, BookOpen, Bot, Check, ChevronRight, Circle, CircleCheck, CircleDot, Copy, Image as ImageIcon, ListChecks, MousePointerClick, PencilLine, Search, SquareTerminal, Wrench } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { TimelineItem } from '../../shared/protocol';
import { APPROVAL_WAIT_LABEL, awaitingApproval, basename, classifyTool, commandLabel, commandOutcome, planPreview, planSteps, resolveToolPath, uniqueFileLabels, type PlanStep, type ToolKind } from './toolPresentation';
import {getState,openFile} from '../store';
import {openTerminalTab} from './ProcessesTab';
import './tool-card.css';
import {Collapsible} from '@base-ui/react/collapsible';
import {invoke} from '../bridge';
import {computerAction,type ComputerAction} from '../../shared/computer-use';
import {openViewer,toolImageUrl,toolShots,type PipSource,type ToolShot} from '../computerUse';
import {itemPatches} from '../patchModel';
import {FileChangeView} from './FileDiffEditor';
import {DiffStat} from './DiffStat';
import {MessageBody} from './MessageBody';
import {Tip} from './Tooltip';
import {AppGlyph} from './AppGlyph';

type Glyph = React.ComponentType<{size?: number; strokeWidth?: number; 'aria-hidden'?: boolean | 'true'}>;
/** Codex transcript glyphs: thin, monochrome, one per verb. */
const ICONS: Record<ToolKind, Glyph> = {
  read: BookOpen, edit: PencilLine, search: Search, list: ListChecks, command: SquareTerminal, subagent: Bot, mcp: Blocks, computer: MousePointerClick, generic: Wrench,
};
export function ToolGlyph({kind,running=false,image=false}:{kind:ToolKind;running?:boolean;image?:boolean}) { const Icon=image?ImageIcon:ICONS[kind];return <span className={running?'tool-glyph is-active':'tool-glyph'} aria-hidden="true"><Icon size={15} strokeWidth={1.6}/></span>; }

/** CUA-06: screenshots in a tool result are pictures, never base64 text; click opens the full-resolution viewer. */
function Shot({shot,source,index}:{shot:ToolShot;source:PipSource;index:number}) {
  const [url,setUrl]=useState(shot.dataUrl);
  useEffect(()=>{if(shot.dataUrl){setUrl(shot.dataUrl);return;}let live=true;toolImageUrl(shot,id=>invoke('computer.image',{id})).then(value=>{if(live)setUrl(value);},()=>{});return()=>{live=false;};},[shot.id,shot.dataUrl]);
  return <button type="button" className="tool-shot" aria-label={`Open screenshot ${index+1} full size`} onClick={()=>openViewer({chatId:source.chatId,live:false,source:{...source,image:shot}})}>
    {url&&<img src={url} alt="" draggable={false} decoding="async" loading="lazy"/>}
    {shot.width&&shot.height?<span className="tool-shot-size">{shot.width}×{shot.height}</span>:null}
  </button>;
}
export function ToolShots({item}:{item:TimelineItem}) {
  const shots=toolShots(item.data);
  if(!shots.length)return null;
  const action=computerAction(item.data);
  const source:PipSource={chatId:item.chatId,target:action?.target??'computer',app:action?.app??'',label:action?.label||classifyTool(item.data).subject||'Screenshot',at:Date.parse(item.createdAt)||Date.now(),itemId:item.id,...(action?.url?{url:action.url}:{})};
  return <div className="tool-shots">{shots.map((shot,index)=><Shot key={shot.id??index} shot={shot} source={source} index={index}/>)}</div>;
}

function Metadata({item,plan}:{item:TimelineItem;plan:boolean}) {
  const d=item.data??{};
  const pretty=(value:unknown)=>{if(typeof value==='string'){try{return JSON.stringify(JSON.parse(value),null,2);}catch{return value;}}return JSON.stringify(value,null,2);};
  // A rendered checklist replaces the plan's raw argument/result JSON; errors stay visible.
  // CUA-04: computer-use rows read as actions; their masked arguments stay available under Details.
  const computer=classifyTool(d).kind==='computer';
  const blocks=[[computer?'Details':'Arguments',d.arguments],['Result',d.result],['Error',d.error],['Task',d.prompt],['Agent status',d.agentsStates],['Output',d.contentItems]].filter(([label])=>!plan||label==='Error');
  return <div className="tool-details">
    {typeof d.command==='string'&&classifyTool(d).kind!=='command'&&<ToolDetail id={item.id+':command'} label="Command" text={d.command} language="shell"/>}
    <dl>{typeof d.cwd==='string'&&<><dt>Folder</dt><dd>{d.cwd}</dd></>}
      {typeof d.durationMs==='number'&&<><dt>Duration</dt><dd>{(d.durationMs/1000).toFixed(2)}s</dd></>}
      {typeof d.exitCode==='number'&&<><dt>Exit code</dt><dd>{d.exitCode}</dd></>}
      {typeof d.model==='string'&&<><dt>Model</dt><dd>{d.model}</dd></>}
    </dl>
    {blocks.filter(([,value])=>value!=null).map(([label,value])=><ToolDetail key={String(label)} id={item.id+':'+label} label={String(label)} text={pretty(value)??''}/>)}
    {Array.isArray(d.receiverThreadIds)&&<div className="tool-child-ids">Agents: {d.receiverThreadIds.join(', ')}</div>}
  </div>;
}

export function PlanChecklist({steps}:{steps:readonly PlanStep[]}) {
  return <ol className="tool-plan" aria-label="Plan">{steps.map((step,index)=>{
    const Icon=step.status==='completed'?CircleCheck:step.status==='in_progress'?CircleDot:Circle;
    return <li key={index} className={`is-${step.status.replace('_','-')}`}><Icon size={13} aria-hidden="true"/><span>{step.text}<span className="tool-sr-only">{step.status==='completed'?' (done)':step.status==='in_progress'?' (in progress)':' (pending)'}</span></span></li>;
  })}</ol>;
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

function fileTarget(item:TimelineItem,path:string) {
  const {snapshot}=getState(),chat=snapshot?.chats.find(chat=>chat.id===item.chatId);
  return resolveToolPath(path,snapshot?.folders??[],chat?.folderId);
}
/** Codex rows: underlined file names open in the adjoining pane; edits carry +/- counts.
 *  Names disambiguate against every file in the row (not just the visible three), VS Code
 *  style, so "Edited package.json, package.json" (root vs apps/api) can't happen. */
function FileLinks({item,files}:{item:TimelineItem;files:{path:string;adds?:number;dels?:number}[]}) {
  const labels=uniqueFileLabels(files.map(file=>file.path));
  return <>{files.slice(0,3).map((file,index)=>{const to=fileTarget(item,file.path),label=labels.get(file.path)??basename(file.path);return <React.Fragment key={file.path}>
    {index>0&&<span className="tool-row-sep">, </span>}
    {to?<button type="button" className="tool-file-link" title={`${file.path} — Open in the side pane`} onClick={event=>{event.stopPropagation();void openFile(to.folderId,to.path);}}>{label}</button>:<span className="tool-file-name" title={`${file.path} — outside this chat’s folders`}>{label}</span>}
    {file.adds!=null&&<DiffStat adds={file.adds} dels={file.dels??0} className="tool-row-stat"/>}
  </React.Fragment>;})}{files.length>3&&<span className="tool-row-sep"> and {files.length-3} more</span>}</>;
}

/** "Viewed 4 images": a strip of thumbnails; each opens the image in the side pane. */
function ImageThumb({item,path}:{item:TimelineItem;path:string}) {
  const to=fileTarget(item,path);
  const [url,setUrl]=useState<string>();
  useEffect(()=>{if(!to)return;let live=true;invoke('files.asset',{folderId:to.folderId,path:to.path}).then(asset=>{if(live)setUrl(asset.dataUrl);},()=>{});return()=>{live=false;};},[to?.folderId,to?.path]);
  if(!to)return <span className="tool-thumb is-missing" title={`${path} — outside this chat’s folders`}><ImageIcon size={16} aria-hidden="true"/></span>;
  return <button type="button" className="tool-thumb" title={`${basename(path)} — Open in the side pane`} aria-label={`Open ${basename(path)}`} onClick={()=>void openFile(to.folderId,to.path)}>
    {url?<img src={url} alt="" draggable={false} decoding="async" loading="lazy"/>:<ImageIcon size={16} aria-hidden="true"/>}
  </button>;
}
export function ImageThumbs({item,paths}:{item:TimelineItem;paths:readonly string[]}) {
  if(!paths.length)return null;
  return <div className="tool-thumbs">{paths.slice(0,12).map(path=><ImageThumb key={path} item={item} path={path}/>)}</div>;
}

/** An edit row opened: each changed file as the inline diff editor (the whole file when it can be read). */
function EditDiffs({item}:{item:TimelineItem}) {
  const patches=itemPatches(item.data);
  if(!patches.length)return null;
  return <div className="tool-edit-diffs">{patches.map((patch,index)=><div key={patch.path+index} className="tool-edit-diff">
    {patches.length>1&&<div className="tool-edit-diff-path" title={patch.path}><span>{patch.path}</span><DiffStat adds={patch.adds} dels={patch.dels}/></div>}
    <FileChangeView path={patch.movePath??patch.path} kind={patch.kind} target={fileTarget(item,patch.movePath??patch.path)} patches={patch.patch?[{diff:patch.patch,adds:patch.adds,dels:patch.dels}]:[]} truncated={patch.truncated}/>
  </div>)}</div>;
}

/** ExitPlanMode / native plan text: the Plan card already shows the whole plan, so the tool row carries a
 *  one-line summary that jumps to it. When no card is on screen (an earlier turn, or outside Plan mode)
 *  the full text is one click away here instead. */
function PlanToolLink({chatId,text}:{chatId:string;text:string}) {
  const [full,setFull]=useState(false);
  const summary=planPreview(text);
  const view=()=>{
    const card=document.getElementById(`plan-card-${chatId}`);
    if(card){card.scrollIntoView({block:'nearest',behavior:'smooth'});card.focus({preventScroll:true});}
    else setFull(true);
  };
  if(full)return <div className="tool-plan-full"><MessageBody text={text}/></div>;
  return <p className="tool-plan-link"><span>{summary||'Plan'}</span><button type="button" className="tool-row-action" onClick={view}>View plan</button></p>;
}

/** The object of a computer-use step without the " in Mail" suffix the app icon already says; "Looked at Mail" when there is no object. */
function computerStepSubject(action:ComputerAction):string {
  if(action.object)return action.object;
  return action.target==='computer'&&action.app&&action.verb!=='Listed apps'?action.app:'';
}
export function ToolCard({item,reveal=false}: {item: TimelineItem;reveal?:boolean}) {
  const [open, setOpen] = useDisclosure('tool:'+item.id);
  useEffect(()=>{if(reveal&&!open)setOpen(true);},[reveal]);
  const [copied, copy] = useCopy();
  const p = classifyTool(item.data);
  // F60: blocked on an approval card — not running yet, so no spinner, live tail or "Running" verb.
  const waiting = awaitingApproval(item);
  const running = item.status === 'running' && !waiting;
  const raw = p.subject || 'Tool';
  const prefix=typeof item.data?.name==='string'?item.data.name:raw;
  const output = typeof item.data?.output==='string'?item.data.output:item.text.startsWith(prefix) ? item.text.slice(prefix.length).replace(/^\n/, '') : item.text;
  const outcome=commandOutcome(item.data,item.status,output);
  const failed = item.status === 'failed'||outcome.failed;
  // Keep the verb ("Ran npm test") and state the outcome as a red suffix instead of replacing it.
  const state = waiting ? APPROVAL_WAIT_LABEL : running ? p.runningVerb : item.status==='completed'||failed||item.status==='interrupted'||item.status==='cancelled' ? p.verb : 'Tool';
  const images=p.images??[];
  const files=images.length>1?[]:p.kind==='edit'?p.files??[]:p.kind==='read'?(p.paths??(p.subject?[p.subject]:[])).map(path=>({path})):[];
  // Codex: a computer-use step carries its app's icon, so the line reads as the step alone ("Clicked “Send”").
  const subject=p.kind==='command'?commandLabel(raw):images.length>1?'':p.computer?computerStepSubject(p.computer):p.subject;
  const steps=p.plan?planSteps(item.data):[];
  const live=p.kind==='command'&&running&&!open?output.replace(/\s+$/,'').split('\n').filter(line=>line.trim()).slice(-4):[];
  const excerpt=open?[]:outcome.excerpt;
  // Sub-second timings read as noise ("Read math.js 0ms"); only real waits are shown.
  const duration=typeof item.data?.durationMs==='number'&&item.data.durationMs>=1000?outcome.duration:undefined;
  const fileLabels=files.length?uniqueFileLabels(files.map(file=>file.path)):undefined;
  const label=`${state} ${files.length?files.map(file=>fileLabels?.get(file.path)??basename(file.path)).join(', '):subject}${outcome.suffix?' '+outcome.suffix:''}`.trim();
  const edit=p.kind==='edit';
  return <Collapsible.Root open={open} onOpenChange={setOpen} className={`tool-row-card kind-${p.kind}${images.length?' is-images':''}${running ? ' is-running' : ''}${waiting ? ' is-waiting' : ''}${failed ? ' is-failed' : ''}`}>
    <div className="tool-row-head">
      {/* The trigger covers the whole row; file links sit above it so they stay separate buttons. */}
      <Collapsible.Trigger className="tool-row-hit" aria-label={label} title={p.subject||undefined}/>
      {p.computer?<AppGlyph app={p.computer.app} target={p.computer.target} running={running}/>:<ToolGlyph kind={p.kind} running={running} image={images.length>0}/>}
      <span className="tool-row-text">
        <span className="tool-row-state">{state}</span>
        {files.length?<> <span className="tool-row-files"><FileLinks item={item} files={files}/></span></>:subject?<> <span className="tool-row-subject">{subject}</span></>:null}
      </span>
      {outcome.suffix&&<span className={`tool-row-outcome${failed?' is-error':''}`}>{outcome.suffix}</span>}
      {duration&&<span className="tool-row-duration">{duration}</span>}
      <ChevronRight className="tool-chevron" size={13} aria-hidden="true"/>
    </div>
    {(live.length>0||excerpt.length>0)&&<pre className={`tool-row-excerpt${excerpt.length?' is-error':''}`} aria-label={excerpt.length?'Last error output':'Latest output'}>{(excerpt.length?excerpt:live).join('\n')}</pre>}
    {steps.length>0&&!open&&<PlanChecklist steps={steps}/>}
    {images.length>0&&<ImageThumbs item={item} paths={images}/>}
    {!open&&<ToolShots item={item}/>}
    <Collapsible.Panel className="activity-disclosure"><div className="tool-row-body" id={`tool-body-${item.id}`}>
      {edit&&<EditDiffs item={item}/>}
      {p.subject&&!p.plan&&!edit&&!images.length ? <div className="tool-row-source"><code>{p.kind==='command'?commandLabel(p.subject):p.subject}</code>
        <Tip label={p.kind==='command'?'Copy command':'Copy'}><button type="button" className="icon-button" aria-label={copied ? 'Copied' : p.kind==='command'?'Copy command':'Copy'} onClick={()=>copy(p.subject)}>{copied ? <Check size={13}/> : <Copy size={13}/>}</button></Tip>
        {p.kind==='command'&&<button type="button" className="tool-row-action" onClick={()=>{const chat=getState().snapshot?.chats.find(chat=>chat.id===item.chatId);openTerminalTab(item.chatId,chat?.title||'Conversation','agent');}}>Open in Terminal</button>}
      </div> : null}
      {steps.length>0&&<PlanChecklist steps={steps}/>}
      <ToolShots item={item}/>
      {p.planText&&!steps.length&&<PlanToolLink chatId={item.chatId} text={p.planText}/>}
      {(output||p.kind==='command')&&!steps.length&&!edit&&!p.planText&&<ToolOutput id={item.id} chatId={item.chatId} sourceTruncated={item.data?.outputTruncated===true} text={output || (running ? 'Waiting for output…' : 'No output')}/>}
      <Metadata item={item} plan={steps.length>0}/>
    </div></Collapsible.Panel>
  </Collapsible.Root>;
}
