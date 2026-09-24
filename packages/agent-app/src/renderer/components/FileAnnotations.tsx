import React,{useEffect,useState} from 'react';
import {MessageSquarePlus,Trash2} from 'lucide-react';
import {invoke} from '../bridge';
import type {FileAnnotation} from '../../shared/protocol';
export function FileAnnotations({folderId,path,revision,location,quote}:{folderId:string;path:string;revision:string;location:string;quote:string}) {
  const [open,setOpen]=useState(false),[notes,setNotes]=useState<FileAnnotation[]>([]),[draft,setDraft]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let active=true;void invoke('files.annotations.list',{folderId,path}).then(value=>{if(active)setNotes(value);}).catch(e=>{if(active)setError(String(e));});return()=>{active=false;};},[folderId,path,revision]);
  async function save(){if(busy || !draft.trim())return;setBusy(true);setError('');try{const note=await invoke('files.annotations.add',{folderId,path,revision,location,quote:quote.slice(0,2000),note:draft.trim()});setNotes(value=>[...value,note]);setDraft('');}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function remove(id:string){try{await invoke('files.annotations.remove',{folderId,path,id});setNotes(value=>value.filter(note=>note.id!==id));}catch(e){setError(String(e));}}
  return <section className="file-annotations" aria-label="File annotations">
    <button className="annotation-toggle" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><MessageSquarePlus size={14}/>Annotations{notes.length?` (${notes.length})`:''}</button>
    {open && <div className="annotation-content">
      <p className="file-format-note">Notes are saved in Muster, separately from the original file.</p>
      {notes.map(note=><article key={note.id}><header><strong>{note.location}</strong><button className="icon-button" aria-label={`Delete annotation at ${note.location}`} onClick={()=>void remove(note.id)}><Trash2 size={12}/></button></header>{note.revision!==revision && <p className="annotation-stale">File changed since this note. Check its location before relying on it.</p>}{note.quote && <blockquote>{note.quote}</blockquote>}<p>{note.note}</p></article>)}
      <form onSubmit={event=>{event.preventDefault();void save();}}><label>Note at {location}<textarea aria-label="Annotation note" placeholder="Add a note about this page or selected cell…" value={draft} maxLength={4000} onChange={e=>setDraft(e.target.value)}/></label>{quote && <blockquote>{quote.slice(0,2000)}</blockquote>}<button type="submit" disabled={busy || !draft.trim()}>{busy?'Saving…':'Save annotation'}</button></form>
    </div>}
    {error && <p role="alert" className="pane-error">{error}</p>}
  </section>;
}
