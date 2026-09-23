import type { FollowUpMode, PendingQuestion, PendingQuestionData, ReasoningEffort, TimelineItem } from '../../shared/protocol';
import type { ChatGoal, GoalStatus } from '../../shared/domains/goals-protocol';
import { plural } from '../../shared/wording.ts';
/** Codex strip labels (mirrors GOAL_LABELS; kept local so node tests load this module without the renderer bundler). */
const GOAL_LABELS:Record<GoalStatus,string>={active:'Pursuing goal',paused:'Paused goal',blocked:'Goal stalled',budget_limited:'Goal limited',usage_limited:'Goal usage limited',complete:'Goal achieved'};

/** Built-in slash commands. Only commands the app can actually run are listed (no inert rows). */
export type ComposerCommandId='plan'|'goal'|'project'|'sketch'|'terminal'|'model'|'reasoning'|'access'|'new'|'browser'|'stop'|'compact'|'fork'|'rename'|'status'|'mcp'|'init'|'review';
export interface ComposerCommand {id:ComposerCommandId;command:string;label:string;description:string;keywords:string;hue:number|'full'|'danger'}
export const COMPOSER_COMMANDS:readonly ComposerCommand[]=[
  {id:'plan',command:'plan',label:'Plan mode',description:'Turn plan mode on/off',keywords:'mode planning read-only',hue:236},
  {id:'goal',command:'goal',label:'Goal',description:'Set a goal to keep pursuing',keywords:'objective loop long running pursue target',hue:38},
  {id:'project',command:'project',label:'Work in a project',description:'Choose project for new chats',keywords:'projects none workspace folders',hue:280},
  {id:'sketch',command:'sketch',label:'Sketch',description:'Draw a sketch',keywords:'draw drawing canvas image',hue:322},
  {id:'terminal',command:'terminal',label:'Attach terminal',description:'Add recent terminal output',keywords:'shell console output logs',hue:152},
  {id:'model',command:'model',label:'Model',description:'Switch model',keywords:'provider',hue:212},
  {id:'reasoning',command:'reasoning',label:'Reasoning',description:'Change reasoning effort',keywords:'effort thinking',hue:280},
  {id:'access',command:'access',label:'Access',description:'Change permissions',keywords:'permissions readonly approval full',hue:'full'},
  {id:'new',command:'new',label:'New chat',description:'Start a blank chat in the same workspace',keywords:'blank thread',hue:212},
  {id:'browser',command:'browser',label:'Browser',description:'Open a browser tab',keywords:'web website',hue:152},
  {id:'stop',command:'stop',label:'Stop',description:'Stop the current run',keywords:'cancel interrupt',hue:'danger'},
  // CS-B4-4: Codex slash commands that map onto actions Muster already has.
  {id:'compact',command:'compact',label:'Compact',description:'Summarize older history to free context',keywords:'context summarize shrink window tokens',hue:236},
  {id:'fork',command:'fork',label:'Fork',description:'Branch this conversation into a new chat',keywords:'branch copy duplicate',hue:152},
  {id:'rename',command:'rename',label:'Rename',description:'Rename this chat',keywords:'title name',hue:212},
  // S3-A (CS-B4-4): the rest of Codex's built-ins, each backed by a real action (no inert rows).
  {id:'status',command:'status',label:'Status',description:'Show chat ID, context usage, and rate limits',keywords:'usage limits tokens info session id',hue:190},
  {id:'mcp',command:'mcp',label:'MCP',description:'Show MCP server status',keywords:'servers tools connectors health',hue:190},
  {id:'init',command:'init',label:'Init',description:'Create an AGENTS.md file with instructions',keywords:'agents.md setup onboarding repository guide',hue:38},
  {id:'review',command:'review',label:'Review',description:'Review current changes',keywords:'code review diff uncommitted findings bugs',hue:280},
];
/** Codex's `/init` prompt: the agent writes AGENTS.md for this repository. */
export const INIT_PROMPT=`Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements
- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections
- Project Structure & Module Organization: where source code, tests, and assets are located.
- Build, Test, and Development Commands: key commands for building, testing, and running locally, with a one-line explanation each.
- Coding Style & Naming Conventions: indentation, language-specific style preferences, naming patterns, and any formatting or linting tools used.
- Testing Guidelines: frameworks, coverage requirements, test naming conventions, and how to run tests.
- Commit & Pull Request Guidelines: commit message conventions found in the project's Git history, and pull request requirements.
- (Optional) Security & configuration tips, architecture overview, or agent-specific instructions.`;
/** Codex's `/review` of the working tree: prioritized, actionable findings on the uncommitted changes. */
export function reviewPrompt(files:readonly string[]):string{
  const listed=files.slice(0,40).map(path=>`- ${path}`).join('\n'),more=files.length>40?`\n- …and ${files.length-40} more`:'';
  return `Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.

Changed files:
${listed}${more}

For each finding give the file and line, why it is a problem (a bug, security risk, performance issue, or a regression the author would want fixed), and a concrete fix. Order findings by priority (P0 highest). Do not modify any files; report findings only. If you find nothing worth fixing, say so plainly.`;
}
/** T3-style rank: exact 0, prefix 2, word boundary 4, substring 6, subsequence 100; null = no match. */
export function scoreQueryMatch(value:string,query:string):number|null{
  const v=value.toLowerCase(),q=query.trim().toLowerCase();
  if(!q)return 0;
  if(v===q)return 0;
  // Shorter names win within the prefix band so `/pl` ranks `plan` above `playwright`.
  if(v.startsWith(q))return 2+Math.min(.9,(v.length-q.length)/40);
  if(new RegExp(`(^|[\\s/_.:-])${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`).test(v))return 4;
  if(v.includes(q))return 6;
  let index=0;for(const char of v)if(char===q[index])index++;
  return index===q.length?100:null;
}
/** Best score over a name and (weaker, +20) a description. */
export function scoreItem(name:string,description:string|undefined,query:string):number|null{
  const primary=scoreQueryMatch(name,query);
  const secondary=description?scoreQueryMatch(description,query):null;
  return primary!==null?primary:secondary!==null&&secondary<100?secondary+20:null;
}
export function filterComposerCommands(query:string):ComposerCommand[]{
  return COMPOSER_COMMANDS.flatMap(item=>{const score=scoreItem(item.command,`${item.description} ${item.keywords}`,query.replace(/^\//,''));return score===null?[]:[{item,score}];})
    .sort((a,b)=>a.score-b.score).map(entry=>entry.item);
}
/** While browsing (no search text), cap a long list to `limit` items instead of dumping all of it —
 * the remainder is reachable through a caller-supplied "browse all" row. Typing to search lifts the
 * cap, since the whole point of a search is to find something that isn't in the short preview. */
export function previewLimit<T>(items: readonly T[], limit: number, browsing: boolean): {shown: readonly T[]; more: number} {
  if (!browsing || items.length <= limit) return {shown: items, more: 0};
  return {shown: items.slice(0, limit), more: items.length - limit};
}
/** Sections keep their order, rows rank within each; a later section holding the best row moves first. */
export function rankSections<T extends {score:number}>(sections:{title:string;rows:T[]}[]):{title:string;rows:T[]}[]{
  const ranked=sections.map(section=>({...section,rows:[...section.rows].sort((a,b)=>a.score-b.score)})).filter(section=>section.rows.length);
  const best=ranked.reduce((index,section,current)=>index<0||section.rows[0].score<ranked[index].rows[0].score?current:index,-1);
  return best>0?[ranked[best],...ranked.slice(0,best),...ranked.slice(best+1)]:ranked;
}
/** `/query` at the caret when the slash starts a line or follows whitespace; `src/a` and URLs stay text. */
export function readSlashQuery(text:string,start:number,end=start):{query:string;start:number}|null {
  if(start!==end || start<1)return null;
  const match=/(^|\s)\/([\w.-]{0,64})$/.exec(text.slice(0,start));
  if(!match || /^\S/.test(text.slice(start)))return null;
  return {query:match[2],start:start-match[2].length-1};
}
export function menuIndex(index:number,length:number,direction:'next'|'previous'|'first'|'last'):number {
  if(length<1)return 0;
  if(direction==='first')return 0;
  if(direction==='last')return length-1;
  if(index<0)return direction==='next'?0:length-1;
  return (index+(direction==='next'?1:-1)+length)%length;
}
export type ComposerAccess='read-only'|'workspace'|'full';
export function configuredAccess(chat:{mode:'agent'|'ask'|'plan';permissionMode?:ComposerAccess}):ComposerAccess {
  return chat.permissionMode??(chat.mode==='agent'?'workspace':'read-only');
}
export function effectiveAccess(chat:{mode:'agent'|'ask'|'plan';permissionMode?:ComposerAccess}):ComposerAccess {
  return chat.mode==='agent'?configuredAccess(chat):'read-only';
}
/* Per-folder access memory ------------------------------------------------ */
const FOLDER_ACCESS_KEY='muster.folderAccess';
function readFolderAccessMap():Record<string,ComposerAccess>{
  try{const value=JSON.parse(localStorage.getItem(FOLDER_ACCESS_KEY)??'{}');return value&&typeof value==='object'?value:{};}catch{return {};}
}
/** The access level last chosen for a chat in this folder (draft or real) — so a second chat there does not revert to "Ask for approval". */
export function readFolderAccess(folderId:string|undefined):ComposerAccess|undefined{
  if(!folderId)return undefined;
  const value=readFolderAccessMap()[folderId];
  return value==='read-only'||value==='workspace'||value==='full'?value:undefined;
}
export function saveFolderAccess(folderId:string|undefined,access:ComposerAccess):void{
  if(!folderId)return;
  try{const map=readFolderAccessMap();if(map[folderId]===access)return;localStorage.setItem(FOLDER_ACCESS_KEY,JSON.stringify({...map,[folderId]:access}));}catch{}
}
export const EFFORT_LABELS:Record<ReasoningEffort,string>={low:'Light',medium:'Medium',high:'High',xhigh:'Extra High'};
export function nextEffort(efforts:readonly ReasoningEffort[],current:ReasoningEffort):ReasoningEffort{
  return efforts.length?efforts[(efforts.indexOf(current)+1)%efforts.length]:current;
}

/* Inline chips ------------------------------------------------------------ */
export type ChipKind='file'|'folder'|'plugin'|'skill'|'chat'|'command'|'mcp'|'app';
/** A picked item. The textarea keeps `token` verbatim; the chip is drawn over it and `id` travels structurally. */
export interface ComposerChip {token:string;kind:ChipKind;id:string;label:string}
export interface ChipRange {start:number;end:number;chip:ComposerChip}
const quote=(value:string)=>/[\s"]/.test(value)?JSON.stringify(value):value;
export function chipToken(kind:ChipKind,value:string):string{
  return kind==='skill'?`$${value}`:kind==='plugin'?`@${value}`:kind==='chat'?`@chat:${quote(value)}`:kind==='mcp'?`@mcp:${quote(value)}`:kind==='app'?`@app:${quote(value)}`:`@${quote(value)}`;
}
/** Every whole-token occurrence of a known chip; tokens touching other word characters stay plain text. */
export function findChipRanges(text:string,chips:readonly ComposerChip[]):ChipRange[]{
  const ranges:ChipRange[]=[];
  for(const chip of chips){
    if(!chip.token)continue;
    for(let at=text.indexOf(chip.token);at>=0;at=text.indexOf(chip.token,at+1)){
      const end=at+chip.token.length;
      if((at===0||/[\s([{"']/.test(text[at-1]))&&(end===text.length||/[\s)\]},.;:!?]/.test(text[end])))ranges.push({start:at,end,chip});
    }
  }
  return ranges.sort((a,b)=>a.start-b.start).filter((range,index,all)=>index===0||range.start>=all[index-1].end);
}
/** Names the composer recognises in typed text without a pick: `/command`, `$skill`, `@plugin`. */
export interface TokenVocabulary {commands?:readonly {command:string;label:string}[];skills?:readonly {name:string;id:string;label:string}[];plugins?:readonly {name:string;id:string;label:string}[]}
/** Chips for typed tokens that name a known command, skill or plugin (so `$pdf` typed by hand still attaches it). */
export function implicitChips(text:string,vocab:TokenVocabulary):ComposerChip[]{
  const found=new Map<string,ComposerChip>();
  for(const match of text.matchAll(/(?:^|[\s([{"'])([/$@])([\w.:-]{1,64})/g)){
    const [,sigil,name]=match,token=`${sigil}${name}`;
    if(found.has(token))continue;
    const hit=sigil==='/'?vocab.commands?.find(entry=>entry.command===name):sigil==='$'?vocab.skills?.find(entry=>entry.name===name):vocab.plugins?.find(entry=>entry.name===name);
    if(!hit)continue;
    found.set(token,sigil==='/'?{token,kind:'command',id:name,label:hit.label}:{token,kind:sigil==='$'?'skill':'plugin',id:(hit as {id:string}).id,label:hit.label});
  }
  return [...found.values()];
}
/** Picked chips plus recognised typed tokens, in text order (picked chips win a shared token). */
export function findTokenRanges(text:string,chips:readonly ComposerChip[],vocab:TokenVocabulary={}):ChipRange[]{
  const picked=new Set(chips.map(chip=>chip.token));
  return findChipRanges(text,[...chips,...implicitChips(text,vocab).filter(chip=>!picked.has(chip.token))]);
}
/** Skill and plugin ids for chips (and recognised typed tokens) still present in the text. */
export function chipPayload(text:string,chips:readonly ComposerChip[],vocab:TokenVocabulary={}):{skillIds:string[];pluginIds:string[]}{
  const present=findTokenRanges(text,chips,vocab).map(range=>range.chip);
  const ids=(kind:ChipKind)=>[...new Set(present.filter(chip=>chip.kind===kind).map(chip=>chip.id))];
  return {skillIds:ids('skill'),pluginIds:ids('plugin')};
}
/** Replace `[start,end)` with `token`, padding with one space on each side as needed. */
export function insertToken(text:string,token:string,start:number,end=start):{text:string;caret:number;insert:string;start:number;end:number}{
  const before=text.slice(0,start),after=text.slice(end);
  const lead=before&&!/[\s([{"']$/.test(before)?' ':'';
  const insert=`${lead}${token}${/^\s/.test(after)?'':' '}`;
  return {text:`${before}${insert}${after}`,caret:start+lead.length+token.length+1,insert,start,end};
}
export function insertWorkspaceReference(text:string,path:string,start=text.length,end=start):{text:string;caret:number}{
  const before=text.slice(0,start),after=text.slice(end);
  const token=`@${/\s/.test(path)?JSON.stringify(path):path}`;
  const prefix=before && !/\s$/.test(before)?`${before} `:before;
  return {text:`${prefix}${token}${after && !/^\s/.test(after)?` ${after}`:after}`,caret:prefix.length+token.length};
}
/** `@query` at the caret, starting at a word boundary; e-mail addresses and selections stay text. */
export function readMentionQuery(text:string,start:number,end=start):{query:string;start:number}|null {
  if(start!==end || start<1)return null;
  const match=/(^|[\s([{"'])@([^\s@]{0,120})$/.exec(text.slice(0,start));
  return match?{query:match[2],start:start-match[2].length-1}:null;
}
/** Replace `@query` with `@path ` and put the caret after the trailing space. */
export function replaceMention(text:string,path:string,start:number,end:number):{text:string;caret:number;insert:string}{
  const token=`@${/\s/.test(path)?JSON.stringify(path):path}`;
  const after=text.slice(end);
  const insert=/^\s/.test(after)?token:`${token} `;
  return {text:`${text.slice(0,start)}${insert}${after}`,caret:start+insert.length+(/^\s/.test(after)?1:0),insert};
}
export const LARGE_PASTE_BYTES=32*1024;
export const MAX_ATTACHMENTS=10;
export const MAX_ATTACHMENT_BYTES=20*1024*1024;
export function classifyPaste(text:string):'inline'|'large' {
  // Cheap upper bound first: UTF-8 is at most 3 bytes per UTF-16 unit.
  if(text.length*3<=LARGE_PASTE_BYTES)return 'inline';
  return new TextEncoder().encode(text).byteLength>LARGE_PASTE_BYTES?'large':'inline';
}
export function formatBytes(bytes:number):string {
  if(!Number.isFinite(bytes)||bytes<0)return '';
  if(bytes<1024)return `${bytes} B`;
  const units=['KB','MB','GB'];let value=bytes/1024,unit=0;
  while(value>=1024&&unit<units.length-1){value/=1024;unit++;}
  return `${value<10?value.toFixed(1).replace(/\.0$/,''):Math.round(value)} ${units[unit]}`;
}
export function attachmentKey(file:{name:string;size:number;lastModified?:number}):string { return `${file.name}\u0000${file.size}\u0000${file.lastModified??0}`; }

/* Goals ------------------------------------------------------------------ */
/** Codex-style duration: `42s`, `3m 05s`, `4h 11m 50s`. */
export function formatElapsed(ms:number):string{
  const total=Math.max(0,Math.floor((Number.isFinite(ms)?ms:0)/1000)),h=Math.floor(total/3600),m=Math.floor(total%3600/60),sec=total%60;
  const pad=(value:number)=>String(value).padStart(2,'0');
  return h?`${h}h ${pad(m)}m ${pad(sec)}s`:m?`${m}m ${pad(sec)}s`:`${sec}s`;
}
/** Time spent pursuing: stored spans plus the live one while active. */
export function goalElapsed(goal:Pick<ChatGoal,'accumulatedMs'|'startedAt'|'status'>,now=Date.now()):number{
  const live=goal.status==='active'&&goal.startedAt?Math.max(0,now-Date.parse(goal.startedAt)):0;
  return goal.accumulatedMs+(Number.isFinite(live)?live:0);
}
/** Codex strip label per status (`Pursuing goal`, `Paused goal`, `Goal stalled`, …) and its tone. */
export function goalHeadline(goal:Pick<ChatGoal,'status'>&Partial<Pick<ChatGoal,'reason'|'accumulatedMs'|'startedAt'>>):{label:string;tone:'active'|'paused'|'warn'|'ok'}{
  const tone=goal.status==='active'?'active':goal.status==='paused'?'paused':goal.status==='complete'?'ok':'warn';
  return {label:GOAL_LABELS[goal.status]??'Paused goal',tone};
}
/** Short explanation under the strip for a goal that stopped on its own. */
export function goalStopNote(goal:Pick<ChatGoal,'status'|'reason'>):string{
  if(goal.status==='blocked')return goal.reason==='empty'?'Three goal turns in a row produced no reply.':goal.reason==='failed'?'Three goal turns in a row failed.':goal.reason==='fatal'?'The last goal turn hit an error it cannot retry.':'The agent reported it is blocked.';
  if(goal.status==='usage_limited')return 'The provider’s usage limit was reached.';
  if(goal.status==='budget_limited')return 'The provider’s budget limit was reached.'; // C3.b3: Muster imposes no turn cap of its own
  if(goal.status==='paused'&&goal.reason==='interrupted')return 'Paused when you stopped the run.';
  return '';
}

/* Queue and steer --------------------------------------------------------- */
/** What a follow-up does while a turn runs: the setting, flipped by the invert shortcut for one message. */
export function followUpAction(mode:FollowUpMode,inverted:boolean):'queue'|'steer'{
  return (mode==='steer')!==inverted?'steer':'queue';
}
/** Codex's queued-row summary for images and long pasted text. */
export function queuedSummary(text:string,images:number):string{
  const first=text.split('\n').find(line=>line.trim())?.trim()??'';
  const lines=text.split('\n').filter(line=>line.trim()).length;
  const pasted=text.length>2000?`Pasted text${lines>1?` (+${lines-1} more…)`:''}`:first;
  return [pasted,images?`${plural(images, 'image')}`:''].filter(Boolean).join(' · ')||'Attachments only';
}
/** Moves `id` to sit before `before` (or last); the new id order for `chat.queue.reorder`. */
export function reorderIds(ids:readonly string[],id:string,before:string|null):string[]{
  if(id===before||!ids.includes(id))return [...ids];
  const rest=ids.filter(entry=>entry!==id),at=before===null?rest.length:rest.indexOf(before);
  return at<0?[...ids]:[...rest.slice(0,at),id,...rest.slice(at)];
}

/** CR-15 Undo: the queue order that puts a re-added item back at the index it was deleted from (or last). */
export function restoreQueueOrder(ids:readonly string[],addedId:string,index:number):string[]{
  const rest=ids.filter(id=>id!==addedId),at=Math.max(0,Math.min(index,rest.length));
  return [...rest.slice(0,at),addedId,...rest.slice(at)];
}

/* Terminal ---------------------------------------------------------------- */
/** Terminal output as plain text: ANSI/OSC sequences removed, carriage-return redraws collapsed, last `lines` kept. */
export function terminalText(data:string,lines=200):string{
  const plain=data.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g,'').replace(/\x1b[@-_]/g,'').replace(/\r\n/g,'\n')
    .split('\n').map(line=>{const trimmed=line.replace(/\r+$/,'');return trimmed.slice(trimmed.lastIndexOf('\r')+1);}).join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');
  return plain.split('\n').slice(-lines).join('\n').replace(/\s+$/,'');
}

/* Record a skill ---------------------------------------------------------- */
/** Seeds the new conversation Codex opens for "Record a skill": interview, then write the skill with skill-creator's layout. */
export const SKILL_RECORDER_PROMPT=`Help me record a reusable skill. Interview me about the workflow one question at a time: what it is for, when it should be used, the steps I follow, the inputs, tools and files involved, and what a good result looks like. Watch me do it if I show you.

When you have enough, write the skill:
- ~/.codex/skills/<hyphen-case-name>/SKILL.md with YAML front matter (name, description saying when to use it, metadata.short-description) and the instructions as the body.
- agents/openai.yaml beside it with interface.display_name, interface.short_description (25–64 characters) and interface.default_prompt mentioning $<name>; quote every string value.
If you cannot write there, reply with the complete SKILL.md in one fenced markdown block so I can save it with "Save as skill".`;
/** A SKILL.md the agent printed in a fenced block (front matter + body), if any. */
export function skillFromMarkdown(text:string):{name:string;description:string;body:string}|null{
  for(const block of [...text.matchAll(/```(?:markdown|md)?\n([\s\S]*?)```/g)].map(match=>match[1]).reverse()){
    const match=/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(block.trim());
    if(!match)continue;
    const field=(key:string)=>new RegExp(`^${key}:\\s*(.+)$`,'m').exec(match[1])?.[1]?.trim().replace(/^(["'])(.*)\1$/,'$2')??'';
    const name=field('name'),description=field('description'),body=match[2].trim();
    if(name&&body)return {name,description,body};
  }
  return null;
}
const firstSentence=(text:string)=>(/^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0]??text).replace(/\s+/g,' ').trim();
/** A local first draft of a skill from the chat's last request and the assistant's approach (no provider call). */
export function skillDraft(items:readonly TimelineItem[]):{name:string;description:string;body:string}{
  let at=-1;
  for(let index=items.length-1;index>=0;index--)if(items[index].kind==='user'&&items[index].text.trim()){at=index;break;}
  if(at<0)return {name:'',description:'',body:''};
  // A skill the agent already wrote out (the recorder flow) wins over a draft from the request.
  for(let index=items.length-1;index>at;index--)if(items[index].kind==='assistant'){const written=skillFromMarkdown(items[index].text);if(written)return written;}
  const request=items[at].text.trim();
  const approach=items.slice(at+1).filter(item=>item.kind==='assistant'&&item.text.trim()).map(item=>item.text.trim()).join('\n\n').slice(0,6000).trim();
  const words=request.replace(/[`*_#>@$]/g,'').replace(/\s+/g,' ').trim().split(' ').filter(Boolean).slice(0,5);
  const name=words.join(' ').replace(/[^\p{L}\p{N} -]+/gu,'').trim().slice(0,60);
  const lead=firstSentence(request).slice(0,220);
  const description=lead?`Use when asked to ${lead.charAt(0).toLowerCase()}${lead.slice(1)}`.slice(0,300):'';
  const body=[`# ${name||'New skill'}`,'','## When to use',request.slice(0,2000),...(approach?['','## Approach',approach]:[])].join('\n');
  return {name,description,body};
}

/** CS-B2-4: a pasted clipboard image arrives nameless (or as Chromium's generic "image.png"); Codex names it
 *  "Screenshot HH.MM.SS.png" so several pastes stay tellable apart. Real file names are kept. */
export function attachmentName(file:{name?:string;type?:string},kind:string,now:Date=new Date()):string{
  const generic=!file.name||/^image\.(png|jpe?g|gif|webp|tiff?|heic)$/i.test(file.name);
  if(kind==='image'&&generic){
    const pad=(value:number)=>String(value).padStart(2,'0');
    const ext=/jpe?g/.test(file.type??'')?'jpg':/gif/.test(file.type??'')?'gif':/webp/.test(file.type??'')?'webp':'png';
    return `Screenshot ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.${ext}`;
  }
  return file.name||'Pasted file';
}

/** DF-F32/CMP-12: the selected model's name when its catalog says it cannot read images (`images === false`), so the
 *  composer can warn while the image is still staged — not only after sending, when the runtime withholds it. */
export function imageBlindModel(providers:readonly {id:string;models:readonly {id:string;name:string;images?:boolean}[]}[],providerId:string|undefined,model:string|undefined):string|null{
  if(!model)return null;
  const entry=providers.find(provider=>provider.id===(providerId??'hybrow'))?.models.find(item=>item.id===model);
  return entry?.images===false?entry.name||entry.id:null;
}
export const imageBlindWarning=(model:string)=>`${model} can’t read images. Attached images won’t be sent; pick a model that accepts images to include them.`;

/* S3-A: Full access "Don't ask again for this folder" ---------------------- */
const FULL_ACCESS_SKIP_KEY='muster.fullAccess.skipConfirm';
/** Fired on `window` whenever the skip list changes, so Settings and open composers stay in step. */
export const FULL_ACCESS_SKIP_EVENT='muster:full-access-skip';
/** Folder ids whose Full-access confirmation the user turned off (Settings › Chat lists them with "Ask again"). */
export function fullAccessSkipFolders():string[]{
  try{const value=JSON.parse(localStorage.getItem(FULL_ACCESS_SKIP_KEY)??'[]');return Array.isArray(value)?value.filter((id):id is string=>typeof id==='string'&&id.length>0):[];}catch{return [];}
}
export function skipsFullAccessConfirm(folderId:string|undefined):boolean{
  return Boolean(folderId)&&fullAccessSkipFolders().includes(folderId!);
}
export function setFullAccessSkip(folderId:string|undefined,skip:boolean):void{
  if(!folderId)return;
  const current=fullAccessSkipFolders(),next=skip?[...new Set([...current,folderId])]:current.filter(id=>id!==folderId);
  if(next.length===current.length&&next.every((id,index)=>id===current[index]))return;
  try{localStorage.setItem(FULL_ACCESS_SKIP_KEY,JSON.stringify(next));}catch{/* this session only */}
  try{window.dispatchEvent(new CustomEvent(FULL_ACCESS_SKIP_EVENT));}catch{/* no window in node tests */}
}

/* S3-A: pending-question panel (CS-B11-1/2) -------------------------------- */
/** The oldest question of this chat still waiting for an answer (the provider asks one at a time). */
export function pendingQuestionItem(items:readonly TimelineItem[]|undefined):{item:TimelineItem;data:PendingQuestionData}|null{
  for(const item of items??[]){
    const data=item.data;
    if(item.kind!=='question'||item.status!=='pending'||!data||data.method!=='item/tool/requestUserInput'||!Array.isArray(data.questions)||!data.questions.length)continue;
    return {item,data:data as unknown as PendingQuestionData};
  }
  return null;
}
export const questionOptionValue=(option:{label:string;value?:string}):string=>option.value??option.label;
/** `1`–`9` → option index 0–8; anything else (including `0`) is not a pick. */
export function questionDigit(key:string):number|null{
  return /^[1-9]$/.test(key)?Number(key)-1:null;
}
/** Pick option `index`: single-select replaces the answer, multi-select toggles it. Null when there is no such option. */
export function pickQuestionOption(answers:Readonly<Record<string,string[]>>,question:PendingQuestion,index:number):Record<string,string[]>|null{
  const option=question.options[index];
  if(!option)return null;
  const value=questionOptionValue(option),current=(answers[question.id]??[]).filter(entry=>question.options.some(item=>questionOptionValue(item)===entry));
  const next=question.multiSelect?(current.includes(value)?current.filter(entry=>entry!==value):[...current,value]):[value];
  return {...answers,[question.id]:next};
}
/** What gets sent for one question: typed text (the composer is the custom answer) wins over picked options. */
export function questionAnswer(answers:Readonly<Record<string,string[]>>,question:PendingQuestion,custom:string):string[]{
  const typed=custom.trim();
  if(typed&&(question.allowCustomAnswer||!question.options.length))return [typed];
  return (answers[question.id]??[]).filter(entry=>question.options.some(item=>questionOptionValue(item)===entry));
}

/* S3-A: plugin defaultPrompt hint (CS-B3-6) ----------------------------------- */
/** A plugin chip's first `defaultPrompt` while the draft holds nothing but chips; '' otherwise. */
export function pluginPromptHint(text:string,ranges:readonly ChipRange[],plugins:readonly {id:string;defaultPrompts?:string[]}[]):string{
  if(!ranges.length)return '';
  let rest='',at=0;
  for(const range of ranges){rest+=text.slice(at,range.start);at=range.end;}
  if((rest+text.slice(at)).trim())return '';
  for(const range of ranges){
    if(range.chip.kind!=='plugin')continue;
    const hint=plugins.find(plugin=>plugin.id===range.chip.id)?.defaultPrompts?.find(prompt=>prompt.trim());
    if(hint)return hint.trim();
  }
  return '';
}

/* S3-A: background terminals pill (CS-A1-3) ------------------------------- */
export const terminalsPillLabel=(count:number):string=>plural(count,'Terminal');

