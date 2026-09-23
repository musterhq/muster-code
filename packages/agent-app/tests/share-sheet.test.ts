import assert from 'node:assert/strict';
import {test} from 'node:test';
import {escapeHtml,exportChat,fileNameFor,isChatExportFormat} from '../src/runtime/chat-export.ts';
import {chatMenuTemplate,type ChatMenuCommand} from '../src/main/chat-menu.ts';
import type {Chat,TimelineItem} from '../src/shared/protocol.ts';

const at='2026-09-23T00:00:00.000Z';
const chat:Chat={id:'chat-1',title:'Fix <login> & "auth"',pinned:false,archived:false,status:'completed',updatedAt:at,model:'m',mode:'agent'} as Chat;
const item=(kind:TimelineItem['kind'],text:string,data?:Record<string,unknown>,status?:string):TimelineItem=>({id:text,chatId:'chat-1',kind,text,createdAt:at,...(data?{data}:{}),...(status?{status}:{})});
const items=[
  item('user','<script>alert(1)</script> use sk-proj-abcdefghijklmnopqrstuvwx',{attachments:[{name:'a<b>.log'}]}),
  item('reasoning','private thoughts'),
  item('tool','rm -rf <x>',{name:'rm -rf <x>',type:'commandExecution',output:'ok'},'failed'),
  item('assistant','Done `x` <img src=x onerror=alert(1)>'),
];

test('USER-18 HTML export escapes every entry, carries no script, and lists omissions',()=>{
  const out=exportChat({chat,items,exportedAt:at},'html');
  assert.match(out.fileName,/\.html$/);
  assert.ok(out.text.startsWith('<!doctype html>'));
  assert.ok(!/<script/i.test(out.text),'no script tag, not even from user text');
  assert.ok(!out.text.includes('<img'),'markup in messages is escaped');
  assert.ok(out.text.includes('&#60;script&#62;alert(1)&#60;/script&#62;'));
  assert.ok(out.text.includes('<title>Fix &#60;login&#62; &#38; &#34;auth&#34;</title>'));
  assert.ok(out.text.includes("default-src 'none'"),'CSP blocks network and script');
  assert.ok(out.text.includes('a&#60;b&#62;.log'),'attachment names escaped');
  assert.ok(!out.text.includes('private thoughts')&&!out.text.includes('sk-proj-abcdefghijklmnopqrstuvwx'));
  assert.ok(out.text.includes('[redacted]'));
  assert.ok(out.text.includes('<li>1 reasoning block'));
  assert.equal(escapeHtml(`<a href='x'>&"\``),'&#60;a href=&#39;x&#39;&#62;&#38;&#34;&#96;');
});

test('USER-18 redaction toggle: on by default, off keeps strings and says so in every format',()=>{
  for(const format of ['markdown','html','json'] as const){
    const on=exportChat({chat,items,exportedAt:at},format),off=exportChat({chat,items,exportedAt:at},format,{redact:false});
    assert.ok(!on.text.includes('sk-proj-abcdefghijklmnopqrstuvwx'),`${format} redacts by default`);
    assert.ok(off.text.includes('sk-proj-abcdefghijklmnopqrstuvwx'),`${format} keeps secrets when redaction is off`);
    assert.ok(off.omitted.some(line=>/NOT redacted/.test(line)),`${format} warns`);
    assert.ok(!on.omitted.some(line=>/NOT redacted/.test(line)));
  }
  const json=JSON.parse(exportChat({chat,items,exportedAt:at},'json',{redact:false}).text);
  assert.equal(json.redacted,false);assert.equal(JSON.parse(exportChat({chat,items,exportedAt:at},'json').text).redacted,true);
  assert.deepEqual(json.items.map((entry:{kind:string})=>entry.kind),['user','tool','assistant']);
  // Secret answers stay masked even with redaction off: they were entered as secrets.
  const question=item('question','q',{questions:[{id:'q',question:'Password?',isSecret:true}],answers:{q:{answers:['hunter2']}}});
  assert.ok(!exportChat({chat,items:[question],exportedAt:at},'markdown',{redact:false}).text.includes('hunter2'));
});

test('USER-18 formats and file names; the chat menu offers Share…',()=>{
  assert.equal(fileNameFor({title:'A b'},'html'),'a-b.html');assert.equal(fileNameFor({title:'A b'},'json'),'a-b.json');assert.equal(fileNameFor({title:'A b'},'markdown'),'a-b.md');
  assert.ok(isChatExportFormat('html')&&!isChatExportFormat('pdf'));
  const picked:ChatMenuCommand[]=[];
  const template=chatMenuTemplate({chat,folders:[],projects:[],surface:'sidebar'},command=>picked.push(command));
  const share=template.find(entry=>entry.label==='Share…');
  assert.ok(share,'Share… is in the chat menu');
  (share!.click as ()=>void)();
  assert.deepEqual(picked,[{kind:'renderer',action:'share'}]);
});
