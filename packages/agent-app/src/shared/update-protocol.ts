/** App self-update status shared by the main process (src/main/app-updater.ts) and the renderer. */
export type UpdateChannelName='stable'|'beta'|'preview';
export type UpdatePhase='disabled'|'idle'|'checking'|'up-to-date'|'available'|'downloading'|'ready'|'installing'|'error';
/** How this copy of Muster Agent installs an update (decided by the main process from where it runs):
 *  mac-bundle  macOS: replaces the .app in place and relaunches.
 *  nsis        Windows (installed with the setup.exe): runs the new installer silently for this user and relaunches.
 *  appimage    Linux AppImage: replaces the AppImage file and relaunches.
 *  deb         Linux .deb: installs the new package with apt after an administrator password prompt (pkexec), else
 *              shows the command to run.
 *  manual      Anything else (Windows zip, Linux tar.gz, a development build): opens the release page. */
export type UpdateInstallMethod='mac-bundle'|'nsis'|'appimage'|'deb'|'manual';
export interface UpdateRelease {version:string;notes:string;pageUrl:string;publishedAt?:string}
export interface UpdateStatus {
  phase:UpdatePhase;current:string;channel:UpdateChannelName;autoCheck:boolean;latest?:UpdateRelease;progress?:number;message?:string;checkedAt?:string;
  /** How the update installs here; absent from builds older than 0.3.6. */
  method?:UpdateInstallMethod;
  /** Bytes this update downloads (less than `fullBytes` when only the changed blocks are fetched). */
  downloadBytes?:number;
  fullBytes?:number;
  /** deb without a usable pkexec (or after it failed): the command that installs the verified package. */
  manualCommand?:string;
}
export interface UpdateCommands {
  'updates.status':{input:undefined;output:UpdateStatus};
  'updates.check':{input:undefined;output:UpdateStatus};
  'updates.setAutoCheck':{input:{enabled:boolean};output:UpdateStatus};
  'updates.install':{input:undefined;output:UpdateStatus};
}
export type UpdateEvent={type:'updateStatus';status:UpdateStatus};
