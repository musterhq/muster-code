// Muster's own office skills (#772 documents, #773 spreadsheets, #774 presentations, #775 PDF) and phase 2 of the
// office runtime (#789): an agent-mode chat gets Muster's skills and the muster_office tools, its scripts import the
// office libraries from any folder, office_render turns the result into page images, and nothing comes from another
// app's home. The coding client is a fake provider that acts like an agent following the skill.
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import {createOfficeDomain, officeRuntimeTesting} from '../src/runtime/domains/office.ts';
import {OFFICE_MCP, OFFICE_NOTE_PATTERN} from '../src/runtime/office-agent-tools.ts';
import {OFFICE_LIBRARY_NAMES, OfficeLibraries, localOfficeModules, type OfficeLibraryManifest} from '../src/runtime/office-libraries.ts';
import {prepareMusterCodexHome} from '../src/runtime/codex-home.ts';
import {MUSTER_OFFICE_SKILLS, musterSkillsDir} from '../src/runtime/office-skills.ts';
import {claudeLaneAllowed, LANE_DROPPED_SERVERS, withoutUnavailableToolNotes} from '../src/runtime/claude-lane.ts';
import {setOfficeRuntime} from '../src/runtime/document-preview.ts';
import {officeLibraryManifest} from '../scripts/office-libs-manifest.mjs';

const appDir = resolve(import.meta.dirname, '..');
const skillsSource = join(appDir, 'resources', 'skills');

async function directory(t: TestContext, prefix = 'muster-office-772-') {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, {recursive: true, force: true}));
  return realpathSync(path);
}
/** A small PNG (solid colour) for the image cases. */
async function png(path: string) {
  const {createCanvas} = await import('@napi-rs/canvas');
  const canvas = createCanvas(120, 80); const context = canvas.getContext('2d');
  context.fillStyle = '#2563eb'; context.fillRect(0, 0, 120, 80);
  await writeFile(path, canvas.toBuffer('image/png'));
}
/** A stand-in for soffice: writes a two-page PDF to --outdir as doc.pdf, like a real conversion would. */
async function fakeSoffice(dir: string): Promise<{path: string; calls: string}> {
  const fixture = join(dir, 'converted.pdf'), calls = join(dir, 'soffice-calls.txt');
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of ['Converted page one', 'Converted page two']) pdf.addPage([300, 200]).drawText(text, {x: 20, y: 100, size: 16, font});
  await writeFile(fixture, await pdf.save());
  const path = join(dir, 'soffice');
  await writeFile(path, `#!/bin/sh\necho "$@" >> '${calls}'\nwhile [ $# -gt 0 ]; do if [ "$1" = "--outdir" ]; then shift; cp '${fixture}' "$1/doc.pdf"; fi; shift; done\n`);
  await chmod(path, 0o755);
  return {path, calls};
}

/** Talks to a stdio MCP server the way the coding client does. */
function mcpClient(t: TestContext, command: string, env: Record<string, string>) {
  const child = spawn(command, [], {env: {...process.env, ...env}, stdio: ['pipe', 'pipe', 'inherit']});
  t.after(() => { child.kill(); });
  const waiting = new Map<number, (value: Record<string, unknown>) => void>(); let id = 0;
  createInterface({input: child.stdout!}).on('line', line => { const message = JSON.parse(line) as {id: number}; waiting.get(message.id)?.(message as never); waiting.delete(message.id); });
  const request = (method: string, params: unknown = {}) => new Promise<Record<string, unknown>>(done => { const n = ++id; waiting.set(n, done); child.stdin!.write(JSON.stringify({jsonrpc: '2.0', id: n, method, params}) + '\n'); });
  return {
    request,
    async call(name: string, args: Record<string, unknown> = {}) {
      const answer = await request('tools/call', {name, arguments: args});
      return (answer.result ?? {}) as {content: Array<{type: string; text?: string; data?: string; mimeType?: string}>; isError?: boolean};
    },
  };
}
const textOf = (result: {content: Array<{type: string; text?: string}>}) => result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');

type Kind = typeof MUSTER_OFFICE_SKILLS[number];
const OUTPUT: Record<Kind, string> = {documents: 'report.docx', spreadsheets: 'budget.xlsx', presentations: 'deck.pptx', pdf: 'report.pdf'};

interface AgentTurn { instructions: string; skill: string; setup: string; render: ReturnType<typeof mcpClient>['call'] extends (...a: never[]) => Promise<infer R> ? R : never; output: string; events: Array<Record<string, unknown>>; toolNames: string[]; overrides: Record<string, unknown> }

/**
 * One agent turn for a file type, with another app's home absent (HOME is an empty folder) and a fake soffice:
 * the fake agent reads the skill the note names, calls office_setup, copies the skill's example script into the
 * project, runs it with the command office_setup gave, then calls office_render on the result.
 */
async function agentTurn(t: TestContext, kind: Kind): Promise<AgentTurn> {
  const root = await directory(t), dataDir = join(root, 'data'), project = join(root, 'project'), home = join(root, 'home');
  await Promise.all([mkdir(project), mkdir(home)]);
  const previousHome = process.env.HOME; process.env.HOME = home;
  const soffice = await fakeSoffice(root);
  officeRuntimeTesting.options = {candidates: [soffice.path], env: {PATH: ''}, build: null};
  t.after(() => { process.env.HOME = previousHome; officeRuntimeTesting.options = undefined; setOfficeRuntime(null); });
  await png(join(project, 'picture.png'));

  const events: Array<Record<string, unknown>> = [];
  let turn: AgentTurn | undefined, failure: unknown;
  const provider: ProviderAdapter = {
    info: () => [{id: 'fixture', name: 'Fixture', available: true, identityMasked: 'fixture', models: [{id: 'fixture-model', name: 'Fixture'}]}],
    stop: async () => true, dispose() {},
    run: async input => {
      try {
        const instructions = input.developerInstructions ?? '';
        const overrides = (input.configOverrides ?? {}) as Record<string, unknown>;
        const skill = new RegExp(`${kind} (\\S+SKILL\\.md)`).exec(instructions)?.[1];
        assert.ok(skill, `the note names Muster's ${kind} skill`);
        const command = overrides[`mcp_servers.${OFFICE_MCP}.command`] as string;
        const client = mcpClient(t, command, {MUSTER_CHAT_ID: String(overrides[`mcp_servers.${OFFICE_MCP}.env.MUSTER_CHAT_ID`])});
        await client.request('initialize', {protocolVersion: '2025-06-18'});
        const tools = ((await client.request('tools/list')).result as {tools: Array<{name: string}>}).tools.map(tool => tool.name);
        const setup = textOf(await client.call('office_setup'));
        const node = JSON.parse(/Run scripts with: ("[^"]+")/.exec(setup)![1]!) as string;
        await copyFile(join(skill.replace(/SKILL\.md$/, ''), 'example.mjs'), join(input.cwd, 'make.mjs'));
        execFileSync(node, ['make.mjs', OUTPUT[kind], 'picture.png'], {cwd: input.cwd, env: {...process.env, NODE_PATH: ''}, stdio: 'pipe'});
        const render = await client.call('office_render', {path: OUTPUT[kind], inline_pages: 2});
        turn = {instructions, skill, setup, render: render as never, output: join(input.cwd, OUTPUT[kind]), events, toolNames: tools, overrides};
        return {status: 'completed', finalMessage: `Made ${OUTPUT[kind]}`};
      } catch (error) { failure = error; return {status: 'failed', finalMessage: '', errorMessage: String(error)}; }
    },
  };
  const service = createAgentService({dataDir, provider, onEvent: event => events.push(event as never)});
  t.after(() => service.dispose());
  const folder = await service.invoke('folder.add', {path: project});
  const chat = await service.invoke('chat.create', {folderId: folder.id});
  await service.invoke('chat.send', {id: chat.id, text: `Make a ${kind} file`, requestId: `office-${kind}`} as never);
  for (let i = 0; i < 1500 && !turn && !failure; i++) await new Promise(done => setTimeout(done, 20));
  if (failure) throw failure;
  assert.ok(turn, 'the agent turn ran');
  assert.ok(!existsSync(join(home, '.codex')), 'nothing was made in another app\'s home');
  return turn;
}

function assertRendered(turn: AgentTurn, pages: number) {
  assert.ok(!turn.render.isError, textOf(turn.render));
  const text = textOf(turn.render);
  const paths = [...text.matchAll(/^Page \d+: (.+\.png)$/gm)].map(match => match[1]!);
  assert.equal(paths.length, pages, text);
  for (const path of paths) assert.deepEqual([...readFileSync(path).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${path} is a PNG`);
  const images = turn.render.content.filter(part => part.type === 'image');
  assert.equal(images.length, Math.min(2, pages), 'the first pages come back as images the agent can look at');
  assert.ok(images.every(image => image.mimeType === 'image/png' && (image.data?.length ?? 0) > 100));
  return {text, paths};
}

// Spec: MUS-SPEC-21-772A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-772a)
test('an agent makes a .docx with Muster\'s documents skill and sees its pages, with no other app installed', async t => {
  const turn = await agentTurn(t, 'documents');
  assert.ok(turn.skill.startsWith(skillsSource), 'the skill is Muster\'s own copy');
  assert.match(readFileSync(turn.skill, 'utf8'), /^name: documents$/m);
  assert.deepEqual(turn.toolNames, ['office_setup', 'office_render']);
  assert.match(turn.setup, /docx 9\.\d+\.\d+/);
  const zip = await JSZip.loadAsync(await readFile(turn.output));
  const xml = await zip.file('word/document.xml')!.async('string');
  for (const part of ['Heading1', '<w:tbl>', '<w:numPr>', 'Quarterly report']) assert.ok(xml.includes(part), `document.xml has ${part}`);
  assert.ok(Object.keys(zip.files).some(name => name.startsWith('word/media/')), 'the image is embedded');
  const {text} = assertRendered(turn, 2);
  assert.match(text, /^PDF: .+report\.pdf$/m);
  // An edit with jszip as the skill shows keeps the document's styles and numbering.
  const styles = await zip.file('word/styles.xml')!.async('string');
  zip.file('word/document.xml', xml.replace('Quarterly report', 'Annual report'));
  const edited = await JSZip.loadAsync(await zip.generateAsync({type: 'nodebuffer'}));
  assert.equal(await edited.file('word/styles.xml')!.async('string'), styles);
  assert.match(await edited.file('word/document.xml')!.async('string'), /Annual report/);
});

// Spec: MUS-SPEC-21-773A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-773a)
test('an agent makes an .xlsx with live formulas using Muster\'s spreadsheets skill and sees its pages', async t => {
  const turn = await agentTurn(t, 'spreadsheets');
  assert.match(readFileSync(turn.skill, 'utf8'), /^name: spreadsheets$/m);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(turn.output);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Sales', 'Summary']);
  const sales = workbook.getWorksheet('Sales')!, summary = workbook.getWorksheet('Summary')!;
  assert.equal(sales.getCell('D2').formula, 'B2*C2');
  assert.equal(sales.getCell('D5').formula, 'SUM(D2:D4)');
  assert.equal(summary.getCell('B1').formula, 'Sales!D5', 'a cross-sheet formula stays a formula');
  assert.equal(sales.getCell('C2').numFmt, '"$"#,##0.00');
  assert.equal(sales.getCell('E2').numFmt, '0.0%');
  const zip = await JSZip.loadAsync(await readFile(turn.output));
  assert.match(await zip.file('xl/workbook.xml')!.async('string'), /fullCalcOnLoad="1"/, 'formulas recalculate when the file opens');
  // #773: the example adds a native, editable chart with Muster's chart writer: a chart part whose series reads the
  // Revenue cells, anchored on the Summary sheet.
  assert.match(readFileSync(turn.skill, 'utf8'), /muster-xlsx-charts/, 'the skill teaches the chart writer');
  const chartParts = Object.keys(zip.files).filter(name => /^xl\/charts\/chart\d+\.xml$/.test(name));
  assert.equal(chartParts.length, 1, 'the workbook has one native chart part');
  const chartXml = await zip.file(chartParts[0]!)!.async('string');
  assert.match(chartXml, /<c:barChart>/);
  assert.match(chartXml, /<c:val><c:numRef><c:f>Sales!\$D\$2:\$D\$4<\/c:f>/, 'the series reads the Revenue cells');
  assert.match(await zip.file('[Content_Types].xml')!.async('string'), /drawingml\.chart\+xml/);
  assertRendered(turn, 2);
  // Editing keeps formats and formulas.
  sales.getCell('B2').value = 999;
  await workbook.xlsx.writeFile(turn.output + '.edited.xlsx');
  const again = new ExcelJS.Workbook(); await again.xlsx.readFile(turn.output + '.edited.xlsx');
  assert.equal(again.getWorksheet('Sales')!.getCell('D5').formula, 'SUM(D2:D4)');
  assert.equal(again.getWorksheet('Sales')!.getCell('C2').numFmt, '"$"#,##0.00');
});

// Spec: MUS-SPEC-21-774A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-774a)
test('an agent makes a .pptx with Muster\'s presentations skill and sees each slide', async t => {
  const turn = await agentTurn(t, 'presentations');
  assert.match(readFileSync(turn.skill, 'utf8'), /^name: presentations$/m);
  const zip = await JSZip.loadAsync(await readFile(turn.output));
  const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slides.length, 5, 'title, bullets, chart, table and picture slides');
  assert.ok(Object.keys(zip.files).some(name => /^ppt\/charts\/chart\d+\.xml$/.test(name)), 'the chart is a native chart');
  assert.ok(Object.keys(zip.files).some(name => name.startsWith('ppt/media/')), 'the picture is embedded');
  assert.ok(Object.keys(zip.files).some(name => name.startsWith('ppt/slideLayouts/')), 'slides sit on layouts');
  assertRendered(turn, 2);
});

// Spec: MUS-SPEC-21-775A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-775a)
test('an agent makes a PDF with a form using Muster\'s pdf skill, reads its text, fills the form and sees its pages', async t => {
  const turn = await agentTurn(t, 'pdf');
  assert.match(readFileSync(turn.skill, 'utf8'), /^name: pdf$/m);
  const pdf = await PDFDocument.load(await readFile(turn.output));
  assert.deepEqual(pdf.getForm().getFields().map(field => field.getName()).sort(), ['approver.approved', 'approver.name']);
  pdf.getForm().getTextField('approver.name').setText('Ada Lovelace'); pdf.getForm().getCheckBox('approver.approved').check();
  const filled = await PDFDocument.load(await pdf.save());
  assert.equal(filled.getForm().getTextField('approver.name').getText(), 'Ada Lovelace');
  // Text extraction the way the skill shows it.
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({data: new Uint8Array(await readFile(turn.output)), useSystemFonts: false}); const doc = await task.promise;
  const words = (await (await doc.getPage(1)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ');
  assert.match(words, /Quarterly report/); assert.match(words, /North/);
  await task.destroy();
  const {text} = assertRendered(turn, 1);
  assert.match(text, /^PDF: .+report\.pdf$/m, 'a PDF renders directly, without LibreOffice');
});

// Spec: MUS-SPEC-21-789M (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789m)
test('the first render shows LibreOffice download progress on the chat\'s tool row', async t => {
  const root = await directory(t), dataDir = join(root, 'data'), project = join(root, 'project');
  await mkdir(project);
  const soffice = await fakeSoffice(root);
  // No LibreOffice installed: the pinned build downloads (a fake server and unpacker that puts the fake soffice in place).
  const payload = Buffer.from('fake libreoffice archive');
  const build = {version: '26.2.6', platform: process.platform, arch: process.arch, kind: 'dmg' as const, file: 'lo.dmg', urls: ['https://example.invalid/lo.dmg'], sha256: createHash('sha256').update(payload).digest('hex'), bytes: payload.length};
  officeRuntimeTesting.options = {candidates: [], env: {PATH: ''}, build,
    fetch: async () => ({status: 200, headers: {get: () => null}, body: (async function* () { yield payload.subarray(0, 10); await new Promise(done => setTimeout(done, 250)); yield payload.subarray(10); })()}),
    extract: async (_archive, into) => { await mkdir(join(into, 'LibreOffice.app', 'Contents', 'MacOS'), {recursive: true}); await copyFile(soffice.path, join(into, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice')); await chmod(join(into, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'), 0o755); }};
  t.after(() => { officeRuntimeTesting.options = undefined; setOfficeRuntime(null); });
  await writeFile(join(project, 'notes.docx'), 'not really a docx; the fake soffice converts anything');
  const events: Array<{type: string; chatId?: string; message?: string | null}> = [];
  let result: Awaited<ReturnType<ReturnType<typeof mcpClient>['call']>> | undefined;
  const provider: ProviderAdapter = {
    info: () => [{id: 'fixture', name: 'Fixture', available: true, identityMasked: 'fixture', models: [{id: 'fixture-model', name: 'Fixture'}]}],
    stop: async () => true, dispose() {},
    run: async input => {
      const overrides = input.configOverrides as Record<string, string>;
      const client = mcpClient(t, overrides[`mcp_servers.${OFFICE_MCP}.command`]!, {MUSTER_CHAT_ID: input.chat.id});
      result = await client.call('office_render', {path: 'notes.docx'});
      return {status: 'completed', finalMessage: 'ok'};
    },
  };
  const service = createAgentService({dataDir, provider, onEvent: event => events.push(event as never)});
  t.after(() => service.dispose());
  const folder = await service.invoke('folder.add', {path: project});
  const chat = await service.invoke('chat.create', {folderId: folder.id});
  await service.invoke('chat.send', {id: chat.id, text: 'Render notes.docx', requestId: 'office-progress'} as never);
  for (let i = 0; i < 1500 && !result; i++) await new Promise(done => setTimeout(done, 20));
  assert.ok(result && !result.isError, result ? textOf(result) : 'no result');
  const progress = events.filter(event => event.type === 'officeToolProgress');
  assert.ok(progress.some(event => event.chatId === chat.id && /Downloading LibreOffice/.test(event.message ?? '')), JSON.stringify(progress));
  assert.equal(progress.at(-1)?.message, null, 'the row is cleared when the tool finishes');
  assert.ok(existsSync(join(dataDir, 'office-runtime', 'libreoffice', '26.2.6')), 'LibreOffice went into Muster\'s data folder');
  assert.match(readFileSync(soffice.calls, 'utf8'), /--convert-to pdf/);
});

// Spec: MUS-SPEC-14-772B (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-772b)
test('Muster\'s home links the person\'s own skills and plugins but not another app\'s office ones, and installs Muster\'s', async t => {
  const root = await directory(t), source = join(root, 'person-home'), home = join(root, 'muster-home');
  for (const dir of ['skills/my-skill', 'skills/pdf', 'skills/docx', 'skills/.system/helper', 'plugins/cache/runtime-market/documents/1.0', 'plugins/cache/runtime-market/pdf/1.0',
    'plugins/cache/runtime-market/template-maker/1.0', 'plugins/cache/curated/github/1.0', 'plugins/data']) await mkdir(join(source, dir), {recursive: true});
  await writeFile(join(source, 'skills/my-skill/SKILL.md'), '---\nname: my-skill\n---\nMine.\n');
  await writeFile(join(source, 'skills/pdf/SKILL.md'), '---\nname: pdf\n---\nAnother app\'s PDF skill.\n');
  await writeFile(join(source, 'config.toml'), 'model = "x"\n');
  // Before this change the whole skills and plugins folders were links into the person's home.
  await mkdir(home, {recursive: true});
  await symlink(join(source, 'skills'), join(home, 'skills'));
  await symlink(join(source, 'plugins'), join(home, 'plugins'));

  prepareMusterCodexHome(source, home, {musterSkills: skillsSource});
  const linkTo = (path: string) => { try { return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null; } catch { return null; } };
  assert.ok(lstatSync(join(home, 'skills')).isDirectory() && !lstatSync(join(home, 'skills')).isSymbolicLink(), 'skills is Muster\'s own folder now');
  assert.equal(linkTo(join(home, 'skills', 'my-skill')), join(source, 'skills', 'my-skill'), 'the person\'s own skill still loads');
  assert.equal(linkTo(join(home, 'skills', '.system')), join(source, 'skills', '.system'));
  assert.equal(linkTo(join(home, 'skills', 'docx')), null);
  assert.ok(!existsSync(join(home, 'skills', 'docx')), 'another app\'s office skill is not linked in');
  for (const name of MUSTER_OFFICE_SKILLS) {
    assert.equal(linkTo(join(home, 'skills', name)), null);
    assert.equal(readFileSync(join(home, 'skills', name, 'SKILL.md'), 'utf8'), readFileSync(join(skillsSource, name, 'SKILL.md'), 'utf8'), `${name} is Muster's skill`);
  }
  assert.equal(linkTo(join(home, 'plugins', 'data')), join(source, 'plugins', 'data'));
  assert.equal(linkTo(join(home, 'plugins', 'cache', 'curated')), join(source, 'plugins', 'cache', 'curated'), 'a marketplace with no office plugin is linked whole');
  assert.equal(linkTo(join(home, 'plugins', 'cache', 'runtime-market', 'template-maker')), join(source, 'plugins', 'cache', 'runtime-market', 'template-maker'));
  assert.ok(!existsSync(join(home, 'plugins', 'cache', 'runtime-market', 'documents')) && !existsSync(join(home, 'plugins', 'cache', 'runtime-market', 'pdf')), 'office plugins are not linked in');
  assert.equal(linkTo(join(home, 'config.toml')), join(source, 'config.toml'));
  // The person's home is untouched: their folders are still there with what they had.
  assert.equal(readFileSync(join(source, 'skills/pdf/SKILL.md'), 'utf8'), '---\nname: pdf\n---\nAnother app\'s PDF skill.\n');
  assert.ok(existsSync(join(source, 'plugins/cache/runtime-market/documents/1.0')));

  // Again: nothing changes; a skill the person removes disappears; one they add appears.
  await rm(join(source, 'skills', 'my-skill'), {recursive: true});
  await mkdir(join(source, 'skills', 'new-skill'));
  prepareMusterCodexHome(source, home, {musterSkills: skillsSource});
  assert.ok(!existsSync(join(home, 'skills', 'my-skill')) && !lstatSync(join(home, 'skills')).isSymbolicLink());
  assert.equal(linkTo(join(home, 'skills', 'new-skill')), join(source, 'skills', 'new-skill'));
  assert.ok(existsSync(join(home, 'skills', 'documents', 'SKILL.md')));

  // A person's home with no skills folder still gets Muster's skills.
  const bare = join(root, 'bare-source'), bareHome = join(root, 'bare-home');
  await mkdir(bare);
  prepareMusterCodexHome(bare, bareHome, {musterSkills: skillsSource});
  assert.deepEqual((await readdir(join(bareHome, 'skills'))).sort(), [...MUSTER_OFFICE_SKILLS].sort());
});

// Spec: MUS-SPEC-14-772C (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-772c)
test('agent chats get the muster_office server and a note naming Muster\'s skills; router chats are not forced off their route', async t => {
  const root = await directory(t);
  let contributor: ((chat: never) => Promise<unknown>) | undefined;
  const domain = createOfficeDomain({dataDir: root, db: () => { throw new Error('x'); }, store: {chat: () => ({id: 'c1'})} as never, emit() {}, emitSnapshot() {}, folderFor: () => { throw new Error('x'); }, invoke: async () => { throw new Error('x'); },
    hooks: {addRunOptionsContributor: (fn: never) => { contributor = fn; return () => {}; }, addPromptContributor: () => () => {}, onRunStarted: () => () => {}, onRunSettled: () => () => {}, setChatDefaults() {}, setRunEnvironmentResolver() {}} as never});
  t.after(() => { domain.dispose?.(); setOfficeRuntime(null); });
  assert.equal(await contributor!({id: 'c1', mode: 'plan'} as never), null, 'only agent-mode chats get the tools');
  const options = await contributor!({id: 'c1', mode: 'agent'} as never) as {configOverrides: Record<string, string | number>; developerInstructions: string};
  assert.ok(existsSync(String(options.configOverrides[`mcp_servers.${OFFICE_MCP}.command`])));
  assert.equal(options.configOverrides[`mcp_servers.${OFFICE_MCP}.env.MUSTER_CHAT_ID`], 'c1');
  assert.ok(Number(options.configOverrides[`mcp_servers.${OFFICE_MCP}.tool_timeout_sec`]) >= 600, 'long enough for a first download');
  for (const name of MUSTER_OFFICE_SKILLS) assert.ok(options.developerInstructions.includes(join(skillsSource, name, 'SKILL.md')), `the note names Muster's ${name} skill`);
  assert.match(options.developerInstructions, /take precedence over any other/);
  // The skills shipped in the app and the folder the runtime resolves are the same.
  assert.equal(musterSkillsDir(join(appDir, 'src', 'runtime')), skillsSource);
  for (const name of MUSTER_OFFICE_SKILLS) {
    const text = readFileSync(join(skillsSource, name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: .{40,}`, 'm'));
    assert.match(text, /office_setup/); assert.match(text, /office_render/);
    assert.doesNotMatch(text, /python|pip install|\bcodex\b|chatgpt|cursor|\bt3\b/i, `${name} names no other product or Python`);
  }
  const note = `Office files: for Word (.docx), Excel... ${join(skillsSource, 'pdf', 'SKILL.md')}.`;
  assert.match(note, OFFICE_NOTE_PATTERN);
  assert.equal(withoutUnavailableToolNotes(`Before.\n\n${note}\n\nAfter.`), 'Before.\n\nAfter.');
  assert.ok(LANE_DROPPED_SERVERS.includes(OFFICE_MCP));
  assert.equal(claudeLaneAllowed('full', {[`mcp_servers.${OFFICE_MCP}.command`]: '/x', [`mcp_servers.${OFFICE_MCP}.env.MUSTER_CHAT_ID`]: 'c1'}), true);
});

// Spec: MUS-SPEC-14-772D (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-772d)
test('the office libraries resolve from an agent script\'s own working folder, by import and by require', async t => {
  const root = await directory(t), work = join(root, 'some project', 'deep');
  await mkdir(work, {recursive: true});
  const libraries = new OfficeLibraries({root: join(root, 'office-libs'), execPath: process.execPath, localModules: localOfficeModules(join(appDir, 'src', 'runtime'))});
  const ready = await libraries.ensure();
  assert.equal(ready.source, 'local');
  assert.deepEqual(Object.keys(ready.versions).sort(), [...OFFICE_LIBRARY_NAMES].sort());
  await writeFile(join(work, 'esm.mjs'), `import { Document } from 'docx'; import ExcelJS from 'exceljs'; import pptxgen from 'pptxgenjs'; import { PDFDocument } from 'pdf-lib'; import JSZip from 'jszip'; import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';\nconsole.log([Document, ExcelJS.Workbook, pptxgen, PDFDocument, JSZip, getDocument].map(x => typeof x).join(','));\n`);
  await writeFile(join(work, 'cjs.cjs'), `console.log(['docx', 'exceljs', 'pptxgenjs', 'pdf-lib', 'jszip'].map(name => typeof require(name)).join(','));\n`);
  const env = {...process.env, NODE_PATH: ''};
  assert.equal(execFileSync(ready.node, ['esm.mjs'], {cwd: work, env, encoding: 'utf8'}).trim(), 'function,function,function,function,function,function');
  assert.equal(execFileSync(ready.node, ['cjs.cjs'], {cwd: work, env, encoding: 'utf8'}).trim(), 'object,object,function,object,function');
  // A script's own dependency still wins over Muster's copy.
  await mkdir(join(work, 'node_modules', 'jszip'), {recursive: true});
  await writeFile(join(work, 'node_modules', 'jszip', 'package.json'), JSON.stringify({name: 'jszip', version: '0.0.1', main: 'index.js'}));
  await writeFile(join(work, 'node_modules', 'jszip', 'index.js'), 'module.exports = "project copy";');
  await writeFile(join(work, 'own.mjs'), `import zip from 'jszip'; console.log(zip);\n`);
  assert.equal(execFileSync(ready.node, ['own.mjs'], {cwd: work, env, encoding: 'utf8'}).trim(), 'project copy');
  // Remove takes the links away and never touches the checkout's own packages.
  await libraries.remove();
  assert.ok(!existsSync(ready.modules) && existsSync(join(appDir, 'node_modules', 'docx', 'package.json')));
});

/** An npm-style tarball (top folder `package/`) for a tiny package, with its sha512 integrity. */
async function tarball(root: string, name: string, version: string, body: string) {
  const dir = join(root, 'src', name.replace('/', '__'), 'package');
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, 'package.json'), JSON.stringify({name, version, main: 'index.js'}));
  await writeFile(join(dir, 'index.js'), body);
  const file = join(root, `${name.replace('/', '__')}-${version}.tgz`);
  execFileSync('tar', ['-czf', file, '-C', join(dir, '..'), 'package']);
  const data = await readFile(file);
  return {data, integrity: `sha512-${createHash('sha512').update(data).digest('base64')}`};
}

// Spec: MUS-SPEC-21-789N (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789n)
test('a packaged app downloads the pinned office libraries once, checks each against its integrity and installs them atomically', async t => {
  const root = await directory(t);
  const packages: OfficeLibraryManifest['packages'] = [];
  const served = new Map<string, Buffer>();
  for (const name of [...OFFICE_LIBRARY_NAMES, 'helper-dep']) {
    const body = name === 'docx' ? `module.exports = { Document: function Document() {}, helper: require('helper-dep') };` : name === 'helper-dep' ? 'module.exports = "nested helper";' : 'module.exports = {};';
    const {data, integrity} = await tarball(join(root, 'registry'), name, '1.0.0', body);
    const url = `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`;
    served.set(url, data);
    packages.push({path: name === 'helper-dep' ? 'node_modules/docx/node_modules/helper-dep' : `node_modules/${name}`, name, version: '1.0.0', resolved: url, integrity});
  }
  let requests = 0;
  const fetch = async (url: string) => { requests++; const data = served.get(url); return {status: data ? 200 : 404, headers: {get: () => null}, body: data ? (async function* () { yield data; })() : null}; };
  const progress: string[] = [];
  const libraries = new OfficeLibraries({root: join(root, 'office-libs'), execPath: process.execPath, manifest: {packages}, localModules: null, fetch, onProgress: p => { if (p) progress.push(`${p.phase} ${p.done}/${p.total}`); }});
  const [first, second] = await Promise.all([libraries.ensure(), libraries.ensure()]);
  assert.equal(requests, packages.length, 'two callers share one download');
  assert.deepEqual(first, second);
  assert.equal(first.source, 'downloaded');
  assert.ok(progress.includes(`downloading 0/${packages.length}`) && progress.includes(`downloading ${packages.length}/${packages.length}`), progress.join(', '));
  const work = join(root, 'work'); await mkdir(work);
  await writeFile(join(work, 'a.cjs'), `console.log(require('docx').helper)`);
  assert.equal(execFileSync(first.node, ['a.cjs'], {cwd: work, encoding: 'utf8', env: {...process.env, NODE_PATH: ''}}).trim(), 'nested helper', 'the lockfile\'s nested layout is kept');
  assert.equal((await libraries.status()).ready, true);
  assert.ok(((await libraries.status()).bytes ?? 0) > 0);
  await libraries.ensure();
  assert.equal(requests, packages.length, 'an installed set is not downloaded again');

  // A tampered tarball is refused and nothing new is installed.
  const tampered = new OfficeLibraries({root: join(root, 'other-libs'), execPath: process.execPath, manifest: {packages: packages.map((entry, index) => index === 0 ? {...entry, integrity: `sha512-${createHash('sha512').update('else').digest('base64')}`} : entry)}, localModules: null, fetch});
  await assert.rejects(tampered.ensure(), /did not match its checksum/);
  assert.ok(!existsSync(join(root, 'other-libs', 'node_modules')));
  assert.deepEqual((await readdir(join(root, 'other-libs'))).filter(name => name.startsWith('staging-')), []);
  // A non-registry URL is refused before anything is fetched.
  const before = requests;
  await assert.rejects(new OfficeLibraries({root: join(root, 'third'), execPath: process.execPath, manifest: {packages: [{...packages[0]!, resolved: 'https://elsewhere.example/x.tgz'}]}, localModules: null, fetch}).ensure(), /not an npm registry download/);
  assert.equal(requests, before);

  const removed = await libraries.remove();
  assert.ok(removed.removed && removed.bytes > 0);
  assert.equal((await libraries.status()).ready, false);
});

// Spec: MUS-SPEC-21-789O (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789o)
test('the build pins every office library and its dependencies from the lockfile', () => {
  const lock = JSON.parse(readFileSync(join(appDir, 'package-lock.json'), 'utf8'));
  const manifest = officeLibraryManifest(lock) as OfficeLibraryManifest;
  for (const name of OFFICE_LIBRARY_NAMES) {
    const entry = manifest.packages.find(item => item.path === `node_modules/${name}`);
    assert.equal(entry?.version, lock.packages[`node_modules/${name}`].version, `${name} is pinned to the lockfile`);
  }
  for (const entry of manifest.packages) {
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-/);
    assert.ok(!entry.name.startsWith('@types/'), 'type packages are left out');
  }
  // Every runtime dependency of a pinned package is pinned too.
  const paths = new Set(manifest.packages.map(entry => entry.path));
  for (const entry of manifest.packages) for (const dep of Object.keys(lock.packages[entry.path].dependencies ?? {})) {
    if (dep.startsWith('@types/')) continue;
    assert.ok([...paths].some(path => path.endsWith(`node_modules/${dep}`)), `${entry.name} needs ${dep}`);
  }
  assert.ok(statSync(join(appDir, 'scripts', 'office-libs-manifest.mjs')).isFile());
});

// Spec: MUS-SPEC-21-772Q (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-772q)
test('each office type previews in Muster with no other app installed', async t => {
  const root = await directory(t), project = join(root, 'project');
  await mkdir(project);
  const libraries = new OfficeLibraries({root: join(root, 'office-libs'), execPath: process.execPath, localModules: localOfficeModules(join(appDir, 'src', 'runtime'))});
  const {node} = await libraries.ensure();
  await png(join(project, 'picture.png'));
  for (const kind of MUSTER_OFFICE_SKILLS) execFileSync(node, [join(skillsSource, kind, 'example.mjs'), OUTPUT[kind], 'picture.png'], {cwd: project, stdio: 'pipe'});
  const {readDocument} = await import('../src/runtime/document-preview.ts');
  const {readWorkbook} = await import('../src/runtime/workbook-preview.ts');
  const previousSoffice = process.env.MUSTER_SOFFICE_PATH; delete process.env.MUSTER_SOFFICE_PATH;
  t.after(() => { if (previousSoffice !== undefined) process.env.MUSTER_SOFFICE_PATH = previousSoffice; setOfficeRuntime(null); });

  // PDF and Excel need nothing else: pdf.js reads the PDF, the workbook grid reads the .xlsx.
  setOfficeRuntime(null);
  const pdf = await readDocument(project, OUTPUT.pdf);
  assert.equal(pdf.converted, false);
  assert.equal(Buffer.from(pdf.base64, 'base64').subarray(0, 5).toString(), '%PDF-');
  const workbook = await readWorkbook(project, OUTPUT.spreadsheets);
  assert.deepEqual(workbook.sheets.map(sheet => sheet.name), ['Sales', 'Summary']);
  assert.equal(workbook.sheets[0]!.rows[0]![0], 'Month');
  assert.equal(workbook.sheets[0]!.formulas['D5'], 'SUM(D2:D4)', 'the grid shows the formula behind a total');

  // Word and PowerPoint go through Muster's own office runtime (here a stand-in soffice), never another app's copy.
  const soffice = await fakeSoffice(root);
  setOfficeRuntime({soffice: async () => soffice.path});
  for (const kind of ['documents', 'presentations'] as const) {
    const preview = await readDocument(project, OUTPUT[kind]);
    assert.equal(preview.converted, true, `${kind} is converted`);
    assert.equal(Buffer.from(preview.base64, 'base64').subarray(0, 5).toString(), '%PDF-');
  }
});
