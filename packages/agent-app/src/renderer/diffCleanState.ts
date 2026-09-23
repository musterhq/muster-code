import type {ReviewBaseline} from '../shared/domains/review-protocol';

/**
 * F61: the file has no differences against the selected baseline (typically: its changes were just
 * committed while the Diff tab stayed open). Say so plainly instead of rendering a body of folded
 * "N unchanged lines".
 */
export function cleanDiffMessage(baseline:ReviewBaseline):{title:string;detail:string} {
  if(baseline==='head')return {title:'No changes · committed',detail:'This file matches the last commit (HEAD).'};
  if(baseline==='staged')return {title:'Nothing staged',detail:'No part of this file is in the index.'};
  if(baseline==='unstaged')return {title:'No unstaged changes',detail:'The working copy matches the index.'};
  if('ref' in baseline)return {title:`No changes vs ${baseline.ref}`,detail:`This file matches ${baseline.ref}.`};
  return {title:'No changes in this turn',detail:'This file matches how it was before the turn.'};
}
/** True when the loaded texts are identical and no rename/mode change makes the entry meaningful. */
export function isCleanDiff(before:string|undefined,after:string|undefined,meta?:{mode?:unknown;previousPath?:string;binary?:boolean;truncated?:boolean}):boolean {
  return before!==undefined&&after!==undefined&&before===after&&!meta?.mode&&!meta?.previousPath&&!meta?.binary&&!meta?.truncated;
}
