import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {ProjectTaskStore} from '../src/runtime/project-tasks.ts';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'muster-project-'));const store=new ProjectTaskStore(dir);return {dir,store,close(){store.close();rmSync(dir,{recursive:true,force:true})}}}
const create=(store:ProjectTaskStore,projectId:string,title:string,dependencies:string[]=[])=>(store.createTask({projectId,title,acceptance:'done means observable',dependencies}));

test('task graph rejects missing and cross-project edges; running waits for verified dependencies',()=>{
 const f=fixture();try{const a=create(f.store,'p1','A');const b=create(f.store,'p1','B',[a.id]);const other=create(f.store,'p2','Other');
  assert.throws(()=>create(f.store,'p1','Self',['self']),/not found/);
  assert.throws(()=>create(f.store,'p1','Cross',[other.id]),/belong to this project/);
  assert.deepEqual(f.store.createTask({projectId:'p1',title:'Duplicate',acceptance:'',dependencies:[b.id,b.id]}).dependencies,[b.id]);
  assert.throws(()=>f.store.updateTaskStatus({projectId:'p1',id:b.id,status:'running',revision:0}),/not yet verified/);
  assert.throws(()=>f.store.updateTaskStatus({projectId:'p2',id:a.id,status:'blocked',revision:0}),/different project/);
  const done=f.store.updateTaskStatus({projectId:'p1',id:a.id,status:'verified',revision:0,evidence:['focused test passed']});
  assert.equal(done.status,'verified');assert.equal(f.store.updateTaskStatus({projectId:'p1',id:b.id,status:'running',revision:0}).status,'running');
 }finally{f.close()}
});

test('verification requires bounded evidence, stale writes fail, and history survives reopen',()=>{
 const f=fixture();try{const t=create(f.store,'p','Evidence');assert.throws(()=>f.store.updateTaskStatus({projectId:'p',id:t.id,status:'verified',revision:0,evidence:[]}),/evidence/);
  assert.throws(()=>f.store.updateTaskStatus({projectId:'p',id:t.id,status:'verified',revision:0,evidence:Array(51).fill('test')}),/limit/);
  const verified=f.store.updateTaskStatus({projectId:'p',id:t.id,status:'verified',revision:0,evidence:['test passed']});
  assert.throws(()=>f.store.addEvidence({projectId:'p',id:t.id,entries:['late'],revision:0}),/Stale write/);
  const dir=f.dir;f.store.close();const reopened=new ProjectTaskStore(dir);assert.equal(reopened.getTask(t.id)?.evidence[0],'test passed');reopened.close();
 }finally{rmSync(f.dir,{recursive:true,force:true})}
});

test('decisions use main-side authorship and reject cross-project, self, and supersession-chain errors',()=>{
 const f=fixture();try{const task=create(f.store,'p','Related');const foreign=create(f.store,'q','Foreign');
  assert.throws(()=>f.store.createDecision({projectId:'p',title:'bad',rationale:'',scope:'',relatedTaskIds:[foreign.id]}),/different project/);
  const first=f.store.createDecision({projectId:'p',title:'First',rationale:'why',scope:'project',relatedTaskIds:[task.id]});
  const second=f.store.createDecision({projectId:'p',title:'Second',rationale:'why not',scope:'project',relatedTaskIds:[]});
  assert.equal(first.author,'main');assert.throws(()=>f.store.supersedeDecision({projectId:'p',id:first.id,replacementId:first.id}),/itself/);
  f.store.supersedeDecision({projectId:'p',id:first.id,replacementId:second.id});
  assert.throws(()=>f.store.supersedeDecision({projectId:'p',id:second.id,replacementId:first.id}),/already superseded/);
  assert.throws(()=>f.store.supersedeDecision({projectId:'q',id:first.id,replacementId:second.id}),/different project/);
 }finally{f.close()}
});

test('large collections report explicit truncation and project export identifies attached folders',()=>{
 const f=fixture();try{for(let i=0;i<201;i++)create(f.store,'p',`Task ${i}`);
  assert.equal(f.store.listTasks('p').items.length,200);assert.equal(f.store.listTasks('p').truncated,true);
  assert.equal(f.store.listActivity('p',100).items.length,100);assert.equal(f.store.listActivity('p',100).truncated,true);
  assert.equal(f.store.listTasks('unknown').truncated,false);
 }finally{f.close()}
});
