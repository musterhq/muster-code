/** The offline cache's database: a tiny synchronous SQL interface. The app gives it expo-sqlite (`openCacheDb`); tests give
 *  it Node's built-in SQLite, so the same SQL runs in both. */
export type SqlValue = string | number | null;
export interface SqlDb {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): void;
  all<T>(sql: string, ...params: SqlValue[]): T[];
}

export function openCacheDb(): SqlDb {
  const {openDatabaseSync} = require('expo-sqlite') as typeof import('expo-sqlite');
  const db = openDatabaseSync('muster-cache.db');
  return {
    exec: sql => db.execSync(sql),
    run: (sql, ...params) => { db.runSync(sql, params); },
    all: <T,>(sql: string, ...params: SqlValue[]) => db.getAllSync<T>(sql, params),
  };
}
