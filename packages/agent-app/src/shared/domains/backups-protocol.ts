/**
 * Scheduled database backups (Wave 4, G30): a consistent copy of every Muster database on a schedule, kept for a while, with a restore
 * that is applied the next time the app starts. Backups are files in the data folder, readable only by you (0700 folder, 0600 files).
 * Secret values live in the encrypted secret store and are never part of a backup; the key that decrypts them is not either.
 */
export interface BackupSettings { enabled: boolean; /** Hours between backups (6 to 168). */ intervalHours: number; /** Backups kept (1 to 30). */ keep: number }
export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { enabled: true, intervalHours: 24, keep: 7 };
export interface BackupFile { name: string; bytes: number; sha256: string }
export interface BackupEntry { id: string; createdAt: string; trigger: 'schedule' | 'manual'; appVersion: string | null; files: BackupFile[]; bytes: number; verified: boolean }
export interface BackupStatus {
  settings: BackupSettings; backups: BackupEntry[];
  /** When the next scheduled backup runs; null when switched off. */
  nextAt: string | null; lastAt: string | null; lastError: string | null; running: boolean;
  /** A restore waits for the next start of the app. */
  pendingRestore: { id: string; createdAt: string; requestedAt: string } | null;
  /** What the last restore did, until you dismiss it by making another backup. */
  lastRestore: string | null;
  dir: string;
}
export interface BackupsCommands {
  'backups.status': { input: Record<string, never>; output: BackupStatus };
  'backups.settings.set': { input: Partial<BackupSettings>; output: BackupStatus };
  'backups.run': { input: Record<string, never>; output: BackupEntry };
  /** Checks the backup, then stages it: it replaces the live databases when the app starts next (the current ones are kept first). */
  'backups.restore': { input: { id: string }; output: BackupStatus };
  'backups.restore.cancel': { input: Record<string, never>; output: BackupStatus };
  'backups.remove': { input: { id: string }; output: BackupStatus };
}
export const BACKUPS_COMMANDS = { 'backups.status': true, 'backups.settings.set': true, 'backups.run': true, 'backups.restore': true, 'backups.restore.cancel': true, 'backups.remove': true } as const satisfies Record<keyof BackupsCommands, true>;
export type BackupsEvent = { type: 'backupsChanged' };
