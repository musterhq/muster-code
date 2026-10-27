import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unpackedPath} from './unpacked-path.ts';
import {normalizeFsPath} from '../shared/path-normalize.ts';

/** Each bundle can call the same shipped helper; source tests use the standalone helper build. */
function helperPath(): string {
  const name = process.platform === 'win32' ? 'muster-write.exe' : 'muster-write';
  if (typeof __dirname === 'string') return unpackedPath(join(__dirname, '../runtime', name));
  return join(dirname(fileURLToPath(import.meta.url)), '../../dist/runtime', name);
}

/** No pathname-based fallback: even an empty file created by O_CREAT outside the workspace is a write. */
export async function writeWorkspaceFile(base: string, parts: string[], content: string): Promise<void> {
  const helper = helperPath();
  if (!existsSync(helper)) throw new Error('Safe workspace writes are unavailable in this build. Reinstall Muster to restore them.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(helper, [normalizeFsPath(base), ...parts], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    let output = '', error = '', sent = false;
    child.stdin.on('error', () => {}); // A refused path closes stdin; report the helper's error on close.
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (!sent && output.includes('ready\n')) { sent = true; child.stdin.end(content, 'utf8'); }
    });
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(0, 4096); });
    child.once('error', reject);
    child.once('close', code => code === 0 && sent ? resolve() : reject(new Error(error.trim() || 'The workspace file could not be written safely.')));
  });
}
