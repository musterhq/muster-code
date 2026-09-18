import React from 'react';
import {ChevronRight} from 'lucide-react';
import {Collapsible} from '@base-ui/react/collapsible';
import {CopyButton} from './MessageBody';
import {useDisclosure} from './useDisclosure';

export function outputPreview(text:string):{preview:string;truncated:boolean}{
 const preview=text.slice(0,2400).split('\n').slice(0,8).join('\n');
 return {preview,truncated:preview.length<text.length};
}
/** Progressive output preview; source text remains literal, never interpreted as UI. */
export function ToolOutput({text,id,language='plaintext'}:{text:string;id:string;language?:string}){
 const [expanded,setExpanded]=useDisclosure('output:'+id);
 const {preview,truncated}=outputPreview(text);
 return <div className="tool-result" data-preview={truncated&&!expanded}>
  <header><span>{language}</span><CopyButton getText={()=>text} label="Copy output"/></header>
  <pre className="tool-result-text" tabIndex={0}>{expanded?text:preview}</pre>
  {truncated&&<button className="tool-result-expand" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Show less':'Show full output'}</button>}
 </div>;
}
export function ToolDetail({label,text,id,language}:{label:string;text:string;id:string;language?:string}){
 const [open,setOpen]=useDisclosure('detail:'+id);
 return <Collapsible.Root open={open} onOpenChange={setOpen} className="tool-detail">
  <Collapsible.Trigger className="tool-detail-trigger"><ChevronRight className="tool-chevron" size={12}/><span>{label}</span></Collapsible.Trigger>
  <Collapsible.Panel className="activity-disclosure"><ToolOutput text={text} id={id} language={language}/></Collapsible.Panel>
 </Collapsible.Root>;
}
