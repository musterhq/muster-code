import assert from 'node:assert/strict';
import test from 'node:test';
import {createMemoryIdentity,normalizeRemote} from '../src/runtime/memory-identity.ts';

const mac=(email:string|undefined,remotes:Record<string,string>={},env:Record<string,string>={})=>createMemoryIdentity({env,user:()=>'someone@host',git:(args,cwd)=>args.includes('user.email')?email:cwd?remotes[cwd]:undefined});

test('remote URLs normalise to host/org/repo, whatever the form, and never keep credentials', () => {
  for (const url of ['git@github.com:Musterhq/Muster-Code.git','https://github.com/musterhq/muster-code','https://alex:ghp_secret@github.com/musterhq/muster-code.git/','ssh://git@github.com/musterhq/muster-code.git'])
    assert.equal(normalizeRemote(url),'github.com/musterhq/muster-code',url);
  assert.equal(normalizeRemote(''),undefined);
  assert.equal(normalizeRemote('not a url'),undefined);
});

test('personal memory is one bank per person, never shared between colleagues', () => {
  const alex=mac('alex@acme.com'),sam=mac('sam@acme.com'),alexLaptop=mac('Alex@Acme.com');
  assert.notDeepEqual(alex.personal(),sam.personal(),'two people never share a personal bank');
  assert.deepEqual(alex.personal(),alexLaptop.personal(),'the same person on another Mac gets the same bank');
  assert.equal(alex.personal().kind,'user');
  assert.ok(!JSON.stringify(alex.personal()).includes('alex'),'only a hash reaches the server');
  assert.deepEqual(mac(undefined,{}, {MUSTER_MEMORY_IDENTITY:'alex@acme.com'}).personal(),alex.personal(),'IT can set the identity explicitly');
  assert.notDeepEqual(mac(undefined).personal(),alex.personal(),'without git email, username@host keeps it per person');
});

test('a repository folder is shared by everyone working on it; a folder without a remote stays private', () => {
  const alex=mac('alex@acme.com',{'/Users/alex/code/app':'git@github.com:acme/app.git','/Users/alex/notes':''});
  const sam=mac('sam@acme.com',{'/home/sam/src/app':'https://github.com/acme/app'});
  const a=alex.folder({id:'f-1',path:'/Users/alex/code/app'}),s=sam.folder({id:'f-99',path:'/home/sam/src/app'});
  assert.deepEqual(a,s,'same repository, different paths and folder ids: one team bank');
  assert.notDeepEqual(alex.folder({id:'f-2',path:'/Users/alex/notes'}),sam.folder({id:'f-2',path:'/Users/alex/notes'}),'no remote: private to each person');
  assert.equal(alex.describe({path:'/Users/alex/code/app'}),'team');
  assert.equal(alex.describe({path:'/Users/alex/notes'}),'private');
  assert.equal(alex.describe(),'personal');
});

test('a Project on the same repository and name is shared; otherwise private', () => {
  const alex=mac('alex@acme.com',{'/a/app':'git@github.com:acme/app.git'}),sam=mac('sam@acme.com',{'/b/app':'https://github.com/acme/app.git'});
  assert.deepEqual(alex.project({id:'p1',name:'Launch 0.4'},{id:'f1',path:'/a/app'}),sam.project({id:'p9',name:'launch  0.4'},{id:'f9',path:'/b/app'}));
  assert.notDeepEqual(alex.project({id:'p1',name:'Launch 0.4'},{id:'f1',path:'/a/app'}),alex.project({id:'p2',name:'Other'},{id:'f1',path:'/a/app'}));
  assert.notDeepEqual(alex.project({id:'p1',name:'Solo'}),sam.project({id:'p1',name:'Solo'}),'no repository: private per person');
});
