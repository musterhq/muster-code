export type ComposerCommandId='reference'|'browser'|'skills'|'plugins'|'providers'|'model'|'access'|'agent'|'ask'|'plan';
export interface ComposerCommand {id:ComposerCommandId;command:string;label:string;description:string;keywords:string}
export const COMPOSER_COMMANDS:readonly ComposerCommand[]=[
  {id:'reference',command:'file',label:'Reference a workspace file',description:'Add a file path to your message',keywords:'reference mention workspace'},
  {id:'browser',command:'browser',label:'Browse web',description:'Open the Personal browser',keywords:'web website'},
  {id:'skills',command:'skills',label:'Local skills',description:'Inspect installed skill sources',keywords:'instructions inventory skill discovery'},
  {id:'plugins',command:'plugins',label:'Plugin management',description:'Unavailable in this build',keywords:'extensions install marketplace'},
  {id:'providers',command:'providers',label:'Providers & models',description:'Manage available model providers',keywords:'settings connection models'},
  {id:'model',command:'model',label:'Choose a model',description:'Use an available model for this chat',keywords:'provider'},
  {id:'access',command:'access',label:'Set agent access',description:'Choose what future Agent turns may do',keywords:'permissions readonly workspace full'},
  {id:'agent',command:'agent',label:'Agent mode',description:'Work on the task using the selected access',keywords:'mode execute tools'},
  {id:'ask',command:'ask',label:'Ask mode',description:'Answer questions with read-only access',keywords:'mode question'},
  {id:'plan',command:'plan',label:'Plan mode',description:'Develop a plan with read-only access',keywords:'mode planning'},
];
export function filterComposerCommands(query:string):ComposerCommand[]{
  const normalized=query.replace(/^\//,'').trim().toLowerCase();
  return COMPOSER_COMMANDS.filter(item=>`${item.command} ${item.label} ${item.description} ${item.keywords}`.toLowerCase().includes(normalized));
}
/** Recognize only an unfinished leading command; paths/prose/selections stay text. */
export function readSlashQuery(text:string,start:number,end=start):string|null {
  if(start!==end || start!==text.length)return null;
  return /^\/([a-z-]*)$/i.exec(text)?.[1]??null;
}
export function menuIndex(index:number,length:number,direction:'next'|'previous'|'first'|'last'):number {
  if(length<1)return 0;
  if(direction==='first')return 0;
  if(direction==='last')return length-1;
  if(index<0)return direction==='next'?0:length-1;
  return (index+(direction==='next'?1:-1)+length)%length;
}
export type ComposerAccess='read-only'|'workspace'|'full';
export function configuredAccess(chat:{mode:'agent'|'ask'|'plan';permissionMode?:ComposerAccess}):ComposerAccess {
  return chat.permissionMode??(chat.mode==='agent'?'workspace':'read-only');
}
export function effectiveAccess(chat:{mode:'agent'|'ask'|'plan';permissionMode?:ComposerAccess}):ComposerAccess {
  return chat.mode==='agent'?configuredAccess(chat):'read-only';
}
export function insertWorkspaceReference(text:string,path:string,start=text.length,end=start):{text:string;caret:number}{
  const before=text.slice(0,start),after=text.slice(end);
  const token=`@${/\s/.test(path)?JSON.stringify(path):path}`;
  const prefix=before && !/\s$/.test(before)?`${before} `:before;
  return {text:`${prefix}${token}${after && !/^\s/.test(after)?` ${after}`:after}`,caret:prefix.length+token.length};
}
