import {ToolOutput,ToolDetail} from './ToolOutput';
import {useDisclosure} from './useDisclosure';
import {copyText} from '../clipboard';
import { Blocks, BookOpen, Bot, Check, ChevronRight, Circle, CircleCheck, CircleDot, Copy, Image as ImageIcon, ListChecks, MousePointerClick, PencilLine, Search, Sparkles, SquareSlash, SquareTerminal, Wrench } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { TimelineItem } from '../../shared/protocol';
import { toolState, awaitingApproval, executionDenied, basename, classifyTool, commandLabel, commandOutcome, planPreview, planSteps, resolveToolPath, uniqueFileLabels, type PlanStep, type ToolKind } from './toolPresentation';
import {getState,loadPlugins,openFile} from '../store';
import {useStoreSelector} from '../useStore';
import {mcpMark,mcpToolLabel,type McpMark} from '../mcpIcons';
import {PluginIcon} from './PluginIcon';
import {openTerminalTab} from './ProcessesTab';
import './tool-card.css';
import {Collapsible} from '@base-ui/react/collapsible';
import {invoke} from '../bridge';
import {computerAction,type ComputerAction} from '../../shared/computer-use';
import {toolImageUrl,toolShots,type PipSource,type ToolShot} from '../computerUse';
import {itemPatches} from '../patchModel';
import {LaterEditsContext,laterEditsKey} from '../turnFileChanges';
import {FileChangeView} from './FileDiffEditor';
import {DiffStat} from './DiffStat';
import {MessageBody} from './MessageBody';
import {Tip} from './Tooltip';
import {AppGlyph} from './AppGlyph';
import {openScreenshotTab} from './ComputerPip';
import {ChatImage} from './ChatImage';
import {GalleryCoverage,ImageGallery,type GalleryTarget} from './ImageGallery';

type Glyph = React.ComponentType<{size?: number; strokeWidth?: number; 'aria-hidden'?: boolean | 'true'}>;
/** Codex transcript glyphs: thin, monochrome, one per verb. */
const ICONS: Record<ToolKind, Glyph> = {
  read: BookOpen, edit: PencilLine, search: Search, list: ListChecks, command: SquareTerminal, subagent: Bot, mcp: Blocks, computer: MousePointerClick, skill: Sparkles, generic: Wrench,
};
/** #729: an MCP or app tool row carries the mark of the plugin that provides it (Figma, GitHub, Google Drive…); unknown servers keep the generic glyph. */
function useMcpMark(item:TimelineItem,enabled=true):McpMark|undefined {
  const plugins=useStoreSelector(state=>state.plugins.value),phase=useStoreSelector(state=>state.plugins.phase);
  useEffect(()=>{if(enabled&&phase==='idle')void loadPlugins();},[enabled,phase]);
  if(!enabled)return undefined;
  const data=item.data,server=typeof data?.server==='string'?data.server:typeof data?.namespace==='string'?data.namespace:'',tool=typeof data?.tool==='string'?data.tool:'';
  return mcpMark(plugins,server,tool);
}
export function McpGlyph({item,running=false}:{item:TimelineItem;running?:boolean}) {
  const mark=useMcpMark(item);
  if(!mark)return <ToolGlyph kind="mcp" running={running}/>;
  return <span className={running?'tool-glyph is-plugin is-active':'tool-glyph is-plugin'} aria-hidden="true" data-plugin={mark.plugin}><PluginIcon icon={mark.icon} name={mark.plugin} brandColor={mark.brandColor} size={15}/></span>;
}
export function ToolGlyph({kind,running=false,image=false,slash=false}:{kind:ToolKind;running?:boolean;image?:boolean;slash?:boolean}) { const Icon=image?ImageIcon:slash?SquareSlash:ICONS[kind];return <span className={running?'tool-glyph is-active':'tool-glyph'} aria-hidden="true"><Icon size={15} strokeWidth={1.6}/></span>; }

/** CUA-06: screenshots in a tool result are pictures, never base64 text; click opens the full-resolution viewer. */
function Shot({shot,source,index}:{shot:ToolShot;source:PipSource;index:number}) {
  const [url,setUrl]=useState(shot.dataUrl);
  useEffect(()=>{if(shot.dataUrl){setUrl(shot.dataUrl);return;}let live=true;toolImageUrl(shot,id=>invoke('computer.image',{id})).then(value=>{if(live)setUrl(value);},()=>{});return()=>{live=false;};},[shot.id,shot.dataUrl]);
  return <button type="button" className="tool-shot" aria-label={`Open screenshot ${index+1} full size`} onClick={()=>openScreenshotTab({...source,image:shot})}>
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
  // #729: a Claude command's arguments are already in its command line; its source replaces the raw JSON.
  const command=d.type==='claudeCommand';
  const blocks=[[computer?'Details':'Arguments',command?null:d.arguments],['Result',d.result],['Error',d.error],['Task',d.prompt],['Agent status',d.agentsStates],['Output',d.contentItems]].filter(([label])=>!plan||label==='Error');
  return <div className="tool-details">
    {typeof d.command==='string'&&classifyTool(d).kind!=='command'&&<ToolDetail id={item.id+':command'} label="Command" text={d.command} language="shell"/>}
    <dl>{typeof d.cwd==='string'&&<><dt>Folder</dt><dd>{d.cwd}</dd></>}
      {typeof d.durationMs==='number'&&<><dt>Duration</dt><dd>{(d.durationMs/1000).toFixed(2)}s</dd></>}
      {typeof d.exitCode==='number'&&<><dt>Exit code</dt><dd>{d.exitCode}</dd></>}
      {typeof d.model==='string'&&<><dt>Model</dt><dd>{d.model}</dd></>}
      {command&&typeof d.source==='string'&&<><dt>Source</dt><dd>{d.source}</dd></>}
      {command&&typeof d.path==='string'&&<><dt>File</dt><dd>{d.path}</dd></>}
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

/** "Viewed 4 images": a strip of real thumbnails (ChatImage). A path inside a chat folder opens in the side pane; any other
 *  image the chat named (/tmp, a worktree under app data) is read through the chat itself and opens zoomed. */
function ImageThumb({item,path}:{item:TimelineItem;path:string}) {
  const to=fileTarget(item,path);
  return <ChatImage chatId={item.chatId} path={path} inFolder={to} onOpen={to?()=>void openFile(to.folderId,to.path):undefined}/>;
}
export function ImageThumbs({item,paths}:{item:TimelineItem;paths:readonly string[]}) {
  const covered=React.useContext(GalleryCoverage);
  // Images the turn's gallery already shows are not repeated under their tool rows.
  const shown=covered.size?paths.filter(path=>!covered.has(path)):paths;
  if(!shown.length)return null;
  return <div className="tool-thumbs">{shown.slice(0,12).map(path=><ImageThumb key={path} item={item} path={path}/>)}</div>;
}

/** An edit row opened: each changed file as the inline diff editor (the whole file when it can be read). */
function EditDiffs({item}:{item:TimelineItem}) {
  const patches=itemPatches(item.data);
  const history=React.useContext(LaterEditsContext);
  if(!patches.length)return null;
  return <div className="tool-edit-diffs">{patches.map((patch,index)=>{
    // The file as it is now: under its later name when the chat renamed it after this edit.
    const later=history.get(laterEditsKey(item.id,patch.path)),now=later?.path??patch.movePath??patch.path;
    return <div key={patch.path+index} className="tool-edit-diff">
      {patches.length>1&&<div className="tool-edit-diff-path" title={patch.path}><span>{patch.path}</span><DiffStat adds={patch.adds} dels={patch.dels}/></div>}
      <FileChangeView path={patch.movePath??patch.path} kind={patch.kind} target={fileTarget(item,now)} edit={{chatId:item.chatId,itemId:item.id,readPath:now}} later={later?.patches} patches={patch.patch?[{diff:patch.patch,adds:patch.adds,dels:patch.dels}]:[]} truncated={patch.truncated}/>
    </div>;
  })}</div>;
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
  // #580: a denied tool can stay open until the provider closes it; it is not running.
  const running = item.status === 'running' && !waiting && !executionDenied(item.data);
  const raw = p.subject || 'Tool';
  const prefix=typeof item.data?.name==='string'?item.data.name:raw;
  const output = typeof item.data?.output==='string'?item.data.output:item.text.startsWith(prefix) ? item.text.slice(prefix.length).replace(/^\n/, '') : item.text;
  const outcome=commandOutcome(item.data,item.status,output);
  const failed = outcome.failed;
  const state = toolState(item,p,failed);
  const images=p.images??[];
  const files=images.length>1?[]:p.kind==='edit'?p.files??[]:p.kind==='read'?(p.paths??(p.subject?[p.subject]:[])).map(path=>({path})):[];
  // Codex: a computer-use step carries its app's icon, so the line reads as the step alone ("Clicked “Send”").
  // #729: a connector call reads as its plugin and tool ("Used GitHub / search issues"); the raw server name stays in the tooltip.
  const mark=useMcpMark(item,p.kind==='mcp'&&!p.computer);
  const mcpSubject=mark&&typeof item.data?.title!=='string'&&typeof item.data?.tool==='string'?[mark.plugin,mcpToolLabel(item.data.tool,mark.plugin)].filter(Boolean).join(' / '):undefined;
  const subject=p.kind==='command'?commandLabel(raw):images.length>1?'':p.computer?computerStepSubject(p.computer):mcpSubject??p.subject;
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
      <Collapsible.Trigger className="tool-row-hit" aria-label={label} title={p.slash&&typeof item.data?.source==='string'?[item.data.source,item.data.path].filter(value=>typeof value==='string'&&value).join(' · '):p.subject||undefined}/>
      {p.computer?<AppGlyph app={p.computer.app} target={p.computer.target} running={running}/>:p.kind==='mcp'?<McpGlyph item={item} running={running}/>:<ToolGlyph kind={p.kind} running={running} image={images.length>0} slash={p.slash}/>}
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
      {(output||p.kind==='command')&&!steps.length&&!edit&&!p.planText&&<ToolOutput id={item.id} chatId={item.chatId} title={p.slash?'Expanded prompt':undefined} sourceTruncated={item.data?.outputTruncated===true} text={output || (running ? 'Waiting for output…' : 'No output')}/>}
      <Metadata item={item} plan={steps.length>0}/>
    </div></Collapsible.Panel>
  </Collapsible.Root>;
}

/** A turn's image gallery: paths resolve against the chat's folders; folder images open in the side pane. */
export function TurnGallery({chatId,paths}:{chatId:string;paths:readonly string[]}) {
  const resolve=React.useCallback((path:string):GalleryTarget|undefined=>{const {snapshot}=getState(),chat=snapshot?.chats.find(chat=>chat.id===chatId);return resolveToolPath(path,snapshot?.folders??[],chat?.folderId)??undefined;},[chatId]);
  const open=React.useCallback((target:GalleryTarget)=>void openFile(target.folderId,target.path),[]);
  return <ImageGallery chatId={chatId} paths={paths} resolve={resolve} onOpenFile={open}/>;
}
