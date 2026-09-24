/** Codex-style app marks for computer-use rows and the PiP stack: a small tinted tile per app or page. */
import React from 'react';
import {Calendar,Code2,FileText,Folder,Globe,Hammer,Hash,Image as ImageIcon,Mail,MapPin,MessageCircle,Monitor,Music,PenTool,Settings,SquareTerminal,StickyNote} from 'lucide-react';
import type {ComputerTarget} from '../../shared/computer-use';
import {agentHue} from '../agentIdentity';
import './app-glyph.css';

type Icon=React.ComponentType<{size?:number;strokeWidth?:number;'aria-hidden'?:boolean|'true'}>;
/** Well-known apps: icon, hue and saturation. Browsers read as a globe, like Codex's Chrome integration. */
const KNOWN:[RegExp,Icon,number,number][]=[
  [/chrome|safari|firefox|\barc\b|edge|brave|opera|browser|chromium/i,Globe,212,72],
  [/mail|outlook|spark/i,Mail,208,78],
  [/finder|files/i,Folder,204,70],
  [/terminal|iterm|warp|ghostty/i,SquareTerminal,220,8],
  [/notes/i,StickyNote,44,86],
  [/calendar/i,Calendar,4,72],
  [/messages|whatsapp|telegram|signal/i,MessageCircle,134,58],
  [/music|spotify/i,Music,350,72],
  [/photos|preview/i,ImageIcon,28,82],
  [/slack|discord/i,Hash,296,48],
  [/xcode/i,Hammer,214,74],
  [/settings|preferences/i,Settings,220,10],
  [/maps/i,MapPin,140,52],
  [/figma|sketch/i,PenTool,14,78],
  [/notion|pages|word|docs/i,FileText,220,14],
  [/code|cursor|zed|sublime|intellij|webstorm|muster/i,Code2,206,64],
];
/** The mark for one app or page: `app` is the app name (or page title/host), `target` whether it is the in-app browser. */
export function appMark(app:string,target:ComputerTarget):{icon?:Icon;hue:number;sat:number;letter:string} {
  const name=app.trim();
  if(target==='browser')return {icon:Globe,hue:212,sat:72,letter:''};
  for(const [pattern,icon,hue,sat] of KNOWN) if(pattern.test(name))return {icon,hue,sat,letter:''};
  if(!name)return {icon:Monitor,hue:220,sat:10,letter:''};
  return {hue:agentHue(name),sat:58,letter:(name.match(/[\p{L}\p{N}]/u)?.[0]??'?').toUpperCase()};
}
export function AppGlyph({app,target,size=16,running=false}:{app:string;target:ComputerTarget;size?:number;running?:boolean}) {
  const mark=appMark(app,target),Icon=mark.icon;
  return <span className={`app-glyph${running?' is-active':''}`} aria-hidden="true" data-app={app||undefined} style={{'--app-hue':mark.hue,'--app-sat':`${mark.sat}%`,'--app-size':`${size}px`} as React.CSSProperties}>
    {Icon?<Icon size={Math.round(size*0.66)} strokeWidth={2}/>:<span className="app-glyph-letter">{mark.letter}</span>}
  </span>;
}
