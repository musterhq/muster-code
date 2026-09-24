/**
 * R9 guided first run: step order, when it opens by itself, and the checklist rows Settings › General shows.
 * Pure functions plus a tiny open/closed store, so the flow is testable without React or the runtime.
 */
import {useSyncExternalStore} from 'react';
import {SETUP_STEPS,type SetupProgress,type SetupStatus,type SetupStep} from '../shared/domains/setup-protocol.ts';
import type {ComputerPermissions} from '../shared/domains/computer-protocol.ts';

/** Nothing can run a chat and no CLI sign-in or connection is even on file. Only then does the guide open by itself. */
export function nothingSignedIn(status: Pick<SetupStatus,'readyProviders'|'clis'|'connections'>): boolean {
  return status.readyProviders.length===0&&!status.clis.some(cli=>cli.signedIn||cli.ready)&&!status.connections.some(row=>row.ready);
}
/** Auto-open on launch: not finished, not put off with "Set up later", and nothing signed in. */
export function shouldAutoOpenSetup(status: Pick<SetupStatus,'readyProviders'|'clis'|'connections'>, progress: SetupProgress): boolean {
  return !progress.completedAt&&!progress.dismissedAt&&nothingSignedIn(status);
}
/** Where a (re)opened guide lands: the saved step, except a finished guide starts over at the checklist's first gap. */
export function resumeStep(progress: SetupProgress, status?: Pick<SetupStatus,'readyProviders'>): SetupStep {
  if(!progress.completedAt)return progress.step;
  return status&&!status.readyProviders.length?'connect':'welcome';
}
export const stepIndex=(step: SetupStep)=>SETUP_STEPS.indexOf(step);
export const nextStep=(step: SetupStep): SetupStep=>SETUP_STEPS[Math.min(stepIndex(step)+1,SETUP_STEPS.length-1)]!;
export const previousStep=(step: SetupStep): SetupStep=>SETUP_STEPS[Math.max(stepIndex(step)-1,0)]!;
/** Skipping an optional step records it and moves on; a required step is never "skipped", only continued past. */
export function skipStep(progress: SetupProgress): SetupProgress {
  const skipped=progress.skipped.includes(progress.step)?progress.skipped:[...progress.skipped,progress.step];
  return {...progress,step:nextStep(progress.step),skipped};
}

export type ChecklistState='done'|'todo'|'optional'|'unknown';
export interface ChecklistItem {id:string;label:string;state:ChecklistState;detail:string;step:SetupStep}
const permissionWord=(state: string|undefined)=>state==='granted'?'on':state==='denied'?'off':state==='restricted'?'restricted by policy':'not checked yet';
/** Live rows for the Setup checklist. Unknown stays unknown; nothing is shown as done that was not detected. */
export function setupChecklist(status: SetupStatus|null, extra: {folders: number; permissions?: ComputerPermissions|null; notifications?: string}): ChecklistItem[] {
  const ready=status?.readyProviders??[];
  const docker=status?.docker, git=status?.git, perms=extra.permissions;
  const computer=perms?(perms.screen==='granted'&&perms.accessibility==='granted'?'done':perms.screen==='unknown'&&perms.accessibility==='unknown'?'unknown':'optional'):'unknown';
  return [
    {id:'model',label:'Connect a model',step:'connect',state:!status?'unknown':ready.length?'done':'todo',
      detail:!status?'Checking…':ready.length?`${ready.map(provider=>provider.name).join(', ')} ready`:'No provider can run a chat yet'},
    {id:'folder',label:'Add a folder',step:'folder',state:extra.folders>0?'done':'todo',detail:extra.folders>0?`${extra.folders} ${extra.folders===1?'folder':'folders'} added`:'Chats work in a folder on this Mac'},
    {id:'git',label:'Git',step:'folder',state:!git?'unknown':git.available?'done':'optional',detail:git?.detail??'Checking…'},
    {id:'sandbox',label:'Sandbox (Docker)',step:'capabilities',state:!docker?'unknown':docker.running?'done':'optional',detail:docker?.detail??'Checking…'},
    {id:'computer',label:'Computer use',step:'capabilities',state:computer,detail:perms?`Screen Recording ${permissionWord(perms.screen)} · Accessibility ${permissionWord(perms.accessibility)}`:'Checking…'},
    {id:'notifications',label:'Notifications',step:'capabilities',state:extra.notifications==='off'?'optional':'unknown',
      detail:extra.notifications==='off'?'Turned off in Muster':'macOS asks the first time Muster notifies; review it in System Settings'},
  ];
}

/** Starter prompts on the Done step. They fill a new-chat draft; nothing is sent until the user sends it. */
export const SETUP_SUGGESTIONS=[
  {label:'Explain this codebase',prompt:'Give me a tour of this codebase: what it does, how it is structured, and where to start reading.'},
  {label:'Find a bug to fix',prompt:'Look through this project for a likely bug, explain it, and propose a fix.'},
  {label:'Add tests',prompt:'Find an important piece of this project with no tests and write focused tests for it.'},
  {label:'Plan a feature',prompt:'Help me plan a new feature for this project. Ask me what I want to build first.'},
] as const;

// ---- open/closed state (module level, like the import and clone sheets) ----
export interface SetupGuideView {open:boolean;step:SetupStep;addConnection:boolean}
let view: SetupGuideView={open:false,step:'welcome',addConnection:false};
const listeners=new Set<()=>void>();
const publish=(next: SetupGuideView)=>{view=next;for(const listener of listeners)listener();};
export function openSetupGuide(step?: SetupStep, options: {addConnection?: boolean}={}): void { publish({open:true,step:step??view.step,addConnection:Boolean(options.addConnection)}); }
export function setSetupStep(step: SetupStep): void { if(view.step!==step)publish({...view,step,addConnection:false}); }
export function closeSetupGuide(): void { if(view.open)publish({...view,open:false,addConnection:false}); }
export function getSetupGuide(): SetupGuideView { return view; }
export function useSetupGuide(): SetupGuideView { return useSyncExternalStore(listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},getSetupGuide,getSetupGuide); }
/** Test seam. */
export function resetSetupGuide(): void { publish({open:false,step:'welcome',addConnection:false}); }
