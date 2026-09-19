/**
 * document-preview tests.
 *
 * Covered:
 *  - PDF direct read + base64 round-trip + %PDF- validation
 *  - Traversal and absolute path escapes rejected
 *  - Oversize file rejected before conversion
 *  - Unsupported extension rejected
 *  - Mocked converter error: temp dirs cleaned up (verified via os.tmpdir listing)
 *
 * Not covered here: real Office conversion (parent/fixture test).
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDocument } from '../src/runtime/document-preview.ts';

let root: string;
let outside: string;

// Minimal PDF: just enough to pass %PDF- header check.
function minimalPdf(): Buffer {
  return Buffer.from('%PDF-1.4\n%%EOF\n');
}

before(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'docprev-test-root-'));
  outside = await fs.mkdtemp(join(tmpdir(), 'docprev-test-outside-'));
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test('reads a PDF and returns correct base64, sourceFormat, converted=false', async () => {
  const pdf = minimalPdf();
  await fs.writeFile(join(root, 'sample.pdf'), pdf);
  const result = await readDocument(root, 'sample.pdf');
  assert.equal(result.sourceFormat, 'pdf');
  assert.equal(result.converted, false);
  assert.equal(result.size, pdf.length);
  assert.equal(result.base64, pdf.toString('base64'));
  assert.match(result.revision, /^[0-9a-f]{64}$/);
});

test('revision is deterministic sha256 of source bytes', async () => {
  const pdf = minimalPdf();
  await fs.writeFile(join(root, 'rev.pdf'), pdf);
  const r1 = await readDocument(root, 'rev.pdf');
  const r2 = await readDocument(root, 'rev.pdf');
  assert.equal(r1.revision, r2.revision);
});

test('rejects PDF with invalid header', async () => {
  await fs.writeFile(join(root, 'fake.pdf'), Buffer.from('NOT A PDF'));
  await assert.rejects(
    () => readDocument(root, 'fake.pdf'),
    /not a valid PDF|%PDF-/i,
  );
});

test('rejects traversal escape (..)', async () => {
  await assert.rejects(
    () => readDocument(root, '../escape.pdf'),
    /escapes folder root/i,
  );
});

test('rejects absolute path escape', async () => {
  const abs = join(outside, 'secret.pdf');
  await fs.writeFile(abs, minimalPdf());
  await assert.rejects(
    () => readDocument(root, abs),
    /escapes folder root/i,
  );
});

test('rejects unsupported extension', async () => {
  await assert.rejects(
    () => readDocument(root, 'file.txt'),
    /unsupported document format/i,
  );
});

test('rejects oversize file without reading content', async () => {
  // Write a file that claims to be large via sparse allocation; we truncate
  // to 32 MiB + 1 byte without writing actual data (fast on all FS).
  const bigPath = join(root, 'big.pdf');
  const handle = await fs.open(bigPath, 'w');
  await handle.truncate(32 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(
    () => readDocument(root, 'big.pdf'),
    /exceeds 32 MiB/i,
  );
});

test('rejects symlink pointing outside root', async () => {
  const target = join(outside, 'real.pdf');
  await fs.writeFile(target, minimalPdf());
  const link = join(root, 'link.pdf');
  await fs.symlink(target, link);
  await assert.rejects(
    () => readDocument(root, 'link.pdf'),
    /resolves outside folder root|symlink/i,
  );
});

test('mocked converter error: no temp dirs leaked', async () => {
  // Write a .docx file but break MUSTER_SOFFICE_PATH so conversion fails.
  await fs.writeFile(join(root, 'test.docx'), Buffer.from('PK not real docx'));
  const saved = process.env['MUSTER_SOFFICE_PATH'];
  process.env['MUSTER_SOFFICE_PATH'] = '/nonexistent/soffice';
  const before = await fs.readdir(tmpdir());
  try {
    await assert.rejects(
      () => readDocument(root, 'test.docx'),
      /MUSTER_SOFFICE_PATH.*not executable|not found|ENOENT/i,
    );
  } finally {
    if (saved === undefined) delete process.env['MUSTER_SOFFICE_PATH'];
    else process.env['MUSTER_SOFFICE_PATH'] = saved;
  }
  // No new muster-docprev-* dirs should remain
  const after = await fs.readdir(tmpdir());
  const leaked = after.filter(e => e.startsWith('muster-docprev-') && !before.includes(e));
  assert.equal(leaked.length, 0, `Leaked temp dirs: ${leaked.join(', ')}`);
});
