import React,{useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ChevronDown} from 'lucide-react';
import {REASONING_EFFORTS,type ReasoningEffort} from '../../../shared/protocol';
import type {ModelPreference} from '../../../shared/domains/settings-protocol';
import {loadProviders,openAppSettings} from '../../store';
import {useStoreSelector} from '../../useStore';
import {ProviderLogo} from '../ProviderLogo';
import {EFFORT_LABELS} from '../composerMenus';
import {ModelPicker} from '../ModelPicker';
import './default-model-picker.css';

/**
 * Provider + model + reasoning picker for a default model (Settings → General, Project settings, folder defaults,
 * automations). The menu is the shared {@link ModelPicker}: provider rail, search, visibility policy and reasoning
 * control, opening on the current choice. `null` means "follow the next level".
 */
export function DefaultModelPicker({label,value,emptyLabel,onChange,disabled=false,showEffort=true}:{label:string;value:ModelPreference|null;emptyLabel:string;onChange:(value:ModelPreference|null)=>void;disabled?:boolean;showEffort?:boolean}):React.ReactElement {
  const state={providers:useStoreSelector(current=>current.providers)};
  const [open,setOpen]=useState(false);
  const [placement,setPlacement]=useState<{top?:number;bottom?:number;right:number}|null>(null);
  const wrap=useRef<HTMLSpanElement>(null),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
  const listId=useId();
  useEffect(()=>{if(state.providers.phase==='idle')void loadProviders();},[state.providers.phase]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  // The menu is portalled to <body> and fixed to the viewport (a Settings group clips its overflow and a sheet's
  // translate would re-anchor a fixed child) and opens upward when the trigger sits
  // too low for it to fit below. It follows the trigger while an ancestor scrolls or the window resizes.
  const measure=()=>{
    const box=trigger.current?.getBoundingClientRect();
    if(!box||typeof window.innerHeight!=='number')return null;
    const height=Math.min(420,window.innerHeight*.6)+12,below=window.innerHeight-box.bottom,right=Math.max(8,window.innerWidth-box.right);
    return below>=height||below>=box.top?{top:box.bottom+6,right}:{bottom:window.innerHeight-box.top+6,right};
  };
  const openMenu=()=>{setPlacement(measure());setOpen(true);};
  useLayoutEffect(()=>{
    if(!open)return;
    // The menu's own list scrolling does not move the trigger.
    const place=(event?:Event)=>{if(event?.target instanceof Node&&menu.current?.contains(event.target))return;setPlacement(measure());};
    window.addEventListener('resize',place);document.addEventListener('scroll',place,true);
    return ()=>{window.removeEventListener('resize',place);document.removeEventListener('scroll',place,true);};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open]);
  useEffect(()=>{
    if(!open)return;
    const down=(event:MouseEvent)=>{const target=event.target as Node;if(wrap.current&&!wrap.current.contains(target)&&!menu.current?.contains(target))setOpen(false);};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}};
    document.addEventListener('mousedown',down);document.addEventListener('keydown',key);
    return ()=>{document.removeEventListener('mousedown',down);document.removeEventListener('keydown',key);};
  },[open]);
  const providers=(state.providers.value??[]).filter(provider=>provider.available&&provider.models.length);
  const provider=value?providers.find(entry=>entry.id===value.providerId):undefined;
  const model=value?provider?.models.find(entry=>entry.id===value.model):undefined;
  const efforts:readonly ReasoningEffort[]=model&&showEffort?model.efforts??REASONING_EFFORTS:[];
  const effort=showEffort?(value?.effort&&efforts.includes(value.effort)?value.effort:model?.defaultEffort):undefined;
  const unavailable=Boolean(value&&!model&&state.providers.phase==='ready');
  const name=value?model?.name??value.model:emptyLabel;
  const close=()=>{setOpen(false);trigger.current?.focus();};
  // Escape closes only the menu, never the sheet or form around it.
  return <span className="default-model" ref={wrap} onKeyDown={event=>{if(open&&event.key==='Escape'){event.stopPropagation();event.preventDefault();close();}}}>
    <button ref={trigger} type="button" className="settings-button secondary default-model-trigger" aria-label={`${label}: ${name}${effort?` · ${EFFORT_LABELS[effort]}`:''}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open?listId:undefined} disabled={disabled} onClick={()=>{if(open)setOpen(false);else openMenu();}} onKeyDown={event=>{if(!open&&(event.key==='ArrowDown'||event.key==='ArrowUp')){event.preventDefault();openMenu();}}}>
      {value&&<ProviderLogo id={value.providerId} name={provider?.name??value.providerId} endpoint={provider?.endpoint} size={14}/>}
      <span className="default-model-name">{name}</span>
      {effort&&<span className="default-model-effort">{EFFORT_LABELS[effort]}</span>}
      {unavailable&&<span className="default-model-warn">Unavailable</span>}
      <ChevronDown size={12} aria-hidden="true"/>
    </button>
    {open&&createPortal(<div ref={menu} className="default-model-menu" role="dialog" aria-label={label} style={placement??undefined}>
      <ModelPicker providers={providers} selected={value?{providerId:value.providerId,model:value.model}:null} phase={state.providers.phase} error={state.providers.error}
        label={label} listId={listId} initialFocus="selected" onTabOut={()=>setOpen(false)}
        emptyOption={{label:emptyLabel,selected:!value,onSelect:()=>{onChange(null);close();}}}
        onSelect={option=>{
          const keep=value?.effort&&(option.efforts??REASONING_EFFORTS).includes(value.effort)?{effort:value.effort}:{};
          onChange({providerId:option.providerId,model:option.id,...(showEffort?keep:{})});
          if(!showEffort)close();
        }}
        onManageHidden={()=>{setOpen(false);openAppSettings('models');}}
        efforts={value?efforts:[]} effort={effort} onEffort={level=>{if(value)onChange({...value,effort:level});}} effortLabel="Default reasoning effort"/>
    </div>,document.body)}
  </span>;
}
