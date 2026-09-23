import {copyFileSync,existsSync,mkdirSync,readdirSync,renameSync,rmSync,statSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';

/** PER-08: versioned schema upgrades with a backup before and a rollback path after.
 *
 * `PRAGMA user_version` records the schema the database was last migrated to.
 * Opening an older database first writes a consistent copy (`VACUUM INTO`, safe
 * under WAL) to `<data>/backups/`, then runs each pending step in its own
 * transaction that also bumps user_version, so a failed step rolls back to the
 * last good version and names the backup. A database from a newer app version
 * is left untouched (steps are additive, so the older app keeps working) and
 * reported as `newer`. `restoreSchemaBackup` puts a backup back in place for a
 * rollback after an upgrade (the database must be closed). */
export interface SchemaMigration {version:number; name:string; up(db:DatabaseSync):void}
export interface MigrationResult {from:number; to:number; applied:string[]; backup?:string; newer:boolean; fresh?:boolean}
export const MAX_SCHEMA_BACKUPS=3;

export function schemaVersion(db:DatabaseSync):number {
  return Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version)||0;
}
function isEmpty(db:DatabaseSync):boolean {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as {n:number}).n)===0;
}
const quote=(value:string)=>`'${value.replaceAll("'","''")}'`;

export function runSchemaMigrations(db:DatabaseSync,databasePath:string,migrations:readonly SchemaMigration[],options:{backupDir?:string;now?:()=>Date;keep?:number}={}):MigrationResult {
  const steps=[...migrations].sort((a,b)=>a.version-b.version);
  if(steps.some((step,index)=>!Number.isSafeInteger(step.version)||step.version<1||(index>0&&step.version===steps[index-1]!.version)))throw new Error('Schema migrations need unique positive versions.');
  const latest=steps.at(-1)?.version??0,from=schemaVersion(db);
  if(from>latest)return {from,to:from,applied:[],newer:true};
  const pending=steps.filter(step=>step.version>from);
  if(!pending.length)return {from,to:from,applied:[],newer:false};
  // A brand-new database is created at the current schema by the caller: nothing to migrate or protect.
  if(isEmpty(db)){db.exec(`PRAGMA user_version = ${latest}`);return {from,to:latest,applied:[],newer:false,fresh:true};}
  let backup:string|undefined;
  if(databasePath!==':memory:'){
    const dir=options.backupDir??join(dirname(databasePath),'backups');
    mkdirSync(dir,{recursive:true,mode:0o700});
    const stamp=(options.now?.()??new Date()).toISOString().replace(/[:.]/g,'-');
    backup=join(dir,`${basename(databasePath)}.v${from}.${stamp}.bak`);
    db.exec(`VACUUM INTO ${quote(backup)}`);
    pruneBackups(dir,basename(databasePath),options.keep??MAX_SCHEMA_BACKUPS);
  }
  const applied:string[]=[];
  for(const step of pending){
    db.exec('BEGIN IMMEDIATE');
    try{step.up(db);db.exec(`PRAGMA user_version = ${step.version}`);db.exec('COMMIT');applied.push(`${step.version}:${step.name}`);}
    catch(error){
      try{db.exec('ROLLBACK');}catch{/* already rolled back */}
      const reason=error instanceof Error?error.message:String(error);
      throw new Error(`Database upgrade step ${step.version} (${step.name}) failed and was rolled back to schema ${schemaVersion(db)}: ${reason}.${backup?` A copy from before the upgrade is at ${backup}.`:''}`);
    }
  }
  return {from,to:schemaVersion(db),applied,backup,newer:false};
}

/** Newest first. */
export function listSchemaBackups(dir:string,databaseName:string):string[] {
  if(!existsSync(dir))return [];
  return readdirSync(dir).filter(name=>name.startsWith(`${databaseName}.v`)&&name.endsWith('.bak')).map(name=>join(dir,name))
    .sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs||b.localeCompare(a));
}
function pruneBackups(dir:string,databaseName:string,keep:number):void {
  for(const file of listSchemaBackups(dir,databaseName).slice(Math.max(1,keep)))rmSync(file,{force:true});
}

/** Roll back: replace the (closed) database with a backup. The replaced file is kept beside it as `.rolled-back`. */
export function restoreSchemaBackup(databasePath:string,backupPath:string):string {
  if(!existsSync(backupPath))throw new Error('That database backup no longer exists.');
  const aside=`${databasePath}.rolled-back`;
  // WAL/SHM belong to the replaced database: they move aside with it and are never replayed onto the backup.
  for(const suffix of ['','-wal','-shm']){
    rmSync(`${aside}${suffix}`,{force:true});
    if(existsSync(`${databasePath}${suffix}`))renameSync(`${databasePath}${suffix}`,`${aside}${suffix}`);
  }
  copyFileSync(backupPath,databasePath);
  return aside;
}
