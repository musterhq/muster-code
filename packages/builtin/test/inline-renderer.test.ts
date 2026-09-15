import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';

/** Execute the shipped renderer against a Monaco contract double, with real DOM nodes. */
function renderer() {
  const source=readFileSync(resolve(process.cwd(),'../../product/muster-inline-diff.js'),'utf8');
  const prefix=source.slice(0,source.indexOf('  // ── ⌘K prompt bar'));
  const clear=source.slice(source.indexOf('  Registry.registerCommand("muster.inlineDiff.clear"'));
  const {window}=parseHTML('<html><body></body></html>');const document=window.document;
  const registered=new Map<string,any>(),calls:any[]=[];
  function editor(uri: string) {
    const host=document.createElement('div');host.innerHTML='<div class="view-lines"></div>';document.body.append(host);
    let decorations:any[]=[];let zoneId=0;let disposed=0;
    const zones=new Map<number,any>(),widgets=new Set<any>();
    const subscription=()=>({dispose:()=>disposed++});
    const model={uri:{toString:()=>uri},getLineCount:()=>500,getLanguageId:()=> 'typescript',getLineMaxColumn:()=> 30};
    return {getModel:()=>model,getDomNode:()=>host,getPosition:()=>({lineNumber:2}),getLayoutInfo:()=>({width:800,height:600,contentLeft:40,verticalScrollbarWidth:10}),getScrollTop:()=>0,getScrollLeft:()=>0,getTopForLineNumber:(line:number)=>line*20,getOffsetForColumn:()=>200,
      createDecorationsCollection:()=>({set:(next:any[])=>{decorations=next;},clear:()=>{decorations=[];}}),
      onDidScrollChange:subscription,onDidLayoutChange:subscription,onDidChangeCursorPosition:subscription,onDidChangeModel:subscription,onDidDispose:subscription,
      changeViewZones:(fn:any)=>fn({addZone:(zone:any)=>{const id=++zoneId;zones.set(id,zone);host.append(zone.domNode);return id;},removeZone:(id:number)=>{zones.get(id)?.domNode.remove();zones.delete(id);}}),
      addOverlayWidget:(w:any)=>{widgets.add(w);host.append(w.getDomNode());},removeOverlayWidget:(w:any)=>{widgets.delete(w);w.getDomNode().remove();},
      host,zones,widgets,decorations:()=>decorations,disposed:()=>disposed};
  }
  const uri='file:///workspace/full-file.ts';const editors=[editor(uri),editor(uri),editor('file:///workspace/untouched.ts')];
  const services:any={editors:{listCodeEditors:()=>editors},commands:{executeCommand:(id:string,args:any)=>calls.push({id,args})},models:{createModel:()=>{throw new Error('Use the renderer’s plaintext fallback');}},languages:{createById:()=>({})}};
  const accessor={get:(id:string)=>services[id]};
  runInNewContext(prefix+clear,{document,navigator:{platform:'Mac'},getComputedStyle:()=>({lineHeight:'20px',fontFamily:'monospace',fontSize:'13px'}),__CommandsRegistry__:{registerCommand:(id:string,fn:any)=>registered.set(id,fn)},__ICodeEditorService__:'editors',__IModelService__:'models',__ILanguageService__:'languages',__ICommandService__:'commands',__IViewDescriptorService__:'views'});
  return {editors,calls,uri,render:(args:any)=>registered.get('muster.inlineDiff.render')(accessor,{uri,...args}),clear:()=>registered.get('muster.inlineDiff.clear')(accessor,{uri})};
}

test('full-file streaming paints additions and every removed line in both editor views',()=>{
  const h=renderer();const removed=Array.from({length:500},(_,i)=>`original line ${i+1}`);
  h.render({hunks:[{start:1,count:500,removed}],streaming:true,widgets:true});
  for(const e of h.editors.slice(0,2)){
    const whole=e.decorations().find(d=>d.options.description==='muster-added');
    assert.equal(whole.range.startLineNumber,1);assert.equal(whole.range.endLineNumber,500);assert.equal(whole.options.isWholeLine,true);
    assert.equal(e.host.querySelectorAll('.muster-ghost-line').length,500);
    assert.match(e.host.textContent!,/original line 500/);
    assert.equal((e.host.querySelector('.muster-hunk') as any).style.display,'none','unfinished hunk stays non-actionable');
  }
  assert.equal(h.editors[2]!.decorations().length,0,'unrelated editor is untouched');
  const zone=h.editors[0]!.zones.keys().next().value;
  h.render({hunks:[{start:1,count:500,removed}],streaming:false,widgets:true});
  assert.equal(h.editors[0]!.zones.keys().next().value,zone,'unchanged removed rows are reused');
});
test('Full Access retains live decorations and removed lines while hiding approval widgets',()=>{
  const h=renderer();const hunks=[{start:2,count:2,removed:['old line']}];
  h.render({hunks,streaming:false,widgets:true});
  assert.equal(h.editors[0]!.host.querySelectorAll('.muster-hunk').length,1);
  h.render({hunks,streaming:false,widgets:false});
  assert.equal(h.editors[0]!.host.querySelectorAll('.muster-hunk').length,0);
  assert.ok(h.editors[0]!.decorations().length);assert.equal(h.editors[0]!.zones.size,1);
  const dismiss=[...h.editors[0]!.host.querySelectorAll('button')].find(b=>b.textContent!.startsWith('Dismiss review')) as any;
  assert.ok(dismiss);dismiss.click();assert.equal(h.calls.at(-1).id,'muster.edit.file');assert.equal(h.calls.at(-1).args.action,'accept');
  h.render({hunks,streaming:false,widgets:true});assert.equal(h.editors[0]!.host.querySelectorAll('.muster-hunk').length,1);
});
test('hunk decisions preserve exact file and index; deletion-only diffs remain visible; cleanup releases resources',()=>{
  const h=renderer();h.render({hunks:[{start:2,count:0,removed:['removed file content']}],streaming:false,widgets:true});
  assert.equal(h.editors[0]!.decorations().length,0);assert.equal(h.editors[0]!.zones.size,1);
  const reject=[...h.editors[0]!.host.querySelectorAll('.muster-hunk button')].find(b=>b.textContent!.startsWith('Reject')) as any;reject.click();
  assert.equal(h.calls.at(-1).args.uri,h.uri);assert.equal(h.calls.at(-1).args.index,0);assert.equal(h.calls.at(-1).args.action,'reject');
  h.clear();for(const e of h.editors.slice(0,2)){assert.equal(e.zones.size,0);assert.equal(e.widgets.size,0);assert.equal(e.decorations().length,0);assert.equal(e.disposed(),5);}
});
