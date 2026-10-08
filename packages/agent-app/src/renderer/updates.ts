import {useSyncExternalStore} from 'react';
import {invoke,subscribe} from './bridge';
import type {UpdateInstallMethod,UpdateStatus} from '../shared/update-protocol';

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

/** How this copy installs updates. Builds before 0.3.6 sent no method: macOS installed in place, the rest downloaded. */
export function installMethod(value:UpdateStatus|undefined):UpdateInstallMethod {
  return value?.method??(typeof navigator!=='undefined'&&/Mac/.test(navigator.platform)?'mac-bundle':'manual');
}
/** False when an update means downloading it yourself from the release page. */
export const installsInPlace=(value:UpdateStatus|undefined):boolean=>installMethod(value)!=='manual';

/** The update button's words: what pressing it does on this machine. */
export function installLabel(value:UpdateStatus):string {
  switch(installMethod(value)){
    case 'manual':return 'Download update';
    case 'deb':return 'Install and relaunch';
    default:return 'Update and relaunch';
  }
}

const megabytes=(bytes:number)=>bytes>=10_000_000?`${Math.round(bytes/1_000_000)} MB`:`${(bytes/1_000_000).toFixed(1)} MB`;

/** What an update does on this machine, start to finish (Settings › Updates). */
export function installExplanation(value:UpdateStatus):string {
  switch(installMethod(value)){
    case 'mac-bundle':return 'Muster downloads updates from GitHub Releases in the background and checks each one against its published checksum and signature. Update and relaunch replaces Muster Agent in Applications and opens the new version.';
    case 'nsis':return 'Muster downloads updates from GitHub Releases in the background, only the changed parts once an earlier update is on this PC, and checks each one against its published checksum. Update and relaunch closes Muster Agent, installs the new version for your Windows user (no administrator prompt) and opens it again.';
    case 'appimage':return 'Muster downloads updates from GitHub Releases in the background, only the parts of the AppImage that changed, and checks each one against its published checksum. Update and relaunch closes Muster Agent, replaces this AppImage file with the new one and opens it.';
    case 'deb':return 'Muster downloads the new .deb from GitHub Releases in the background and checks it against its published checksum. Install and relaunch asks for your administrator password so apt can install it, then opens the new version. If no password prompt is available, Muster shows the command to run in a terminal.';
    case 'manual':return 'This copy (the portable zip, the tar.gz archive or a development build) can’t replace itself. When a new version is out, Download update opens its GitHub release page; install it the way you installed this one.';
  }
}

/** One line for Settings and tooltips. */
export function updateSummary(value:UpdateStatus):string {
  const version=value.latest?.version,method=installMethod(value);
  switch(value.phase){
    case 'disabled':return value.message??'Updates are off for this build.';
    case 'idle':return value.autoCheck?'Checks for updates automatically.':'Automatic checks are off.';
    case 'checking':return 'Checking for updates…';
    case 'up-to-date':return 'You’re on the latest version.';
    case 'available':return method!=='manual'?`Version ${version} is available. Preparing the download…`:`Version ${version} is available. Download it from the release page to update.`;
    case 'downloading':{
      const partial=value.downloadBytes!==undefined&&value.fullBytes!==undefined&&value.downloadBytes<value.fullBytes;
      const size=partial?` (${megabytes(value.downloadBytes!)} of ${megabytes(value.fullBytes!)}, only what changed)`:value.downloadBytes?` (${megabytes(value.downloadBytes)})`:'';
      return `Downloading ${version}${size}${value.progress!==undefined?` · ${Math.round(value.progress*100)}%`:''}…`;
    }
    case 'ready':
      if(value.message)return value.message;
      return method==='deb'?`Version ${version} is ready. Choose Install and relaunch; you’ll be asked for your password.`:`Version ${version} is ready. Choose Update and relaunch to install it.`;
    case 'installing':
      if(value.message)return value.message;
      return method==='nsis'?'Closing Muster Agent to install the update. It opens again when the installer is done…'
        :method==='appimage'?'Restarting into the new AppImage…'
        :method==='deb'?'Installing the update with apt…'
        :'Restarting to install the update…';
    case 'error':return value.message??'The update check failed.';
  }
}
