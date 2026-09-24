import React from 'react';
import {EarlierOutput} from './EarlierOutput';
import {Check,ChevronRight,MessageSquarePlus} from 'lucide-react';
import {addComposerContext} from '../composerContext';
import {copyText} from '../clipboard';
import {Collapsible} from '@base-ui/react/collapsible';
import {CopyButton} from './MessageBody';
import {useDisclosure} from './useDisclosure';
import {InlineDiff} from './InlineDiff';
import {useVirtualizer} from '@tanstack/react-virtual';
import {Tip} from './Tooltip';

/** Commands preview 4 lines (Codex); patches preview 40 so an edit reads inline before 'Show full output'. */
export const PREVIEW_LINES=4,PATCH_PREVIEW_LINES=40;
export function outputPreview(text:string,lines=PREVIEW_LINES):{preview:string;truncated:boolean}{
 const preview=text.slice(0,lines>PREVIEW_LINES?12000:2400).split('\n').slice(0,lines).join('\n');
 return {preview,truncated:preview.length<text.length};
}
/** The selected part of `root`'s text, if the selection lies inside it. */
export function selectionWithin(root:Element|null):string{
 const selection=window.getSelection?.();
 if(!root||!selection||!selection.rangeCount||!root.contains(selection.anchorNode)||!root.contains(selection.focusNode))return '';
 return selection.toString();
}
/** RUN-06: a tool's output (or the selected part) goes to the composer as a terminal chip naming its source item and time. */
export function AddOutputToChat({text,id,language,path,root}:{text:string;id:string;language:string;path?:string;root:React.RefObject<HTMLElement|null>}){
 const [state,setState]=React.useState<''|'added'|'copied'>('');
 React.useEffect(()=>{if(!state)return;const timer=window.setTimeout(()=>setState(''),1500);return()=>window.clearTimeout(timer);},[state]);
 const add=()=>{
  const picked=selectionWithin(root.current),excerpt=picked.trim()?picked:text;
  const name=path?path.split('/').pop()!:language==='diff'?'Patch':'Command output';
  const label=`${name}${picked.trim()?' · selection':''}`;
  if(addComposerContext({type:language==='diff'?'selection':'terminal',label,text:excerpt,source:{kind:'tool',itemId:id,...(path?{path}:{}),language:language==='plaintext'?'console':language,at:new Date().toISOString()}})){setState('added');return;}
  void copyText(excerpt).then(()=>setState('copied'),()=>{});
 };
 return <Tip label="Add output (or the selected part) to the chat"><button type="button" className="md-copy tool-add-context" aria-label={state==='added'?'Added to chat':state==='copied'?'Copied: no chat composer open':'Add to chat'} onMouseDown={event=>event.preventDefault()} onClick={add}>{state?<Check size={13}/>:<MessageSquarePlus size={13}/>}</button></Tip>;
}
/** Progressive output preview; source text remains literal, never interpreted as UI. */
export function ToolOutput({text,id,language='plaintext',sourceTruncated=false,path,chatId}:{text:string;id:string;language?:string;sourceTruncated?:boolean;path?:string;chatId?:string}){
 const [expanded,setExpanded]=useDisclosure('output:'+id);
 const {preview,truncated}=outputPreview(text,language==='diff'?PATCH_PREVIEW_LINES:PREVIEW_LINES);
 const body=React.useRef<HTMLDivElement>(null);
 return <div ref={body} className="tool-result" data-preview={truncated&&!expanded}>
  <header><span>{language}</span><AddOutputToChat text={text} id={id} language={language} path={path} root={body}/><CopyButton getText={()=>text} label={sourceTruncated?"Copy retained output":"Copy output"}/></header>
  {sourceTruncated&&(chatId?<EarlierOutput chatId={chatId} itemId={id} tail={text}/>:<p className="tool-output-limit">Only the end of this long output was retained.</p>)}
  {language==='diff'?<InlineDiff text={expanded?text:preview} path={path}/>:expanded&&lineCount(text)>VIRTUAL_OUTPUT_LINES?<VirtualOutput text={text}/>:<pre className="tool-result-text" tabIndex={0}>{expanded?text:preview}</pre>}
  {truncated&&<button className="tool-result-expand" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Show less':sourceTruncated?'Show retained output':'Show full output'}</button>}
 </div>;
}
/** PER-03: past this many lines an expanded output mounts only the visible lines (the pre already scrolls at 420px). */
export const VIRTUAL_OUTPUT_LINES=400;
function lineCount(text:string):number{let count=1;for(let index=text.indexOf('\n');index!==-1&&count<=VIRTUAL_OUTPUT_LINES;index=text.indexOf('\n',index+1))count++;return count;}
/** Wrapped lines have measured heights; selection covers the mounted lines, Copy output always copies everything. */
function VirtualOutput({text}:{text:string}){
 const lines=React.useMemo(()=>text.split('\n'),[text]);
 const scroller=React.useRef<HTMLPreElement>(null);
 const virtualizer=useVirtualizer({count:lines.length,getScrollElement:()=>scroller.current,estimateSize:()=>19,overscan:40});
 return <pre ref={scroller} className="tool-result-text tool-result-virtual" tabIndex={0} aria-label={`Output, ${lines.length} lines`}>
  <div style={{height:virtualizer.getTotalSize(),position:'relative'}}>
   {virtualizer.getVirtualItems().map(item=><div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="tool-result-line" style={{position:'absolute',top:0,left:0,right:0,transform:`translateY(${item.start}px)`}}>{lines[item.index]||'\u200b'}</div>)}
  </div>
 </pre>;
}
export function ToolDetail({label,text,id,language,path,defaultOpen=false}:{label:string;text:string;id:string;language?:string;path?:string;defaultOpen?:boolean}){
 const [open,setOpen]=useDisclosure('detail:'+id,defaultOpen);
 return <Collapsible.Root open={open} onOpenChange={setOpen} className="tool-detail">
  <Collapsible.Trigger className="tool-detail-trigger"><ChevronRight className="tool-chevron" size={12}/><span>{label}</span></Collapsible.Trigger>
  <Collapsible.Panel className="activity-disclosure"><ToolOutput text={text} id={id} language={language} path={path}/></Collapsible.Panel>
 </Collapsible.Root>;
}
