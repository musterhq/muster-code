/** Git domain contract. Add commands here; the allowlist and service dispatch pick them up. */
import type {Folder, GitLocalStatus} from '../protocol.ts';

/** A local branch. `worktreePath` is set when the branch is checked out in some worktree (this one included). */
export interface GitBranch {name:string; upstream?:string; ahead?:number; behind?:number; gone?:boolean; worktreePath?:string; committedAt?:string}
/** `recent` lists recently checked-out local branches (newest first, current excluded). */
export interface GitBranches {current:string|null; detached:boolean; local:GitBranch[]; recent:string[]; truncated:boolean}
/** `fetchedAt` is the last successful fetch (FETCH_HEAD time), null when this checkout never fetched.
 *  `worktree` is set when the folder is a linked worktree; `mainPath` is the primary checkout. */
export interface GitRepoInfo {branch:string|null; detached:boolean; fetchedAt:string|null; hasRemote:boolean; worktree:{mainPath:string}|null}
export interface GitWorktree {path:string; branch:string|null; head:string; main:boolean; current:boolean; dirty:boolean; locked:boolean; prunable:boolean; diskBytes?:number; diskTruncated?:boolean; folderId?:string}
/** A switch with tracked local changes is held back until the caller confirms with `carry`. Carried changes are merged onto the
 *  target branch; `conflicts` lists the files left unmerged by that merge (GIT-06), which the UI routes into the conflict resolver. */
export type GitSwitchResult = {blocked:true; files:string[]; total:number} | {blocked:false; status:GitLocalStatus; conflicts?:string[]};
/** A commit that landed but whose push failed reports `pushError` instead of throwing, so the UI knows the commit exists. */
export interface GitCommitResult {status:GitLocalStatus; pushed:boolean; pushError?:string}

// --- History, compare and blame (GIT-11) -------------------------------------------------------------
/** git's empty tree: the base a root commit is diffed against (git.refDiff accepts it as `base`). */
export const GIT_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** One `git log` row. `refs` are the decorations on this commit (branch names, tags, `HEAD`), `head` marks the checked-out commit. */
export interface GitCommit {sha:string; short:string; author:string; email:string; authoredAt:string; subject:string; parents:string[]; refs:string[]; head:boolean}
export interface GitLogPage {commits:GitCommit[]; hasMore:boolean; skip:number}
/** A file changed between two trees. `status` is git's letter (A/M/D/R/C/T); `adds`/`dels` are null for binary files. */
export interface GitHistoryFile {path:string; previousPath?:string; status:string; adds:number|null; dels:number|null; binary:boolean}
export interface GitCommitDetail {commit:GitCommit; body:string; base:string|null; files:GitHistoryFile[]; truncated:boolean}
/** Base and head resolved to commits; `mergeBase` is null for unrelated histories. */
export interface GitCompareResult {base:{ref:string; sha:string}; head:{ref:string; sha:string}; mergeBase:string|null; ahead:number; behind:number; files:GitHistoryFile[]; truncated:boolean}
export interface GitRefDiff {path:string; before:string; after:string; truncated:boolean; binary:boolean}
export interface GitBlameCommit {sha:string; short:string; author:string; authoredAt:string; summary:string; uncommitted:boolean}
/** `lines[i]` is the sha for line i+1 of the working file. */
export interface GitBlame {path:string; lines:string[]; commits:Record<string,GitBlameCommit>; truncated:boolean}

// --- Merge conflicts (GIT-13) --------------------------------------------------------------------
export type GitOperation = 'merge'|'rebase'|'cherry-pick'|'revert';
export interface GitConflictEntry {path:string; status:string; description:string; resolved:boolean}
/** `operation` is the in-progress command found in .git (MERGE_HEAD, rebase-merge/, CHERRY_PICK_HEAD, REVERT_HEAD); null when none.
 *  `files` are the paths still unmerged in the index. */
export interface GitConflictState {operation:GitOperation|null; currentLabel:string; incomingLabel:string; incomingSubject:string|null; files:GitConflictEntry[]; canContinue:boolean}
/** The three index stages (null when that side has no version: add/add has no base, delete/modify has one missing side) and the working file with markers. */
export interface GitConflictFile {path:string; status:string; base:string|null; ours:string|null; theirs:string|null; working:string; revision:string; truncated:boolean}

// --- Clone (GIT-10) ------------------------------------------------------------------------------
export interface GitCloneStart {id:string; destination:string; name:string}

export interface GitCommands {
  'git.branches': {input:{folderId:string}; output:GitBranches};
  'git.info': {input:{folderId:string}; output:GitRepoInfo};
  'git.headMessage': {input:{folderId:string}; output:{message:string|null}};
  'git.switch': {input:{folderId:string; branch:string; create?:boolean; base?:string; revision:string; carry?:boolean}; output:GitSwitchResult};
  'git.fetch': {input:{folderId:string}; output:{status:GitLocalStatus; info:GitRepoInfo}};
  'git.commit': {input:{folderId:string; revision:string; message:string; amend?:boolean; push?:boolean}; output:GitCommitResult};
  'git.worktree.create': {input:{folderId:string; branch:string; base?:string}; output:{folder:Folder; path:string; branch:string}};
  'git.worktree.list': {input:{folderId:string; usage?:boolean}; output:GitWorktree[]};
  'git.worktree.remove': {input:{folderId:string; path:string}; output:GitWorktree[]};
  /** Paged `git log` (newest first) of `ref` (default HEAD), optionally limited to one path. */
  'git.log': {input:{folderId:string; ref?:string; skip?:number; limit?:number; path?:string}; output:GitLogPage};
  'git.commitDetail': {input:{folderId:string; sha:string}; output:GitCommitDetail};
  'git.compare': {input:{folderId:string; base:string; head:string}; output:GitCompareResult};
  /** A file's contents at two refs (or the empty string on a side where it does not exist); the diff view renders them. */
  'git.refDiff': {input:{folderId:string; base:string; head:string; path:string; previousPath?:string}; output:GitRefDiff};
  'git.blame': {input:{folderId:string; path:string}; output:GitBlame};
  'git.conflicts': {input:{folderId:string}; output:GitConflictState};
  'git.conflictFile': {input:{folderId:string; path:string}; output:GitConflictFile};
  /** Writes the resolved working file (refused when it changed since `revision`); `markResolved` also stages it. */
  'git.conflictWrite': {input:{folderId:string; path:string; content:string; revision:string; markResolved?:boolean}; output:GitConflictState};
  'git.conflictMarkResolved': {input:{folderId:string; paths:string[]}; output:GitConflictState};
  'git.conflictContinue': {input:{folderId:string; action:'continue'|'abort'}; output:{state:GitConflictState; status:GitLocalStatus}};
  /** Starts a clone; progress and completion arrive as `gitClone` events. The folder is added when the clone finishes. */
  'git.clone.start': {input:{url:string; destination?:string}; output:GitCloneStart};
  'git.clone.cancel': {input:{id:string}; output:void};
  'git.clone.defaultDestination': {input:{url:string; parent?:string}; output:{path:string; name:string}};
  /** Main-process directory picker for the clone destination (the chosen directory's own path, not a folder to add). */
  /** Picks the PARENT folder to clone into (the repository name is appended by `git.clone.defaultDestination` with `parent`). */
  'git.clone.pickDestination': {input:{suggested?:string}; output:{path:string}|null};
}
export type GitEvent =
  | {type:'gitClone'; id:string; phase:'progress'; percent:number|null; message:string}
  | {type:'gitClone'; id:string; phase:'done'; path:string; folder:Folder}
  | {type:'gitClone'; id:string; phase:'failed'|'cancelled'; error:string};
export const GIT_COMMANDS = {
  'git.branches': true, 'git.info': true, 'git.headMessage': true, 'git.switch': true, 'git.fetch': true, 'git.commit': true,
  'git.worktree.create': true, 'git.worktree.list': true, 'git.worktree.remove': true,
  'git.log': true, 'git.commitDetail': true, 'git.compare': true, 'git.refDiff': true, 'git.blame': true,
  'git.conflicts': true, 'git.conflictFile': true, 'git.conflictWrite': true, 'git.conflictMarkResolved': true, 'git.conflictContinue': true,
  'git.clone.start': true, 'git.clone.cancel': true, 'git.clone.defaultDestination': true, 'git.clone.pickDestination': true,
} as const satisfies Record<keyof GitCommands, true>;
