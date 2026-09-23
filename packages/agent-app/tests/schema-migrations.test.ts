import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {listSchemaBackups,restoreSchemaBackup,runSchemaMigrations,schemaVersion,type SchemaMigration} from '../src/runtime/schema-migrations.ts';
import {AgentStore} from '../src/runtime/store.ts';

const v1:SchemaMigration={version:1,name:'baseline',up:()=>{}};
const v2:SchemaMigration={version:2,name:'add notes',up:db=>db.exec('ALTER TABLE items ADD COLUMN notes TEXT')};

test('PER-08: an upgrade backs up first, applies each step transactionally and records user_version',()=>{
  const dir=mkdtempSync(join(tmpdir(),'muster-schema-'));
  try{
    const file=join(dir,'app.sqlite'),db=new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE items (id TEXT); INSERT INTO items VALUES ('kept')");
    const result=runSchemaMigrations(db,file,[v1,v2],{now:()=>new Date('2026-09-23T00:00:00Z')});
    assert.deepEqual(result.applied,['1:baseline','2:add notes']);assert.equal(result.from,0);assert.equal(result.to,2);
    assert.ok(result.backup&&existsSync(result.backup));
    const backup=new DatabaseSync(result.backup!);
    assert.equal(schemaVersion(backup),0);assert.deepEqual(backup.prepare('SELECT id FROM items').all().map((r:any)=>r.id),['kept']);backup.close();
    // Idempotent: reopening at the latest version does nothing and takes no backup.
    assert.deepEqual(runSchemaMigrations(db,file,[v1,v2]),{from:2,to:2,applied:[],newer:false});
    // A newer database (downgraded app) is left untouched.
    assert.equal(runSchemaMigrations(db,file,[v1]).newer,true);assert.equal(schemaVersion(db),2);
    db.close();
    // Rollback: the backup replaces the database; the upgraded copy is kept aside.
    const aside=restoreSchemaBackup(file,result.backup!);
    const restored=new DatabaseSync(file);
    assert.equal(schemaVersion(restored),0);assert.ok(!(restored.prepare("SELECT name FROM pragma_table_info('items')").all() as any[]).some(c=>c.name==='notes'));restored.close();
    assert.ok(existsSync(aside));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('PER-08: a failing step rolls back to the last good version and names the backup; backups are bounded',()=>{
  const dir=mkdtempSync(join(tmpdir(),'muster-schema-'));
  try{
    const file=join(dir,'app.sqlite'),db=new DatabaseSync(file);
    db.exec('CREATE TABLE items (id TEXT)');
    const broken:SchemaMigration={version:3,name:'broken',up:d=>{d.exec('CREATE TABLE half (x)');throw new Error('boom');}};
    assert.throws(()=>runSchemaMigrations(db,file,[v1,v2,broken]),/step 3 \(broken\) failed and was rolled back to schema 2: boom\. A copy from before the upgrade is at .*app\.sqlite\.v0\./);
    assert.equal(schemaVersion(db),2);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='half'").get() as any).n,0,'the failed step left nothing behind');
    for(let i=0;i<5;i++){db.exec('PRAGMA user_version = 0');runSchemaMigrations(db,file,[v1],{now:()=>new Date(Date.UTC(2026,8,23,0,0,i))});}
    assert.equal(listSchemaBackups(join(dir,'backups'),'app.sqlite').length,3);
    db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('PER-08: AgentStore versions its schema; a fresh store needs no backup, an upgraded one gets one',()=>{
  const dir=mkdtempSync(join(tmpdir(),'muster-store-schema-'));
  try{
    const fresh=new AgentStore(dir);
    assert.equal(fresh.schemaMigration.fresh,true);assert.equal(fresh.schemaMigration.backup,undefined);
    assert.equal(schemaVersion(fresh.database()),1);
    fresh.database().exec('PRAGMA user_version = 0');fresh.close();
    const upgraded=new AgentStore(dir);
    assert.ok(upgraded.schemaMigration.backup&&existsSync(upgraded.schemaMigration.backup));
    assert.deepEqual(upgraded.schemaMigration.applied,['1:adopt versioned schema']);
    upgraded.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
