import assert from 'node:assert/strict';
import {test} from 'node:test';
import {toolEventDetails} from '../src/runtime/tool-event-details.ts';
import {classifyTool} from '../src/renderer/components/toolPresentation.ts';
import {groupActivity,summarizeActivity} from '../src/renderer/components/activityGrouping.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';
const item=(id:string,data:Record<string,unknown>,status='completed'):TimelineItem=>({id,chatId:'chat',kind:'tool',text:'',createdAt:'',status,data});
test('live action changes label and glyph kind, then summarizes actual settled work',()=>{
  const read=item('read',{type:'commandExecution',command:'cat example.ts',commandActions:[{type:'read',path:'example.ts'}]},'running');
  assert.equal(summarizeActivity([read]),'Reading example.ts');assert.equal(classifyTool(read.data).kind,'read');
  const command=item('cmd',{type:'commandExecution',command:'npm test'},'running');
  read.status='completed';assert.equal(summarizeActivity([read,command]),'Running npm test');assert.equal(classifyTool(command.data).kind,'command');
  command.status='failed';assert.equal(summarizeActivity([read,command]),'Read 1 file, 1 failed');
  assert.equal(summarizeActivity([read,read,{...read,id:'readAgain'}]),'Read 1 file');
});
test('prose and approval boundaries split groups and preserve event order',()=>{
 const tool=item('one',{type:'commandExecution',command:'test'});
 const prose:TimelineItem={...tool,id:'prose',kind:'assistant',text:'Next step'};
 const approval:TimelineItem={...tool,id:'approval',kind:'approval'};
 const rows=groupActivity([tool,{...tool,id:'two'},prose,{...tool,id:'three'},approval]);
 assert.deepEqual(rows.map(row=>[row.id,row.kind]),[['one','activity'],['prose','assistant'],['three','activity'],['approval','approval']]);
 assert.equal(rows[0].kind==='activity'&&rows[0].items.length,2);
});
test('metadata is bounded and typed; mixed or unreported shell actions stay commands',()=>{
 const metadata=toolEventDetails({type:'commandExecution',command:'cat file',cwd:'/fixture',durationMs:-1,exitCode:NaN,commandActions:[null,{type:'read',path:'file'},42]});
 assert.equal(metadata.durationMs,undefined);assert.equal(metadata.exitCode,undefined);assert.equal((metadata.commandActions as unknown[]).length,1);
 assert.equal(classifyTool({type:'commandExecution',command:'cat file'}).kind,'command');
 assert.equal(classifyTool({type:'commandExecution',commandActions:[{type:'read'},{type:'unknown'}]}).kind,'command');
 const changes=toolEventDetails({type:'fileChange',changes:[{path:'a.ts',diff:'+one',unexpected:'omit'}]});
 assert.equal(classifyTool(changes).kind,'edit');assert.deepEqual(changes.changes,[{path:'a.ts',diff:'+one'}]);
 assert.equal(String(toolEventDetails({prompt:'x'.repeat(40000)}).prompt).length,32768);
 const agent=toolEventDetails({agentNickname:'Mira',agentRole:'reviewer',unrelatedSecret:'omit'});
 assert.deepEqual(agent,{agentNickname:'Mira',agentRole:'reviewer'});
 assert.equal(String(toolEventDetails({agentNickname:'x'.repeat(1000)}).agentNickname).length,256);
});
