import test from 'node:test';
import assert from 'node:assert/strict';
import {COMPOSER_COMMANDS,EFFORT_LABELS,formatElapsed,goalElapsed,goalHeadline,skillDraft,LARGE_PASTE_BYTES,attachmentKey,chipPayload,chipToken,classifyPaste,configuredAccess,effectiveAccess,filterComposerCommands,findChipRanges,formatBytes,insertToken,insertWorkspaceReference,menuIndex,nextEffort,previewLimit,rankSections,readMentionQuery,readSlashQuery,replaceMention,scoreQueryMatch,type ComposerChip} from '../src/renderer/components/composerMenus.ts';

test('slash opens at a line start or after whitespace, never inside paths or URLs',()=>{
  assert.deepEqual(readSlashQuery('/',1),{query:'',start:0});assert.deepEqual(readSlashQuery('/plan',5),{query:'plan',start:0});
  assert.deepEqual(readSlashQuery('hello /mo',9),{query:'mo',start:6},'mid-sentence after a space');
  assert.deepEqual(readSlashQuery('line\n/pd',8),{query:'pd',start:5});
  for(const text of ['src/a','/Users/project','https://example.test','a/b'])assert.equal(readSlashQuery(text,text.length),null,text);
  assert.equal(readSlashQuery('/plan',1,5),null,'a selection never opens it');
  assert.equal(readSlashQuery('/plan now',3),null,'caret inside a word does not open it');
});
test('commands are only runnable built-ins; navigation shortcuts and mode pickers are gone',()=>{
  const ids=COMPOSER_COMMANDS.map(command=>command.id);
  for(const gone of ['agent','ask','skills','plugins','providers','reference'])assert.ok(!(ids as string[]).includes(gone),gone);
  assert.equal(new Set(ids).size,ids.length);
  assert.equal(filterComposerCommands('pl')[0].id,'plan');
  assert.ok(filterComposerCommands('web').some(command=>command.id==='browser'),'descriptions and keywords match too');
  assert.equal(filterComposerCommands('zzzz-none').length,0);
});
test('ranking: exact, prefix (shorter first), word boundary, substring, subsequence',()=>{
  assert.equal(scoreQueryMatch('plan','plan'),0);
  assert.ok(scoreQueryMatch('plan','pl')!<scoreQueryMatch('playwright cli skill','pl')!);
  assert.equal(scoreQueryMatch('google drive','dri'),4);assert.equal(scoreQueryMatch('abcdrive','dri'),6);assert.equal(scoreQueryMatch('pdf skill','pfs'),100);assert.equal(scoreQueryMatch('pdf','x'),null);
  const sections=rankSections([{title:'Skills',rows:[{score:2.5}]},{title:'Commands',rows:[{score:2.05},{score:6}]},{title:'Empty',rows:[]}]);
  assert.deepEqual(sections.map(section=>section.title),['Commands','Skills'],'the section with the best row moves first; empty sections drop');
});
test('previewLimit: a short list of installed plugins while browsing, uncapped once searching (+ menu plugin dump)',()=>{
  const items=Array.from({length:40},(_,i)=>i);
  // Browsing (no search text): capped, with a count of what is hidden — the "Browse plugins" row's cue.
  assert.deepEqual(previewLimit(items,6,true),{shown:[0,1,2,3,4,5],more:34});
  // Searching: every match, uncapped — the point of typing is to find something outside the preview.
  assert.deepEqual(previewLimit(items,6,false),{shown:items,more:0});
  // Nothing to hide: no cap needed even while browsing.
  assert.deepEqual(previewLimit([1,2],6,true),{shown:[1,2],more:0});
  assert.deepEqual(previewLimit([],6,true),{shown:[],more:0});
});
test('chips: tokens, whole-token ranges and structured payload',()=>{
  assert.equal(chipToken('plugin','github'),'@github');assert.equal(chipToken('skill','pdf'),'$pdf');
  assert.equal(chipToken('file','My Docs/a.md'),'@"My Docs/a.md"');assert.equal(chipToken('chat','Fix build'),'@chat:"Fix build"');
  const chips:ComposerChip[]=[{token:'@github',kind:'plugin',id:'/cache/github/1',label:'GitHub'},{token:'$pdf',kind:'skill',id:'/skills/pdf',label:'PDF'},{token:'@src/app.ts',kind:'file',id:'src/app.ts',label:'app.ts'}];
  const text='Ask @github and $pdf about @src/app.ts, not @src/app.tsx or x$pdf';
  const ranges=findChipRanges(text,chips);
  assert.deepEqual(ranges.map(range=>text.slice(range.start,range.end)),['@github','$pdf','@src/app.ts']);
  assert.deepEqual(chipPayload(text,chips),{skillIds:['/skills/pdf'],pluginIds:['/cache/github/1']});
  assert.deepEqual(chipPayload('removed',chips),{skillIds:[],pluginIds:[]},'deleting the token text drops the chip');
});
test('inserting a token pads with single spaces and puts the caret after it',()=>{
  assert.deepEqual(insertToken('see @gi',  '@github',4,7),{text:'see @github ',caret:12,insert:'@github ',start:4,end:7});
  assert.equal(insertToken('word','$pdf',4).text,'word $pdf ');
  assert.equal(insertToken('(','@a.ts',1).text,'(@a.ts ');
  const mid=insertToken('a  b','$x',2);assert.equal(mid.text,'a $x b');assert.equal(mid.caret,5);
});
test('effort labels follow Codex and cycling wraps',()=>{
  assert.equal(EFFORT_LABELS.low,'Light');assert.equal(EFFORT_LABELS.xhigh,'Extra High');
  assert.equal(nextEffort(['low','medium','high'],'high'),'low');assert.equal(nextEffort(['low','medium'],'xhigh'),'low');
});
test('keyboard menu indices wrap and handle an unfocused or empty list',()=>{
  assert.equal(menuIndex(-1,3,'next'),0);assert.equal(menuIndex(-1,3,'previous'),2);
  assert.equal(menuIndex(2,3,'next'),0);assert.equal(menuIndex(0,3,'previous'),2);
  assert.equal(menuIndex(2,3,'first'),0);assert.equal(menuIndex(0,3,'last'),2);assert.equal(menuIndex(0,0,'next'),0);
});
test('effective access remains separate from mode and legacy defaults stay honest',()=>{
  assert.equal(configuredAccess({mode:'agent'}),'workspace');assert.equal(configuredAccess({mode:'ask'}),'read-only');
  assert.equal(effectiveAccess({mode:'agent',permissionMode:'full'}),'full');
  assert.equal(effectiveAccess({mode:'ask',permissionMode:'full'}),'read-only');
  assert.equal(effectiveAccess({mode:'plan',permissionMode:'workspace'}),'read-only');
  assert.equal(configuredAccess({mode:'ask',permissionMode:'full'}),'full','configured Agent access is preserved while Ask is read-only');
});
test('file references preserve text/selection and quote paths containing spaces',()=>{
  assert.deepEqual(insertWorkspaceReference('Review carefully','src/file.ts',6,6),{text:'Review @src/file.ts carefully',caret:19});
  const value=insertWorkspaceReference('Use placeholder now','/Project Docs/a.md',4,15);
  assert.equal(value.text,'Use @"/Project Docs/a.md" now');assert.equal(value.caret,'Use @"/Project Docs/a.md"'.length);
  assert.deepEqual(insertWorkspaceReference('','src/a.ts'),{text:'@src/a.ts',caret:9});
});
test('@ opens only at a word boundary at the caret and reports where the token starts',()=>{
  assert.deepEqual(readMentionQuery('@',1),{query:'',start:0});
  assert.deepEqual(readMentionQuery('see @src/ma',11),{query:'src/ma',start:4});
  assert.deepEqual(readMentionQuery('(@note',6),{query:'note',start:1});
  assert.deepEqual(readMentionQuery('line\n@x',7),{query:'x',start:5});
  for(const [text,caret] of [['mail me@example.com',19],['@a b',4],['',0],['a@',2],['@@',2]] as const)assert.equal(readMentionQuery(text,caret),null,text);
  assert.equal(readMentionQuery('see @src',8,6),null,'a selection never opens the popover');
  assert.deepEqual(readMentionQuery('see @src tail',8),{query:'src',start:4},'caret mid-text reads only what precedes it');
});
test('choosing a mention replaces the typed query and leaves one trailing space',()=>{
  assert.deepEqual(replaceMention('see @sr',  'src/a.ts',4,7),{text:'see @src/a.ts ',caret:14,insert:'@src/a.ts '});
  const mid=replaceMention('see @sr now','src/a.ts',4,7);assert.equal(mid.text,'see @src/a.ts now');assert.equal(mid.caret,'see @src/a.ts '.length);
  assert.equal(replaceMention('@','My Docs/x.md',0,1).text,'@"My Docs/x.md" ');
});
test('paste size classification switches to the attachment offer only above 32 KiB of UTF-8',()=>{
  assert.equal(classifyPaste('short'),'inline');
  assert.equal(classifyPaste('a'.repeat(LARGE_PASTE_BYTES)),'inline');
  assert.equal(classifyPaste('a'.repeat(LARGE_PASTE_BYTES+1)),'large');
  assert.equal(classifyPaste('é'.repeat(LARGE_PASTE_BYTES/2+1)),'large','multi-byte text is measured in bytes');
  assert.equal(classifyPaste('é'.repeat(LARGE_PASTE_BYTES/2)),'inline');
});
test('attachment helpers format sizes and dedupe by name, size and modification time',()=>{
  assert.equal(formatBytes(512),'512 B');assert.equal(formatBytes(1536),'1.5 KB');assert.equal(formatBytes(20*1024*1024),'20 MB');assert.equal(formatBytes(2048),'2 KB');
  assert.equal(attachmentKey({name:'a.png',size:3,lastModified:1}),attachmentKey({name:'a.png',size:3,lastModified:1}));
  assert.notEqual(attachmentKey({name:'a.png',size:3,lastModified:1}),attachmentKey({name:'a.png',size:3,lastModified:2}));
});

test('goal time and headlines read like Codex',()=>{
  assert.equal(formatElapsed(42_000),'42s');assert.equal(formatElapsed(185_000),'3m 05s');assert.equal(formatElapsed((4*3600+11*60+50)*1000),'4h 11m 50s');assert.equal(formatElapsed(-5),'0s');
  const now=Date.parse('2026-09-23T10:00:00Z');
  assert.equal(goalElapsed({status:'active',startedAt:'2026-09-23T09:59:00Z',accumulatedMs:30_000},now),90_000,'stored spans plus the live one');
  assert.equal(goalElapsed({status:'paused',startedAt:null,accumulatedMs:30_000},now),30_000);
  assert.deepEqual(goalHeadline({status:'active',startedAt:null,accumulatedMs:0}),{label:'Pursuing goal',tone:'active'});
  assert.deepEqual(goalHeadline({status:'complete',startedAt:null,accumulatedMs:3_723_000}),{label:'Goal achieved',tone:'ok'});
  assert.deepEqual(goalHeadline({status:'paused',startedAt:null,accumulatedMs:0}),{label:'Paused goal',tone:'paused'});
  assert.deepEqual(goalHeadline({status:'blocked',reason:'failed',startedAt:null,accumulatedMs:0}),{label:'Goal stalled',tone:'warn'});
  assert.ok(filterComposerCommands('goal').some(command=>command.id==='goal'));
});
test('record a skill drafts from the last request and the assistant approach, locally',()=>{
  const item=(kind:'user'|'assistant'|'tool',text:string)=>({id:text,chatId:'c',kind,text,createdAt:''});
  assert.deepEqual(skillDraft([]),{name:'',description:'',body:''});
  const draft=skillDraft([item('user','old'),item('assistant','old answer'),item('user','Draft the weekly release notes from merged PRs. Keep it short.'),item('tool','git log'),item('assistant','I listed merged PRs.'),item('assistant','Then grouped them by area.')]);
  assert.equal(draft.name,'Draft the weekly release notes');
  assert.equal(draft.description,'Use when asked to draft the weekly release notes from merged PRs.');
  assert.match(draft.body,/^# Draft the weekly release notes\n\n## When to use\nDraft the weekly release notes from merged PRs\. Keep it short\.\n\n## Approach\nI listed merged PRs\.\n\nThen grouped them by area\.$/);
  assert.ok(!draft.body.includes('old answer'));
});

test('typed /command, $skill and @plugin tokens are recognised only when they name something real',async()=>{
  const {findTokenRanges,implicitChips}=await import('../src/renderer/components/composerMenus.ts');
  const vocab={commands:[{command:'plan',label:'Plan mode'}],skills:[{name:'pdf',id:'/skills/pdf',label:'PDF'},{name:'docx',id:'/skills/docx',label:'Word'}],plugins:[{name:'gmail',id:'/p/gmail',label:'Gmail'}]};
  const text='Use /plan then $pdf and $docx,\nask @gmail; not src/plan, x$pdf, $nope, me@gmail.com or /planner';
  const ranges=findTokenRanges(text,[],vocab);
  assert.deepEqual(ranges.map(range=>[text.slice(range.start,range.end),range.chip.kind]),[['/plan','command'],['$pdf','skill'],['$docx','skill'],['@gmail','plugin']]);
  assert.deepEqual(chipPayload(text,[],vocab),{skillIds:['/skills/pdf','/skills/docx'],pluginIds:['/p/gmail']},'several skills travel together');
  const picked:ComposerChip[]=[{token:'$pdf',kind:'skill',id:'/other/pdf',label:'Picked PDF'}];
  assert.equal(findTokenRanges('$pdf',picked,vocab)[0].chip.id,'/other/pdf','a picked chip wins over the typed name');
  assert.deepEqual(implicitChips('',vocab),[]);
  // Overlay alignment: painting never changes the text, so gaps plus tokens rebuild it exactly across lines.
  let at=0,rebuilt='';for(const range of ranges){rebuilt+=text.slice(at,range.start)+text.slice(range.start,range.end);at=range.end;}
  assert.equal(rebuilt+text.slice(at),text);
});

test('typed context serialises as labelled fenced blocks with provenance',async()=>{
  const {contextBlock,fenceFor,normalizeContextChip,serializeContext,contextSourceLine,MAX_CONTEXT_CHARS}=await import('../src/renderer/composerContext.ts');
  assert.equal(normalizeContextChip({type:'terminal',label:'zsh'}),null,'text excerpts need text');
  assert.equal(normalizeContextChip({type:'nope',label:'x',text:'y'}),null);
  assert.equal(normalizeContextChip(null),null);
  const terminal=normalizeContextChip({id:'t1',type:'terminal',label:'zsh 1',text:'$ npm test\nok\n',source:{kind:'terminal',terminalId:'abc',title:'zsh 1'}})!;
  assert.equal(terminal.id,'t1');
  assert.equal(contextBlock(terminal),'Terminal output: zsh 1\n```console\n$ npm test\nok\n```');
  const quote=normalizeContextChip({type:'quote',label:'“Use a worker”',text:'Use a ```worker```',source:{itemId:'item-9',chatId:'c'}})!;
  assert.match(quote.id,/^quote:/,'an id is minted when missing');
  assert.equal(fenceFor('Use a ```worker```'),'````');
  assert.equal(contextSourceLine(quote),'Assistant message');
  const file={id:'f',type:'selection' as const,label:'app.ts',text:'const a=1;',source:{path:'src/app.ts',line:3,endLine:5,language:'ts'}};
  assert.equal(contextBlock(file),'Selection: app.ts (src/app.ts:3–5)\n```ts\nconst a=1;\n```');
  assert.equal(serializeContext([terminal,file],'Why does this fail?'),`${contextBlock(terminal)}\n\n${contextBlock(file)}\n\nWhy does this fail?`);
  assert.equal(serializeContext([],'plain'),'plain');
  assert.equal(serializeContext([terminal],'  '),contextBlock(terminal),'context alone is a message');
  assert.equal(normalizeContextChip({type:'terminal',label:'big',text:'x'.repeat(MAX_CONTEXT_CHARS+10)})!.text!.length,MAX_CONTEXT_CHARS,'excerpts are capped to the newest output');
  assert.match(contextBlock({...terminal,stale:true}),/source changed/);
  const image=normalizeContextChip({type:'image',label:'Screenshot',attachment:{id:'att',name:'s.png',mime:'image/png',size:3},dataUrl:'data:image/png;base64,AA'})!;
  assert.equal(image.attachment!.id,'att');assert.equal(serializeContext([image],'look'),'look','images travel as attachments, not text');
});

test('chips and context persist per chat through sessionStorage',async()=>{
  const backing=new Map<string,string>();
  (globalThis as any).sessionStorage={getItem:(key:string)=>backing.get(key)??null,setItem:(key:string,value:string)=>void backing.set(key,value),removeItem:(key:string)=>void backing.delete(key)};
  try{
    const {loadComposerMemory,saveComposerMemory,resetComposerMemory}=await import('../src/renderer/composerContext.ts');
    saveComposerMemory('a',{tokens:[{token:'$pdf',kind:'skill',id:'/s/pdf',label:'PDF'}],context:[{id:'q',type:'quote',label:'Quote',text:'hi',source:{itemId:'i'}}]});
    saveComposerMemory('b',{context:[]});
    resetComposerMemory();
    const restored=loadComposerMemory<ComposerChip>('a');
    assert.equal(restored.tokens[0].token,'$pdf');assert.equal(restored.context[0].text,'hi');
    assert.equal(loadComposerMemory('b').context.length,0);assert.ok(!backing.has('muster.composer.context.v1:b'),'empty state leaves nothing behind');
    saveComposerMemory('a',{tokens:[],context:[]});assert.ok(!backing.has('muster.composer.context.v1:a'));
  }finally{delete (globalThis as any).sessionStorage;}
});

test('CS-B2-4: pasted clipboard images are named like Codex screenshots; real names are kept', async () => {
  const {attachmentName}=await import('../src/renderer/components/composerMenus.ts');
  const at=new Date(2026,8,23,9,5,7);
  assert.equal(attachmentName({name:'',type:'image/png'},'image',at),'Screenshot 09.05.07.png');
  assert.equal(attachmentName({name:'image.png',type:'image/png'},'image',at),'Screenshot 09.05.07.png');
  assert.equal(attachmentName({name:'image.jpeg',type:'image/jpeg'},'image',at),'Screenshot 09.05.07.jpg');
  assert.equal(attachmentName({name:'diagram.png',type:'image/png'},'image',at),'diagram.png');
  assert.equal(attachmentName({name:'',type:'text/plain'},'text',at),'Pasted file');
});

test('DF-F32: the composer knows before sending that the chosen model cannot read images', async () => {
  const {imageBlindModel,imageBlindWarning}=await import('../src/renderer/components/composerMenus.ts');
  const providers=[{id:'hybrow',models:[{id:'text-only',name:'Text Only',images:false},{id:'vision',name:'Vision'}]},{id:'claude',models:[{id:'text-only',name:'Other',images:true}]}];
  assert.equal(imageBlindModel(providers,undefined,'text-only'),'Text Only');
  assert.equal(imageBlindModel(providers,'hybrow','vision'),null);
  assert.equal(imageBlindModel(providers,'claude','text-only'),null);
  assert.equal(imageBlindModel(providers,'hybrow',undefined),null);
  assert.match(imageBlindWarning('Text Only'),/can’t read images/);
});

test('CS-B4-4: / offers the Codex compact, fork and rename commands', () => {
  for(const id of ['compact','fork','rename'] as const)assert.equal(filterComposerCommands(id)[0]?.id,id,id);
  assert.equal(filterComposerCommands('summarize')[0]?.id,'compact');
});
