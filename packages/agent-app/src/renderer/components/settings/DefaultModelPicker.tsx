import React,{useEffect,useId,useRef,useState} from 'react';
import {Check,ChevronDown} from 'lucide-react';
import {REASONING_EFFORTS,type ReasoningEffort} from '../../../shared/protocol';
import type {ModelPreference} from '../../../shared/domains/settings-protocol';
import {loadProviders} from '../../store';
import {useStoreSelector} from '../../useStore';
import {ProviderLogo} from '../ProviderLogo';
import {EFFORT_LABELS} from '../composerMenus';
import './default-model-picker.css';

/**
 * Provider + model + reasoning picker for a default model (Settings → General, Project settings).
 * Lists the same ready providers' models as the composer's model menu. `null` means "follow the next level".
 */
export function DefaultModelPicker({label,value,emptyLabel,onChange,disabled=false}:{label:string;value:ModelPreference|null;emptyLabel:string;onChange:(value:ModelPreference|null)=>void;disabled?:boolean}):React.ReactElement {
  const state={providers:useStoreSelector(current=>current.providers)};
  const [open,setOpen]=useState(false);
  const wrap=useRef<HTMLSpanElement>(null),trigger=useRef<HTMLButtonElement>(null),list=useRef<HTMLDivElement>(null);
  const listId=useId();
  useEffect(()=>{if(state.providers.phase==='idle')void loadProviders();},[state.providers.phase]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  // Opening moves focus into the list — onto the current choice — so arrow keys work straight away.
  useEffect(()=>{
    if(!open)return;
    const options=optionsIn(list.current);
    (options.find(option=>option.getAttribute('aria-selected')==='true')??options[0])?.focus();
  },[open]);
  const onListKey=(event:React.KeyboardEvent)=>{
    const options=optionsIn(list.current);
    if(!options.length)return;
    const at=options.indexOf(document.activeElement as HTMLElement);
    const next=event.key==='ArrowDown'?(at+1)%options.length:event.key==='ArrowUp'?(at<=0?options.length-1:at-1):event.key==='Home'?0:event.key==='End'?options.length-1:-1;
    if(next>=0){event.preventDefault();options[next]!.focus();}
    else if(event.key==='Tab'){setOpen(false);}
  };
  useEffect(()=>{
    if(!open)return;
    const down=(event:MouseEvent)=>{if(wrap.current&&!wrap.current.contains(event.target as Node))setOpen(false);};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}};
    document.addEventListener('mousedown',down);document.addEventListener('keydown',key);
    return ()=>{document.removeEventListener('mousedown',down);document.removeEventListener('keydown',key);};
  },[open]);
  const providers=(state.providers.value??[]).filter(provider=>provider.available&&provider.models.length);
  const provider=value?providers.find(entry=>entry.id===value.providerId):undefined;
  const model=value?provider?.models.find(entry=>entry.id===value.model):undefined;
  const efforts:readonly ReasoningEffort[]=model?model.efforts??REASONING_EFFORTS:[];
  const effort=value?.effort&&efforts.includes(value.effort)?value.effort:model?.defaultEffort;
  const unavailable=Boolean(value&&!model&&state.providers.phase==='ready');
  const pick=(next:ModelPreference|null)=>{onChange(next);};
  const name=value?model?.name??value.model:emptyLabel;
  return <span className="default-model" ref={wrap}>
    <button ref={trigger} type="button" className="settings-button secondary default-model-trigger" aria-label={`${label}: ${name}${effort?` · ${EFFORT_LABELS[effort]}`:''}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open?listId:undefined} disabled={disabled} onClick={()=>setOpen(!open)} onKeyDown={event=>{if(!open&&(event.key==='ArrowDown'||event.key==='ArrowUp')){event.preventDefault();setOpen(true);}}}>
      {value&&<ProviderLogo id={value.providerId} name={provider?.name??value.providerId} endpoint={provider?.endpoint} size={14}/>}
      <span className="default-model-name">{name}</span>
      {effort&&<span className="default-model-effort">{EFFORT_LABELS[effort]}</span>}
      {unavailable&&<span className="default-model-warn">Unavailable</span>}
      <ChevronDown size={12} aria-hidden="true"/>
    </button>
    {open&&<div className="default-model-menu">
      <div className="default-model-list" id={listId} role="listbox" aria-label={label} ref={list} onKeyDown={onListKey}>
        <button type="button" role="option" aria-selected={!value} tabIndex={-1} onClick={()=>{pick(null);setOpen(false);trigger.current?.focus();}}>
          <span className="default-model-option-name">{emptyLabel}</span>{!value&&<Check size={14} aria-hidden="true"/>}
        </button>
        {state.providers.phase==='loading'&&!providers.length&&<p className="default-model-note" role="status">Loading models…</p>}
        {state.providers.phase==='error'&&<p className="default-model-note">{state.providers.error??'Models could not be loaded.'}</p>}
        {state.providers.phase==='ready'&&!providers.length&&<p className="default-model-note">No provider is ready for chats yet.</p>}
        {providers.map(entry=><div key={entry.id} className="default-model-group" role="group" aria-label={entry.name}>
          <span className="default-model-section"><ProviderLogo id={entry.id} name={entry.name} endpoint={entry.endpoint} size={13}/>{entry.name}</span>
          {entry.models.map(option=>{
            const selected=value?.providerId===entry.id&&value.model===option.id;
            return <button key={option.id} type="button" role="option" aria-selected={selected} tabIndex={-1} data-model={option.id} onClick={()=>{pick({providerId:entry.id,model:option.id,...(value?.effort&&(option.efforts??REASONING_EFFORTS).includes(value.effort)?{effort:value.effort}:{})});}}>
              <span className="default-model-option-name">{option.name}</span>{selected&&<Check size={14} aria-hidden="true"/>}
            </button>;
          })}
        </div>)}
      </div>
      {value&&efforts.length>0&&<div className="default-model-effort-row">
        <span className="default-model-effort-title">Reasoning</span>
        <div className="default-model-segments" role="radiogroup" aria-label="Default reasoning effort">
          {efforts.map(level=><button key={level} type="button" role="radio" aria-checked={effort===level} onClick={()=>pick({...value,effort:level})}>{EFFORT_LABELS[level]}</button>)}
        </div>
      </div>}
    </div>}
  </span>;
}

/** The listbox's options in visual order (roving focus: none is in the Tab order). */
function optionsIn(list:HTMLElement|null):HTMLElement[] {
  return list?Array.from(list.querySelectorAll<HTMLElement>('[role="option"]')):[];
}
