import React,{useId,useRef,useState} from 'react';
import {Download,Trash2,Upload} from 'lucide-react';
import type {AppSettings} from '../../../shared/domains/settings-protocol';
import {BUILT_IN_THEMES,MAX_CUSTOM_THEMES,ThemeImportError,effectiveTokens,exportTheme,importThemeFile,type Theme,type ThemeBase} from '../../../shared/theme.ts';
import {notifyError} from '../../store';
import {device} from '../../../shared/device-noun.ts';

type Setter=<K extends keyof AppSettings>(key:K,value:AppSettings[K])=>void;

/** A miniature window painted with the theme's own tokens, so the swatch is the theme (live preview). */
export function ThemeSwatch({theme}:{theme:Theme}):React.ReactElement {
  const t=effectiveTokens(theme);
  return <span className="theme-swatch" aria-hidden="true" style={{background:t.bg,borderColor:t.hairline}}>
    <span className="theme-swatch-nav" style={{background:t['nav-solid'],borderColor:t.hairline}}/>
    <span className="theme-swatch-body">
      <span className="theme-swatch-card" style={{background:t['bg-raised'],borderColor:t.hairline,color:t.text}}>Aa</span>
      <span className="theme-swatch-dots"><i style={{background:t.accent}}/><i style={{background:t.link}}/><i style={{background:t.ok}}/><i style={{background:t.warn}}/><i style={{background:t.danger}}/></span>
    </span>
  </span>;
}

function Picker({label,base,themes,value,onSelect}:{label:string;base:ThemeBase;themes:readonly Theme[];value:string;onSelect:(id:string)=>void}):React.ReactElement {
  const options=themes.filter(theme=>theme.base===base);
  const refs=useRef<Array<HTMLButtonElement|null>>([]);
  const selected=options.some(theme=>theme.id===value)?value:options[0]!.id;
  const move=(event:React.KeyboardEvent,index:number)=>{
    const step=event.key==='ArrowRight'||event.key==='ArrowDown'?1:event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:0;
    if(!step)return;
    event.preventDefault();
    const next=(index+step+options.length)%options.length;
    onSelect(options[next]!.id);refs.current[next]?.focus();
  };
  return <span className="theme-picker" role="radiogroup" aria-label={label}>
    {options.map((theme,index)=><button key={theme.id} ref={el=>{refs.current[index]=el;}} type="button" role="radio" className="theme-option" aria-checked={theme.id===selected} tabIndex={theme.id===selected?0:-1} onKeyDown={event=>move(event,index)} onClick={()=>onSelect(theme.id)}>
      <ThemeSwatch theme={theme}/><span className="theme-option-name">{theme.name}</span>
    </button>)}
  </span>;
}

function ThemeRow({title,description,children}:{title:string;description:string;children:React.ReactNode}):React.ReactElement {
  const id=useId();
  return <div className="preference-row theme-row" role="group" aria-labelledby={id}>
    <span className="preference-copy"><strong id={id}>{title}</strong><span>{description}</span></span>
    <span className="preference-control theme-control">{children}</span>
  </div>;
}

function download(name:string,text:string):void {
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');
  link.href=url;link.download=`${name}.json`;
  document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/** Settings › Appearance: colour theme for light, for dark, and the user's imported themes. */
export function ThemeRows({settings,set}:{settings:AppSettings;set:Setter}):React.ReactElement {
  const custom=settings['appearance.customThemes'];
  const all=[...BUILT_IN_THEMES,...custom];
  const file=useRef<HTMLInputElement>(null);
  const [status,setStatus]=useState('');
  const choose=(base:ThemeBase,id:string)=>set(base==='light'?'appearance.lightTheme':'appearance.darkTheme',id);
  const importFile=async(picked:File|undefined)=>{
    if(!picked)return;
    try{
      if(custom.length>=MAX_CUSTOM_THEMES)throw new ThemeImportError(`You can keep ${MAX_CUSTOM_THEMES} custom themes. Delete one first.`);
      const {theme,warnings}=importThemeFile(await picked.text(),custom.map(entry=>entry.id));
      set('appearance.customThemes',[...custom,theme]);
      choose(theme.base,theme.id);
      setStatus(`Imported “${theme.name}” as a ${theme.base} theme. ${warnings.join(' ')}`);
    }catch(cause){
      setStatus('');
      notifyError(cause);
    }finally{if(file.current)file.current.value='';}
  };
  const remove=(theme:Theme)=>{
    set('appearance.customThemes',custom.filter(entry=>entry.id!==theme.id));
    if(settings['appearance.lightTheme']===theme.id)choose('light','muster-light');
    if(settings['appearance.darkTheme']===theme.id)choose('dark','muster-dark');
  };
  return <>
    <ThemeRow title="Light theme" description="The colours used when the window is light, including when Theme is System and macOS is light.">
      <Picker label="Light theme" base="light" themes={all} value={settings['appearance.lightTheme']} onSelect={id=>choose('light',id)}/>
    </ThemeRow>
    <ThemeRow title="Dark theme" description="The colours used when the window is dark, including when Theme is System and macOS is dark.">
      <Picker label="Dark theme" base="dark" themes={all} value={settings['appearance.darkTheme']} onSelect={id=>choose('dark',id)}/>
    </ThemeRow>
    <ThemeRow title="Custom themes" description={`Import a VS Code colour theme (.json) or a theme exported from Muster. Themes stay on ${device().lower}.`>
      <span className="theme-custom">
        <span className="theme-custom-actions">
          <button type="button" className="settings-button secondary" onClick={()=>file.current?.click()}><Upload size={14}/>Import VS Code theme…</button>
          <input ref={file} type="file" accept=".json,.jsonc,application/json" hidden aria-label="Theme file" onChange={event=>void importFile(event.target.files?.[0])}/>
        </span>
        {custom.map(theme=><span className="theme-custom-item" key={theme.id}>
          <ThemeSwatch theme={theme}/>
          <span className="theme-custom-name">{theme.name}<small>{theme.base}</small></span>
          <button type="button" className="icon-button" aria-label={`Export ${theme.name}`} title="Export as JSON" onClick={()=>download(theme.id,exportTheme(theme))}><Download size={14}/></button>
          <button type="button" className="icon-button" aria-label={`Delete ${theme.name}`} title="Delete" onClick={()=>remove(theme)}><Trash2 size={14}/></button>
        </span>)}
        <span className="theme-custom-status" role="status">{status}</span>
      </span>
    </ThemeRow>
  </>;
}
