import type {Folder} from '../../shared/protocol';
export type ResourceReference={folderId:string;path:string;line?:number;absolute:string};
/** Resolve only inside folders belonging to this conversation. Host rechecks realpaths. */
export function resourceReference(href:string,folders:Folder[],primaryId?:string,documentPath?:string):ResourceReference|null{
 let path:string;try{path=decodeURIComponent(href);}catch{return null;}
 if(/[\u0000-\u001f\u007f]/.test(path)||path.startsWith('//'))return null;
 // Keep familiar Markdown `file.md#section` links useful: opening the local
 // artifact is preferable to rendering an inert unsupported link. Line
 // fragments retain their exact source navigation behavior.
 const namedFragment=path.indexOf('#');
 if(namedFragment>=0&&!/^#L\d+(?::\d+|-L?\d+)?$/i.test(path.slice(namedFragment))) path=path.slice(0,namedFragment);
 const suffix=path.match(/(?::|#L)(\d+)(?::\d+|(?:-L?\d+))?$/i);
 const line=suffix?Number(suffix[1]):undefined;if(suffix)path=path.slice(0,-suffix[0].length);
 if(path.includes('#')||path.includes('?')||/^[a-z][a-z0-9+.-]*:/i.test(path))return null;
 const absolute=path.startsWith('/');
 let folder=absolute?[...folders].sort((a,b)=>b.path.length-a.path.length).find(f=>path.startsWith(f.path.replace(/\/$/,'')+'/')):folders.find(f=>f.id===primaryId)??(folders.length===1?folders[0]:undefined);
 if(!folder)return null;
 if(absolute)path=path.slice(folder.path.replace(/\/$/,'').length+1);
 // Document links are relative to the document directory, never the current chat.
 if(!absolute&&documentPath)path=documentPath.split('/').slice(0,-1).concat(path).join('/');
 const parts:string[]=[];for(const part of path.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)return null;parts.pop();}else parts.push(part);}
 if(!parts.length)return null;
 path=parts.join('/');return {folderId:folder.id,path,absolute:folder.path.replace(/\/$/,'')+'/'+path,...(line&&line<=10000000?{line}:{})};
}

export type ExternalReference={path:string;line?:number};
/** TRN-12: an absolute, ~/ or file:// reference that is not inside the conversation's folders. The host
 *  re-normalizes and checks it; relative references have no anchor outside a folder and stay inert. */
export function externalReference(href:string):ExternalReference|null{
 let path:string;try{path=decodeURIComponent(href);}catch{return null;}
 if(!path||path.length>4096||/[\u0000-\u001f\u007f]/.test(path))return null;
 if(/^file:\/\//i.test(path)){try{const url=new URL(path);if(url.host&&url.host!=='localhost')return null;path=decodeURIComponent(url.pathname);}catch{return null;}}
 else if(/^[a-z][a-z0-9+.-]*:/i.test(path)||path.startsWith('//'))return null;
 const suffix=path.match(/(?::|#L)(\d+)(?::\d+|(?:-L?\d+))?$/i);
 const line=suffix?Number(suffix[1]):undefined;if(suffix)path=path.slice(0,-suffix[0].length);
 if(path.includes('#')||path.includes('?'))path=path.replace(/[#?].*$/,'');
 if(!(path.startsWith('/')||path==='~'||path.startsWith('~/')))return null;
 if(path.split('/').includes('..'))return null;
 return {path,...(line&&line<=10000000?{line}:{})};
}
