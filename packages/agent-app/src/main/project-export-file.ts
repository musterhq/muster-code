import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

/** Write an explicitly user-selected Project export without exposing arbitrary paths to the renderer. */
export async function writeProjectExportFile(targetPath: string, contents: string): Promise<void> {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function projectExportFilename(name: string): string {
  const safe = name.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 80);
  return `${safe || 'project'}-export.json`;
}
