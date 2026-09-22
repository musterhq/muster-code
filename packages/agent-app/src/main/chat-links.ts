const SCHEME='muster:';

/** Local deep links identify an existing chat without embedding chat content. */
export function chatLink(id:string):string {
  if(!validChatId(id))throw new Error('Invalid chat id.');
  return `muster://chat/${encodeURIComponent(id)}`;
}

export function chatIdFromLink(raw:string):string|null {
  try {
    const url=new URL(raw);
    if(url.protocol!==SCHEME||url.hostname!=='chat'||url.username||url.password||url.search||url.hash)return null;
    const segments=url.pathname.split('/').filter(Boolean);
    if(segments.length!==1)return null;
    const id=decodeURIComponent(segments[0]);
    return validChatId(id)?id:null;
  } catch { return null; }
}

export function chatIdFromArgs(args:readonly string[]):string|null {
  for(const value of args){const id=chatIdFromLink(value);if(id)return id;}
  return null;
}

function validChatId(id:string):boolean {
  return id.length>0&&id.length<=256&&!/[\u0000-\u001f\u007f/\\]/.test(id);
}
