/**
 * #789: office file → PDF (LibreOffice headless) → page PNGs (pdf.js in-process), so an agent can look at what it made.
 *
 *  - The office runtime is ensured first, so the first render downloads LibreOffice when there is no copy yet.
 *  - The source is copied into a private temp folder and never changed; LibreOffice gets an isolated profile with macros off.
 *  - One deadline covers the whole render. On timeout the conversion's process tree is killed, the temp folder is removed
 *    and nothing is written to `outDir`: results are only copied there once everything succeeded.
 *  - PDF pages become images with pdf.js in Node (no separate PDF tool is shipped or downloaded).
 */
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OFFICE_EXTS, runSoffice, writeRegistryDisableMacros } from './document-preview.ts';
import type { OfficeRuntimeProgress } from './office-runtime.ts';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PAGES = 50;
/** 2 × 72 dpi: sharp enough to read body text in a page image. */
const DEFAULT_SCALE = 2;

export type RasterizePdf = (pdf: Uint8Array, options: { maxPages: number; scale: number; signal: AbortSignal }) => Promise<{ pageCount: number; pages: Buffer[] }>;
export type RunSoffice = (soffice: string, args: string[], signal: AbortSignal) => Promise<void>;

export interface RenderOfficeOptions {
  runtime: { ensure(onProgress?: (progress: OfficeRuntimeProgress) => void): Promise<string> };
  /** Where the PDF and page-N.png files go. Created only when the render succeeds. */
  outDir: string;
  /** Parent of the private temp folder (defaults to the system temp folder). */
  tmpRoot?: string;
  timeoutMs?: number;
  maxPages?: number;
  scale?: number;
  onProgress?: (progress: OfficeRuntimeProgress) => void;
  run?: RunSoffice;
  rasterize?: RasterizePdf;
}
export interface RenderOfficeResult {
  /** The PDF the pages came from: the converted copy in `outDir`, or the source itself when it was a PDF. */
  pdf: string;
  /** page-1.png … in `outDir`, at most `maxPages`. */
  pages: string[];
  /** Pages in the whole document. */
  pageCount: number;
}

let pdfjsModule: Promise<typeof import('pdfjs-dist')> | null = null;
function pdfjsRoot(): string {
  // Bundled into CommonJS in the app (no import.meta there); tests run the source from the package folder.
  const require = createRequire(typeof __filename === 'string' ? __filename : join(process.cwd(), 'index.js'));
  return dirname(require.resolve('pdfjs-dist/package.json'));
}
function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  // A computed specifier keeps the bundler from inlining pdf.js; it loads from node_modules beside the app.
  const entry = pathToFileURL(join(pdfjsRoot(), 'legacy', 'build', 'pdf.mjs')).href;
  return pdfjsModule ??= (import(entry) as Promise<typeof import('pdfjs-dist')>).catch(error => { pdfjsModule = null; throw error; });
}

/** pdf.js in Node, drawing with its canvas package. */
export const rasterizeWithPdfjs: RasterizePdf = async (pdf, { maxPages, scale, signal }) => {
  const pdfjs = await loadPdfjs();
  const root = pdfjsRoot();
  const task = pdfjs.getDocument({ data: pdf, isEvalSupported: false, verbosity: 0, useSystemFonts: false,
    standardFontDataUrl: join(root, 'standard_fonts') + '/', cMapUrl: join(root, 'cmaps') + '/', cMapPacked: true, wasmUrl: join(root, 'wasm') + '/' } as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await task.promise;
  try {
    const pages: Buffer[] = [];
    for (let number = 1; number <= Math.min(doc.numPages, maxPages); number++) {
      if (signal.aborted) throw new Error('Rendering was stopped.');
      const page = await doc.getPage(number);
      const viewport = page.getViewport({ scale });
      const factory = (doc as unknown as { canvasFactory: { create(w: number, h: number): { canvas: { toBuffer(mime: 'image/png'): Buffer }; context: unknown } } }).canvasFactory;
      const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: context, viewport, canvas } as unknown as Parameters<typeof page.render>[0]).promise;
      pages.push(canvas.toBuffer('image/png'));
      page.cleanup();
    }
    return { pageCount: doc.numPages, pages };
  } finally {
    await task.destroy();
  }
};

const defaultRun: RunSoffice = (soffice, args, signal) => runSoffice(soffice, args, 24 * 60 * 60_000, signal);

export async function renderOfficeFile(file: string, options: RenderOfficeOptions): Promise<RenderOfficeResult> {
  const ext = extname(file).toLowerCase();
  const isPdf = ext === '.pdf';
  if (!isPdf && !(ext in OFFICE_EXTS)) throw new Error(`Cannot render ${ext || 'this file'}: supported are pdf, doc, docx, ppt, pptx, xls, xlsx, odt, odp, ods.`);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
  if (stat.size > MAX_SOURCE_BYTES) throw new Error(`${basename(file)} is larger than 64 MB.`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES), scale = options.scale ?? DEFAULT_SCALE;
  const run = options.run ?? defaultRun, rasterize = options.rasterize ?? rasterizeWithPdfjs;
  const tmp = await fs.mkdtemp(join(options.tmpRoot ?? tmpdir(), 'muster-office-render-'));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(`Rendering ${basename(file)} timed out after ${Math.round(timeoutMs / 1000)}s.`)); }, timeoutMs);
  });
  const stem = basename(file, extname(file));

  const work = async (): Promise<RenderOfficeResult> => {
    let pdf: Buffer;
    if (isPdf) {
      pdf = await fs.readFile(file);
    } else {
      const soffice = await options.runtime.ensure(options.onProgress);
      const profile = join(tmp, 'profile'), input = join(tmp, 'input'), output = join(tmp, 'output');
      await Promise.all([fs.mkdir(profile), fs.mkdir(input), fs.mkdir(output)]);
      await writeRegistryDisableMacros(profile);
      const snapshot = join(input, `doc${ext}`);
      await fs.copyFile(file, snapshot);
      await run(soffice, ['--headless', `-env:UserInstallation=${pathToFileURL(profile).href}`, '--convert-to', 'pdf', '--outdir', output, snapshot], controller.signal);
      pdf = await fs.readFile(join(output, 'doc.pdf')).catch(() => { throw new Error('LibreOffice did not produce a PDF.'); });
    }
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('The converted file is not a valid PDF.');
    const { pageCount, pages } = await rasterize(new Uint8Array(pdf), { maxPages, scale, signal: controller.signal });
    if (controller.signal.aborted) throw new Error('Rendering was stopped.');
    // Everything succeeded: only now does anything appear in outDir.
    await fs.mkdir(options.outDir, { recursive: true });
    const written: string[] = [];
    try {
      let pdfPath = file;
      if (!isPdf) { pdfPath = join(options.outDir, `${stem}.pdf`); await fs.writeFile(pdfPath, pdf); written.push(pdfPath); }
      const paths: string[] = [];
      for (const [index, png] of pages.entries()) {
        if (controller.signal.aborted) throw new Error('Rendering was stopped.');
        const path = join(options.outDir, `page-${index + 1}.png`);
        await fs.writeFile(path, png); written.push(path); paths.push(path);
      }
      return { pdf: pdfPath, pages: paths, pageCount };
    } catch (error) {
      await Promise.all(written.map(path => fs.rm(path, { force: true })));
      throw error;
    }
  };

  const job = work();
  job.catch(() => undefined);
  try {
    return await Promise.race([job, deadline]);
  } finally {
    clearTimeout(timer);
    deadline.catch(() => undefined);
    // A timed-out job is not awaited (it may hang); it was told to stop and writes nothing to outDir once aborted.
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
