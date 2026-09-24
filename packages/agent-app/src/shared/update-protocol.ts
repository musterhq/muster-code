/** App self-update status shared by the main process (src/main/app-updater.ts) and the renderer. */
export type UpdateChannelName='stable'|'beta'|'preview';
export type UpdatePhase='disabled'|'idle'|'checking'|'up-to-date'|'available'|'downloading'|'ready'|'installing'|'error';
export interface UpdateRelease {version:string;notes:string;pageUrl:string;publishedAt?:string}
export interface UpdateStatus {phase:UpdatePhase;current:string;channel:UpdateChannelName;autoCheck:boolean;latest?:UpdateRelease;progress?:number;message?:string;checkedAt?:string}
export interface UpdateCommands {
  'updates.status':{input:undefined;output:UpdateStatus};
  'updates.check':{input:undefined;output:UpdateStatus};
  'updates.setAutoCheck':{input:{enabled:boolean};output:UpdateStatus};
  'updates.install':{input:undefined;output:UpdateStatus};
}
export type UpdateEvent={type:'updateStatus';status:UpdateStatus};
