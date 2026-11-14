/** The offline cache's database for tests: Node's built-in SQLite behind the same small interface the app gives expo-sqlite,
 *  so the cache's real SQL runs. */
import type {SqlDb} from '../src/offline/db';

export function nodeSqlite(): SqlDb {
  const {DatabaseSync} = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return {
    exec: sql => { db.exec(sql); },
    run: (sql, ...params) => { db.prepare(sql).run(...params); },
    all: <T,>(sql: string, ...params: Array<string | number | null>) => db.prepare(sql).all(...params) as T[],
  };
}
