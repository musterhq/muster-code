import React,{useEffect,useRef,useSyncExternalStore} from 'react';
import {PanelRight,X} from 'lucide-react';
import {DOCK_MIN,setTerminalDock,subscribeTerminalDock,terminalDock} from '../processSummary';
import {focusComposer} from '../focus';
import {useStoreSelector} from '../useStore';
import {openTerminalTab,TerminalsPanel} from './ProcessesTab';
import './terminal-dock.css';

const maxHeight=()=>Math.max(DOCK_MIN,Math.round((typeof window!=='undefined'&&Number(window.innerHeight)||800)*0.7));
const clamp=(value:number)=>Math.round(Math.max(DOCK_MIN,Math.min(maxHeight(),value)));
/** ⌃` toggles the bottom panel from anywhere in the window, including inside a shell. */
const isToggle=(event:KeyboardEvent)=>event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&(event.code==='Backquote'||event.key==='`');

/** Bottom terminal panel under the conversation: the same PTYs (one live xterm per
 * shell, moved rather than rebuilt) as the right-pane Terminal tab, resizable, and
 * remembered per window. Mounted once by the chat surface; renders nothing when hidden. */
export function TerminalDock({chatId}:{chatId:string}) {
  const dock=useSyncExternalStore(subscribeTerminalDock,terminalDock);
  const title=useStoreSelector(state=>state.snapshot?.chats.find(chat=>chat.id===chatId)?.title)||'Conversation';
  const panel=useRef<HTMLElement>(null),drag=useRef<{y:number;height:number}|null>(null);
  const target=useRef({chatId,title});target.current={chatId,title};
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(!isToggle(event)||event.isComposing||event.defaultPrevented)return;
      event.preventDefault();event.stopPropagation();
      const current=terminalDock(),inside=!!panel.current?.contains(document.activeElement);
      // F30: ⌃` honours Settings › "Default terminal location" — Right opens the chat's Terminal tab in the
      // resource pane instead of silently switching the user's choice to Bottom.
      if(current.placement==='pane'){openTerminalTab(target.current.chatId,target.current.title,'terminals');return;}
      if(current.open){setTerminalDock({open:false});if(inside)focusComposer();}
      else setTerminalDock({open:true});
    };
    window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);
  },[]);
  if(dock.placement!=='panel'||!dock.open)return null;
  const height=clamp(dock.height);
  const hide=()=>{const inside=!!panel.current?.contains(document.activeElement);setTerminalDock({open:false});if(inside)focusComposer();};
  const move=(event:React.PointerEvent<HTMLDivElement>)=>{if(drag.current)setTerminalDock({height:clamp(drag.current.height+drag.current.y-event.clientY)},false);};
  const end=(event:React.PointerEvent<HTMLDivElement>)=>{
    if(!drag.current)return;drag.current=null;
    try{event.currentTarget.releasePointerCapture(event.pointerId);}catch{}
    setTerminalDock({height:terminalDock().height});
  };
  return <section ref={panel} className="terminal-dock" style={{height}} aria-label="Terminal panel">
    <div className="terminal-dock-resize" role="separator" aria-orientation="horizontal" aria-label="Resize terminal panel" aria-valuemin={DOCK_MIN} aria-valuemax={maxHeight()} aria-valuenow={height} tabIndex={0}
      onPointerDown={event=>{event.preventDefault();drag.current={y:event.clientY,height};event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      onDoubleClick={()=>setTerminalDock({height:clamp(260)})}
      onKeyDown={event=>{const step=event.shiftKey?64:16,next=event.key==='ArrowUp'?height+step:event.key==='ArrowDown'?height-step:null;if(next===null)return;event.preventDefault();setTerminalDock({height:clamp(next)});}}/>
    <TerminalsPanel key={chatId} chatId={chatId} active actions={<>
      <button type="button" className="terminal-tool" aria-label="Move terminals to the right pane" title="Move to right pane" onClick={()=>{setTerminalDock({placement:'pane',open:false});openTerminalTab(chatId,title,'terminals');}}><PanelRight size={13}/></button>
      <button type="button" className="terminal-tool" aria-label="Hide terminal panel" title="Hide panel (⌃`)" onClick={hide}><X size={13}/></button>
    </>}/>
  </section>;
}
