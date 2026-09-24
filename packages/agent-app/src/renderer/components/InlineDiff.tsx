import React,{useMemo} from 'react';
import {DiffEditorView,patchEditorModel} from './FileDiffEditor';

/**
 * A provider patch shown as the Cursor-style inline diff editor (see
 * DiffEditorView): syntax colour for the file's language, the file's own line
 * numbers, removed and added lines in place, folded unchanged code. Raw file
 * contents (Codex reports an added file's text, not a patch) are normalised
 * first, so counts match the pill and the row. No review actions here: an
 * individual patch is history, not the file's current review state.
 */
export function InlineDiff({text,path,kind,maxHeight=420,folderId}:{text:string;path?:string;kind?:string;maxRows?:number;folderId?:string;maxHeight?:number|null}):React.ReactElement {
  const model=useMemo(()=>patchEditorModel(text,path??'',kind),[text,path,kind]);
  return <DiffEditorView model={model} path={path??''} folderId={folderId} maxHeight={maxHeight} label={path?`Inline diff for ${path}`:'Inline code diff'}/>;
}
