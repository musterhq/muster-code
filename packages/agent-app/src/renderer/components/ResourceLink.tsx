import React from 'react';
import {activeChat,openFile,notifyError} from '../store';
import {invoke} from '../bridge';
import {useStore} from '../useStore';
import {resourceReference} from './resourceReference';
export function ResourceLink({href,children}:{href?:string;children?:React.ReactNode}){
 const state=useStore(),chat=activeChat();
 const project=state.snapshot?.projects.find(p=>p.id===chat?.projectId);
 const ids=project?.folderIds??(chat?.folderId?[chat.folderId]:[]);
 const folders=(state.snapshot?.folders??[]).filter(f=>ids.includes(f.id));
 const ref=href?resourceReference(href,folders,chat?.folderId):null;
 if(ref)return <button className="md-resource-link" title={`${ref.absolute}${ref.line?':'+ref.line:''} — Open in adjoining pane`} onClick={()=>void openFile(ref.folderId,ref.path,ref.line)}>{children}</button>;
 if(href&&/^https?:/i.test(href))return <a href={href} title={href} onClick={e=>{e.preventDefault();void invoke('link.open',{url:href}).catch(notifyError);}} rel="noreferrer noopener">{children}</a>;
 return <span className="md-unavailable-link" title="This reference is outside the conversation’s folders or is unsupported.">{children}</span>;
}
