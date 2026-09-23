import React from 'react';
import {generatedNote} from '../changeCounts';
import './generated-changes.css';

/** Codex counts: "+1,545 -66". */
export const formatCount=(value:number):string=>Math.max(0,Math.round(value)).toLocaleString('en-US');

/** Muted tabular "+a -d"; zero sides are shown only when the other side is also shown (Codex: "+0 -1"). */
export function DiffStat({adds,dels,className=''}:{adds:number;dels:number;className?:string}):React.ReactElement|null {
  if(adds<=0&&dels<=0)return null;
  return <span className={`diff-stat ${className}`.trim()} aria-label={`${adds} ${adds===1?'line':'lines'} added, ${dels} removed`}>
    <span className="diff-stat-add" aria-hidden="true">+{formatCount(adds)}</span>
    <span className="diff-stat-del" aria-hidden="true">-{formatCount(dels)}</span>
  </span>;
}

/** F59: the separately counted lockfile/generated part of a pill ("· 1 lockfile +4,274"), muted. */
export function GeneratedChanges({generated}:{generated:import('../changeCounts').GeneratedTotals}):React.ReactElement|null {
  const note=generatedNote(generated);
  if(!note)return null;
  return <span className="changes-generated" title={note.title} aria-label={`plus ${note.label}, ${note.stats} lines, counted separately`}><span aria-hidden="true">·</span> {note.label} <span className="changes-generated-stats">{note.stats}</span></span>;
}
