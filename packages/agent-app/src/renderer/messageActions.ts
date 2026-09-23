import type {EditResendMode,TimelineItem} from '../shared/protocol';
import {invoke} from './bridge';
import {notifyError,notifySuccess,selectChat} from './store';

/** "Fork from here" on a prompt keeps its whole turn: history runs through the item just before the next prompt. */
export function turnEnd(items:readonly TimelineItem[],itemId:string):string {
  const index=items.findIndex(item=>item.id===itemId);
  if(index<0)return itemId;
  let end=index;
  for(let next=index+1;next<items.length&&!(items[next]!.kind==='user'&&items[next]!.data?.steered!==true);next++)end=next;
  return items[end]!.id;
}

/** The item that offers Retry: the latest turn's last answer, or its prompt when that turn produced none. Nothing while it runs. */
export function retryTarget(items:readonly TimelineItem[],live:boolean):string|undefined {
  if(live)return undefined;
  for(let index=items.length-1;index>=0;index--){
    const item=items[index]!;
    if(item.kind==='assistant')return item.id;
    if(item.kind==='user'&&item.data?.steered!==true)return item.id;
  }
  return undefined;
}

export async function forkChat(chatId:string,fromItemId?:string):Promise<void> {
  try {const fork=await invoke('chat.fork',{id:chatId,...(fromItemId?{fromItemId}:{})});await selectChat(fork.id);notifySuccess('Forked into a new chat');}
  catch(error){notifyError(error);}
}

export async function retryTurn(chatId:string,itemId:string):Promise<void> {
  try {await invoke('chat.retry',{id:chatId,itemId});}
  catch(error){notifyError(error);}
}

/** One requestId per edit attempt, so an ambiguous IPC failure retried with the same text never forks twice. */
const editRequests=new Map<string,{key:string;requestId:string}>();
export async function editResend(chatId:string,itemId:string,text:string,mode:EditResendMode,restoreFiles?:Array<{path:string;afterHash:string}>):Promise<boolean> {
  const key=`${mode}\n${text}\n${restoreFiles?.map(file=>`${file.path}:${file.afterHash}`).join('\0')??''}`,previous=editRequests.get(itemId);
  const requestId=previous?.key===key?previous.requestId:crypto.randomUUID();
  editRequests.set(itemId,{key,requestId});
  try {
    const result=await invoke('chat.editResend',{id:chatId,itemId,text,requestId,mode,...(restoreFiles?{restoreFiles}:{})});
    editRequests.delete(itemId);
    if(result.chatId!==chatId)await selectChat(result.chatId);
    return true;
  } catch(error){notifyError(error);return false;}
}
