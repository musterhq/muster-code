import React, {useEffect,useState} from 'react';
import {File as FileIcon,Folder as FolderIcon,ChevronDown,ChevronRight} from 'lucide-react';
import {dirKey,loadDir,openFile} from '../store';
import {useStoreSelector} from '../useStore';
import {FileActions} from './FileActions';
export const FileTree = React.memo(function FileTreeView({
  folderId,
  path,
  activePath,
}: {
  folderId: string;
  path: string;
  activePath?: string;
}): React.ReactElement {
  const entries = useStoreSelector(state=>state.files[dirKey(folderId,path)]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [visible,setVisible] = useState(200);
  useEffect(()=>{setVisible(200);setOpen({});},[folderId,path]);
  useEffect(()=>{
    const index=entries?.value?.findIndex(entry=>entry.path===activePath || activePath?.startsWith(entry.path+'/')) ?? -1;
    if(index>=0)setVisible(count=>Math.max(count,Math.ceil((index+1)/200)*200));
  },[entries?.value,activePath]);

  useEffect(() => {
    if (activePath?.startsWith(path ? path+'/' : '')) {
      const child=activePath.slice(path ? path.length+1 : 0).split('/');
      if(child.length>1)setOpen(value=>({...value,[path ? path+'/'+child[0] : child[0]]:true}));
    }
  }, [activePath,path]);
  useEffect(() => {
    if (!entries) void loadDir(folderId, path);
  }, [entries, folderId, path]);

  if (!entries || (entries.phase === 'loading' && !entries.value) || entries.phase === 'idle') {
    return <div className="tree-loading">Loading…</div>;
  }
  if (entries.phase === 'error') {
    return (
      <div className="tree-error">
        <span>{entries.error}</span>
        <button type="button" onClick={() => void loadDir(folderId, path)}>
          Retry
        </button>
      </div>
    );
  }
  const items = entries.value ?? [];
  return (
    <>
    {path === '' && <div className="file-tree-actions"><FileActions folderId={folderId} path="" kind="directory" root/></div>}
    {items.length === 0 && <div className="tree-empty">Empty</div>}
    <ul className="tree" role="group">
      {items.slice(0,visible).map((entry) =>
        entry.kind === 'directory' ? (
          <li key={entry.path}>
            <div className="tree-item-line">
            <button
              type="button"
              className="tree-row" title={entry.path}
              aria-expanded={Boolean(open[entry.path])}
              onClick={() => setOpen((o) => ({ ...o, [entry.path]: !o[entry.path] }))}
            >
              {open[entry.path] ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<FolderIcon size={13}/>
              <span>{entry.name}</span>
            </button>
            <FileActions folderId={folderId} path={entry.path} kind="directory"/>
            </div>
            {open[entry.path] && <FileTree folderId={folderId} path={entry.path} activePath={activePath}/>}
          </li>
        ) : (
          <li key={entry.path}>
            <div className="tree-item-line">
            <button
              type="button"
              className="tree-row" title={entry.path}
              aria-current={entry.path===activePath ? 'page' : undefined}
              onClick={() => void openFile(folderId, entry.path)}
            >
              <FileIcon size={13} />
              <span>{entry.name}</span>
            </button>
            <FileActions folderId={folderId} path={entry.path} kind="file"/>
            </div>
          </li>
        ),
      )}
    </ul>
    {items.length>visible && <button type="button" className="tree-row" onClick={()=>setVisible(count=>count+200)}>Show {Math.min(200,items.length-visible)} more items ({items.length-visible} remaining)</button>}
    </>
  );
});
