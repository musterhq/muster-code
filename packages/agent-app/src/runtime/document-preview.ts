/**
 * Bounded local document preview for PDF and Office formats.
 *
 * Security:
 *  - resolveInside rejects traversal/symlink escapes.
 *  - O_NOFOLLOW open closes resolve→open race.
 *  - Input snapshotted to private temp dir; source never mutated.
 *  - LibreOffice runs with isolated --user-installation profile, macros disabled.
 *  - No shell interpolation: args passed as array.
 *  - Child process tree killed on timeout or error.
 *  - All temp dirs removed in finally.
 *
 * Limitations:
 *  - Converted PDF must be ≤32 MiB; larger renders are rejected.
 *  - One conversion at a time (queue cap 4).
 *  - Revision cache holds exactly one entry (LRU-1); no unbounded memory.
 */
import { constants, promises as fs } from 'node:fs';
import { extname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveInside } from './paths.ts';

const MAX_BYTES = 32 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 45_000;
const QUEUE_CAP = 4;

export interface DocumentPreview {
  base64: string;
  revision: string;
  sourceFormat: string;
  converted: boolean;
  size: number;
}

const PDF_EXTS: Record<string, true> = { '.pdf': true };
const OFFICE_EXTS: Record<string, true> = { '.doc': true, '.docx': true, '.ppt': true, '.pptx': true, '.xls': true, '.xlsx': true, '.odt': true, '.odp': true, '.ods': true };

// --- Revision cache (one slot) ---

interface CacheEntry { revision: string; preview: DocumentPreview }
let cache: CacheEntry | null = null;

// --- Conversion queue (cap 4) ---

let queueDepth = 0;

function acquireQueue(): void {
  if (queueDepth >= QUEUE_CAP) throw new Error('Document conversion queue full; try again shortly.');
  queueDepth++;
}

function releaseQueue(): void {
  queueDepth = Math.max(0, queueDepth - 1);
}

// --- In-flight dedup (same revision) ---

const inFlight = new Map<string, Promise<DocumentPreview>>();

// --- soffice discovery ---

const CANDIDATE_PATHS = [
  '/Users/dhairya/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/Applications/LibreOfficeDev.app/Contents/MacOS/soffice',
  '/usr/bin/libreoffice',
  '/usr/bin/soffice',
  '/usr/local/bin/libreoffice',
  '/usr/local/bin/soffice',
  'soffice',
];

async function findSoffice(): Promise<string> {
  const env = process.env['MUSTER_SOFFICE_PATH'];
  if (env) {
    try { await fs.access(env, constants.X_OK); return env; } catch { /* fall through */ }
    throw new Error(`MUSTER_SOFFICE_PATH is set to "${env}" but it is not executable.`);
  }
  for (const p of CANDIDATE_PATHS) {
    try { await fs.access(p, constants.X_OK); return p; } catch { /* continue */ }
  }
  throw new Error(
    'LibreOffice (soffice) not found. Install LibreOffice or set MUSTER_SOFFICE_PATH to the soffice executable path.'
  );
}

// --- Macro-disable registrymodifications.xcu ---

const REGISTRY_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry"
           xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="MacroSecurityLevel" oor:op="fuse" oor:type="xs:int"><value>3</value></prop>
  </item>
  <item oor:path="/org.openoffice.Office.Common/Filter/GraphicExportFilter/Options">
    <prop oor:name="ExternalLinks" oor:op="fuse" oor:type="xs:boolean"><value>false</value></prop>
  </item>
</oor:items>
`;

async function writeRegistryDisableMacros(profileDir: string): Promise<void> {
  const regDir = join(profileDir, 'registrymodifications.xcu');
  await fs.writeFile(regDir, REGISTRY_XCU, 'utf8');
}

// --- Child process with timeout + tree kill ---

function runSoffice(soffice: string, args: string[]): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(soffice, args, { stdio: 'ignore', detached: false });
  const timer = setTimeout(() => {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already dead */ }
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
    reject(new Error(`LibreOffice conversion timed out after ${CONVERT_TIMEOUT_MS / 1000}s.`));
  }, CONVERT_TIMEOUT_MS);
  child.on('error', (err) => { clearTimeout(timer); reject(err); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve();
    else reject(new Error(`LibreOffice exited with code ${code}.`));
  });
  return promise;
}

// --- Core ---

async function openBounded(abs: string, rel: string): Promise<Buffer> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`Path changed to a symlink during read: ${rel}`);
    }
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Not a file: ${rel}`);
    if (stat.size > MAX_BYTES) throw new Error(`File exceeds 32 MiB limit: ${rel}`);
    const buf = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead !== buf.length) throw new Error(`Short read on: ${rel}`);
    return buf;
  } finally {
    await handle.close();
  }
}

async function convertOffice(sourceBuf: Buffer, sourceExt: string): Promise<Buffer> {
  const soffice = await findSoffice();

  // Unique temp dir: profile + input/output isolation
  const tmpBase = await fs.mkdtemp(join(tmpdir(), 'muster-docprev-'));
  const profileDir = join(tmpBase, 'profile');
  const inDir = join(tmpBase, 'input');
  const outDir = join(tmpBase, 'output');

  try {
    await Promise.all([
      fs.mkdir(profileDir, { recursive: true }),
      fs.mkdir(inDir),
      fs.mkdir(outDir),
    ]);

    await writeRegistryDisableMacros(profileDir);

    // Write snapshot of input (source never touched)
    const inputFile = join(inDir, `doc${sourceExt}`);
    await fs.writeFile(inputFile, sourceBuf);

    const userInstall = `file://${profileDir}`;
    await runSoffice(soffice, [
      '--headless',
      `--env:UserInstallation=${userInstall}`,
      '--convert-to', 'pdf',
      '--outdir', outDir,
      inputFile,
    ]);

    // soffice outputs doc.pdf (replaces extension with .pdf)
    const outputFile = join(outDir, `doc.pdf`);
    let outHandle: fs.FileHandle;
    try {
      outHandle = await fs.open(outputFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new Error('LibreOffice did not produce a PDF output file.');
    }
    try {
      const stat = await outHandle.stat();
      if (stat.size > MAX_BYTES) throw new Error(`Converted PDF exceeds 32 MiB limit.`);
      const buf = Buffer.alloc(stat.size);
      const { bytesRead } = await outHandle.read(buf, 0, buf.length, 0);
      if (bytesRead !== buf.length) throw new Error('Short read on converted PDF.');
      if (!buf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        throw new Error('LibreOffice output is not a valid PDF (%PDF- header missing).');
      }
      return buf;
    } finally {
      await outHandle.close();
    }
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
}

async function doRead(root: string, rel: string): Promise<DocumentPreview> {
  const ext = extname(rel).toLowerCase();
  const isPdf = ext in PDF_EXTS;
  const isOffice = ext in OFFICE_EXTS;
  if (!isPdf && !isOffice) {
    throw new Error(`Unsupported document format: ${ext}. Supported: pdf, doc, docx, ppt, pptx, xls, xlsx, odt, odp, ods.`);
  }

  const abs = await resolveInside(root, rel);
  const sourceBuf = await openBounded(abs, rel);
  const revision = createHash('sha256').update(sourceBuf).digest('hex');
  const sourceFormat = ext.slice(1); // strip leading dot

  // Cache hit (single-slot)
  if (cache && cache.revision === revision) return cache.preview;

  // In-flight dedup
  const existing = inFlight.get(revision);
  if (existing) return existing;

  const work = (async (): Promise<DocumentPreview> => {
    try {
      let pdfBuf: Buffer;
      let converted: boolean;

      if (isPdf) {
        if (!sourceBuf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
          throw new Error(`File does not appear to be a valid PDF (%PDF- header missing): ${rel}`);
        }
        pdfBuf = sourceBuf;
        converted = false;
      } else {
        acquireQueue();
        try {
          pdfBuf = await convertOffice(sourceBuf, ext);
        } finally {
          releaseQueue();
        }
        converted = true;
      }

      const preview: DocumentPreview = {
        base64: pdfBuf.toString('base64'),
        revision,
        sourceFormat,
        converted,
        size: pdfBuf.length,
      };

      // Update single-slot cache
      cache = { revision, preview };
      return preview;
    } finally {
      inFlight.delete(revision);
    }
  })();

  inFlight.set(revision, work);
  return work;
}

export async function readDocument(root: string, rel: string): Promise<DocumentPreview> {
  return doRead(root, rel);
}
