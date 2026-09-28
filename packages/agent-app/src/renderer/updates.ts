import {useSyncExternalStore} from 'react';
import {invoke,subscribe} from './bridge';
import type {UpdateStatus} from '../shared/update-protocol';

/** Self-update status pushed by the main process (src/main/app-updater.ts), fetched once on first use. */
let status:UpdateStatus|undefined;
const listeners=new Set<()=>void>();
let started=false;
const publish=(next:UpdateStatus)=>{status=next;for(const listener of listeners)listener();};
function start():void {
  if(started)return;started=true;
  subscribe(event=>{if(event.type==='updateStatus')publish(event.status);});
  void invoke('updates.status',undefined).then(publish,()=>{});
}
function subscribeUpdates(listener:()=>void):()=>void {start();listeners.add(listener);return()=>{listeners.delete(listener);};}
export const useUpdateStatus=():UpdateStatus|undefined=>useSyncExternalStore(subscribeUpdates,()=>status);

export const checkForUpdates=():Promise<UpdateStatus>=>invoke('updates.check',undefined).then(next=>{publish(next);return next;});
export const setAutoCheckUpdates=(enabled:boolean):Promise<UpdateStatus>=>invoke('updates.setAutoCheck',{enabled}).then(next=>{publish(next);return next;});
export const installUpdate=():Promise<UpdateStatus>=>invoke('updates.install',undefined).then(next=>{publish(next);return next;});

/** Only macOS installs updates in place; Windows and Linux download the new version from the release page. */
export const INSTALLS_IN_PLACE = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** One line for Settings and tooltips. */
export function updateSummary(value:UpdateStatus):string {
  switch(value.phase){
    case 'disabled':return value.message??'Updates are off for this build.';
    case 'idle':return value.autoCheck?'Checks for updates automatically.':'Automatic checks are off.';
    case 'checking':return 'Checking for updates…';
    case 'up-to-date':return 'You’re on the latest version.';
    case 'available':return INSTALLS_IN_PLACE?`Version ${value.latest?.version} is available. Preparing the download…`:`Version ${value.latest?.version} is available. Download it to update.`;
    case 'downloading':return `Downloading ${value.latest?.version}${value.progress!==undefined?` · ${Math.round(value.progress*100)}%`:''}…`;
    case 'ready':return `Version ${value.latest?.version} is ready. Choose Update and relaunch to install it.`;
    case 'installing':return 'Restarting to install the update…';
    case 'error':return value.message??'The update check failed.';
  }
}
