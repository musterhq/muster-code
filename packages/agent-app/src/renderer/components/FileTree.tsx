import React, {useEffect,useState} from 'react';
import {File as FileIcon,Folder as FolderIcon,ChevronDown,ChevronRight} from 'lucide-react';
import {dirKey,loadDir,openFile} from '../store';
import {useStore} from '../useStore';
export function FileTree({
  folderId,
  path,
  activePath,
}: {
  folderId: string;
  path: string;
  activePath?: string;
}): React.ReactElement {
  const state = useStore();
  const entries = state.files[dirKey(folderId, path)];
  const [open, setOpen] = useState<Record<string, boolean>>({});

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
  if (items.length === 0) return <div className="tree-empty">Empty</div>;
  return (
    <ul className="tree" role="group">
      {items.map((entry) =>
        entry.kind === 'directory' ? (
          <li key={entry.path}>
            <button
              type="button"
              className="tree-row"
              aria-expanded={Boolean(open[entry.path])}
              onClick={() => setOpen((o) => ({ ...o, [entry.path]: !o[entry.path] }))}
            >
              {open[entry.path] ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<FolderIcon size={13}/>
              <span>{entry.name}</span>
            </button>
            {open[entry.path] && <FileTree folderId={folderId} path={entry.path} activePath={activePath}/>}
          </li>
        ) : (
          <li key={entry.path}>
            <button
              type="button"
              className="tree-row"
              aria-current={entry.path===activePath ? 'page' : undefined}
              onClick={() => void openFile(folderId, entry.path)}
            >
              <FileIcon size={13} />
              <span>{entry.name}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

