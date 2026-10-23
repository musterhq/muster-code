#!/usr/bin/env node
// Checks docs/spec: every acceptance case has its seven fields, names exactly one real, non-skipped test,
// and that test names the case back with a `// Spec:` comment. It does not run tests. See docs/spec/acceptance-cases.md.
import {readFileSync, readdirSync, existsSync, statSync} from 'node:fs';
import {join, resolve, relative, sep} from 'node:path';

const FIELDS = ['Precondition', 'Action', 'Expected result', 'Test', 'Environment', 'Known gaps', 'Evidence'];
const CASE_ID = /^MUS-SPEC-(\d{2})-(\d+)([A-Z])$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'release', 'release-dist', 'build', 'out']);
const SHA = /^[0-9a-f]{40}$/;

function args(argv) {
  const at = argv.indexOf('--root');
  return {root: resolve(at >= 0 ? argv[at + 1] : join(import.meta.dirname, '..'))};
}
const posix = path => path.split(sep).join('/');
const read = path => readFileSync(path, 'utf8');

/** Blank comments and string contents so `test(` inside them is not a call; keep line structure and record literals. */
function scanSource(text) {
  const out = text.split('');
  const literals = new Map(); // start offset of the opening quote -> {value, end, interpolated}
  const comments = new Map(); // 1-based line -> text after `//` when the comment is the only thing on its line
  let i = 0, line = 1;
  const lineStart = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') lineStart.push(k + 1);
  const lineOf = pos => { let lo = 0, hi = lineStart.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') {
      const end = text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i);
      line = lineOf(i);
      if (text.slice(lineStart[line - 1], i).trim() === '') comments.set(line, text.slice(i + 2, end));
      for (let k = i; k < end; k++) out[k] = ' ';
      i = end; continue;
    }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2) < 0 ? text.length : text.indexOf('*/', i + 2) + 2;
      for (let k = i; k < end; k++) if (text[k] !== '\n') out[k] = ' ';
      i = end; continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1, value = '', interpolated = false;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') { const e = text[j + 1]; value += e === 'n' ? '\n' : e === 't' ? '\t' : e; j += 2; continue; }
        if (c === '`' && text[j] === '$' && text[j + 1] === '{') interpolated = true;
        if (c !== '`' && text[j] === '\n') break;
        value += text[j]; j++;
      }
      literals.set(i, {value, end: j + 1, interpolated});
      for (let k = i + 1; k < j; k++) if (text[k] !== '\n') out[k] = ' ';
      i = j + 1; continue;
    }
    i++;
  }
  return {masked: out.join(''), literals, comments, lineOf};
}

/** Find test/it/check calls with their first-argument name and whether they are skipped or dynamic. */
function testCalls(text, allowCheck) {
  const {masked, literals, comments, lineOf} = scanSource(text);
  const calls = [];
  const head = allowCheck ? /(?<![\w$.])(x?(?:it|test|check)(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g : /(?<![\w$.])(x?(?:it|test)(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g;
  for (const match of masked.matchAll(head)) {
    const written = match[1].replace(/\s+/g, '');
    let p = match.index + match[0].length;
    while (/\s/.test(masked[p] ?? '')) p++;
    const literal = literals.get(p);
    const name = literal && !literal.interpolated ? literal.value : null;
    let skipped = written !== 'test' && written !== 'it' && written !== 'check';
    if (literal && !skipped) {
      // An options object as the second argument with skip/todo/only also skips the test.
      let q = literal.end;
      while (/\s/.test(masked[q] ?? '')) q++;
      if (masked[q] === ',') {
        q++; while (/\s/.test(masked[q] ?? '')) q++;
        if (masked[q] === '{') {
          let depth = 0, r = q;
          for (; r < masked.length; r++) { if (masked[r] === '{') depth++; else if (masked[r] === '}' && --depth === 0) break; }
          if (/\b(skip|todo|only)\b/.test(masked.slice(q, r + 1))) skipped = true;
        }
      }
    }
    calls.push({head: written, name, skipped, line: lineOf(match.index)});
  }
  return {calls, comments};
}

/** `// Spec:` lines in the unbroken // comment block that ends on the line directly above the call. */
function specCommentsAbove(comments, line) {
  const found = [];
  for (let l = line - 1; comments.has(l); l--) {
    const body = comments.get(l).trim();
    if (body.startsWith('Spec:')) found.unshift(body);
  }
  return found;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function parseEvidence(value) {
  if (/^UNVERIFIED(?::\s*\S.*)?$/.test(value)) return {ok: true, verified: false};
  const m = /^(local|ci);\s*(.+?);\s*exit (\d+);\s*(\d+) passed, (\d+) failed, (\d+) skipped;\s*commit (\S+)$/.exec(value);
  if (!m) return {ok: false, why: 'Evidence must be UNVERIFIED or a "local;" or "ci;" receipt (see acceptance-cases.md)'};
  const [, kind, where, exit, passed, failed, , sha] = m;
  if (!SHA.test(sha)) return {ok: false, why: 'Evidence commit must be a full 40-character SHA'};
  if (kind === 'ci' && !/^https:\/\/github\.com\/[^\s]+\/actions\/runs\/\d+/.test(where)) return {ok: false, why: 'a "ci;" Evidence receipt needs a GitHub Actions run URL'};
  if (exit === '0' && (Number(failed) !== 0 || Number(passed) < 1)) return {ok: false, why: 'Evidence exit 0 needs 0 failed and at least 1 passed'};
  if (exit !== '0' && Number(failed) === 0) return {ok: false, why: 'Evidence with a non-zero exit must report a failure'};
  return {ok: true, verified: true};
}

export function check(root) {
  const errors = [];
  const specDir = join(root, 'docs/spec');
  const clauseDir = join(specDir, 'clauses');
  const clauseFiles = existsSync(clauseDir) ? readdirSync(clauseDir).filter(name => name.endsWith('.md')).sort() : [];
  const cases = new Map(); // id -> {file, anchor, test: {path, name} | null}
  const clausesWithCases = new Set();

  // Clause index in README: every listed file exists, every file is listed.
  const readme = existsSync(join(specDir, 'README.md')) ? read(join(specDir, 'README.md')) : '';
  const listed = new Map([...readme.matchAll(/^\|\s*`MUS-SPEC-(\d{2})`\s*\|[^|]*\|\s*\[[^\]]*\]\(clauses\/([^)]+)\)\s*\|/gm)].map(m => [m[1], m[2]]));
  for (const [nn, file] of listed) if (!clauseFiles.includes(file)) errors.push(`docs/spec/README.md: clause MUS-SPEC-${nn} lists clauses/${file}, which does not exist`);
  for (const file of clauseFiles) {
    const nn = file.slice(0, 2);
    if (!/^\d{2}-[a-z0-9-]+\.md$/.test(file)) errors.push(`docs/spec/clauses/${file}: clause files are named NN-area.md`);
    if (listed.get(nn) !== file) errors.push(`docs/spec/README.md: clause index has no row for clauses/${file}`);
  }

  for (const file of clauseFiles) {
    const rel = `docs/spec/clauses/${file}`;
    const nn = file.slice(0, 2);
    const text = read(join(clauseDir, file));
    const title = /^# MUS-SPEC-(\d{2}):/.exec(text);
    if (!title || title[1] !== nn) errors.push(`${rel}: the first line must be "# MUS-SPEC-${nn}: <area>"`);
    const section = text.indexOf('\n## Acceptance cases');
    if (section < 0) { errors.push(`${rel}: missing the "## Acceptance cases" section`); continue; }
    const before = text.slice(0, section), body = text.slice(section);
    if (/^#{4}\s+MUS-SPEC-/m.test(before)) errors.push(`${rel}: a case heading sits outside "## Acceptance cases"`);
    const blocks = [...body.matchAll(/<a id="([^"]+)"><\/a>\n####\s+(MUS-SPEC-[^:\s]+):\s*(.+)\n([\s\S]*?)(?=\n<a id="|\n#{2,3}\s|$)/g)];
    const stray = [...body.matchAll(/^####\s+(MUS-SPEC-\S+?):/gm)].filter(m => !blocks.some(b => b[2] === m[1]));
    for (const m of stray) errors.push(`${rel}: ${m[1]} has no <a id="…"></a> anchor line directly above its heading`);

    const rows = new Map();
    for (const m of body.matchAll(/^\|\s*\[(MUS-SPEC-[^\]]+)\]\(([^)#]+)#([^)]+)\)\s*\|\s*([^|]*?)\s*\|\s*(.+?)\s*\|\s*$/gm)) rows.set(m[1], {file: m[2], anchor: m[3], what: m[4], test: m[5]});

    for (const [, anchor, id, , fieldText] of blocks) {
      const where = `${rel}: ${id}`;
      const parsed = CASE_ID.exec(id);
      if (!parsed) { errors.push(`${where}: case IDs look like MUS-SPEC-NN-<n><L>`); continue; }
      if (parsed[1] !== nn) errors.push(`${where}: clause number ${parsed[1]} does not match file ${nn}`);
      const want = id.toLowerCase().replace(/\./g, '-');
      if (anchor !== want) errors.push(`${where}: anchor must be "${want}"`);
      if (cases.has(id)) errors.push(`${where}: duplicate case ID (also in ${cases.get(id).file})`);
      clausesWithCases.add(nn);

      const lines = fieldText.split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '');
      const fields = new Map();
      for (const l of lines) {
        const m = /^- ([A-Za-z ]+):\s*(.*)$/.exec(l);
        if (!m) { errors.push(`${where}: unexpected text "${l.slice(0, 60)}"; a case holds exactly the seven fields`); continue; }
        if (!FIELDS.includes(m[1])) { errors.push(`${where}: unknown field "${m[1]}"`); continue; }
        if (fields.has(m[1])) errors.push(`${where}: field "${m[1]}" appears twice`);
        fields.set(m[1], m[2].trim());
      }
      FIELDS.forEach((f, idx) => {
        if (!fields.has(f)) errors.push(`${where}: missing field "${f}"`);
        else if (!fields.get(f)) errors.push(`${where}: field "${f}" is empty`);
        else if ([...fields.keys()].indexOf(f) !== idx && fields.size === FIELDS.length) errors.push(`${where}: fields must be in the order ${FIELDS.join(', ')}`);
      });

      let testRef = null;
      const testField = fields.get('Test') ?? '';
      const pending = /^not written yet \(#\d+\)$/.test(testField);
      const linked = /^`([^`:]+)::(.+)`$/.exec(testField);
      if (pending) {
        if (!/^UNVERIFIED/.test(fields.get('Evidence') ?? '')) errors.push(`${where}: a "not written yet" case must have Evidence UNVERIFIED`);
      } else if (!linked) {
        if (testField) errors.push(`${where}: Test must be \`path::exact test name\` or "not written yet (#N)"`);
      } else {
        const [, path, name] = linked;
        if (path.startsWith('/') || path.split('/').includes('..') || path.includes('*')) errors.push(`${where}: Test path must be relative from the repository root, with no "..", "*" or leading "/"`);
        else testRef = {path, name};
      }
      const evidence = fields.get('Evidence');
      if (evidence) { const e = parseEvidence(evidence); if (!e.ok) errors.push(`${where}: ${e.why}`); }
      if (/https?:\/\//.test(fieldText.replace(/Evidence: ci;\s*\S+/, ''))) errors.push(`${where}: a case holds no URL except a ci; Evidence run URL`);

      const row = rows.get(id);
      if (!row) errors.push(`${where}: missing its row in the clause's index table`);
      else {
        if (row.file !== file || row.anchor !== want) errors.push(`${where}: index row must link to ${file}#${want}`);
        if (pending && row.test !== testField) errors.push(`${where}: index row Test cell must read "${testField}"`);
        if (testRef) {
          const cell = /^\[`(.+)`\]\(([^)]+)\)$/.exec(row.test);
          const expectedLink = posix(relative(join(root, 'docs/spec/clauses'), join(root, testRef.path)));
          if (!cell || cell[1] !== testRef.name || cell[2] !== expectedLink) errors.push(`${where}: index row Test cell must be [\`${testRef.name}\`](${expectedLink})`);
        }
      }
      cases.set(id, {file: rel, anchor: want, test: testRef});
    }
    for (const id of rows.keys()) if (!cases.has(id) || cases.get(id).file !== rel) errors.push(`${rel}: index row ${id} has no case block`);
  }

  // Every linked test exists exactly once, plainly, and carries the case's Spec comment.
  const scans = new Map();
  const scanFile = path => {
    if (!scans.has(path)) {
      const full = join(root, path);
      const text = read(full);
      scans.set(path, testCalls(text, /\.tsx$/.test(path) && /from\s+['"]\.\/dom-check(?:\.ts)?['"]/.test(text)));
    }
    return scans.get(path);
  };
  for (const [id, c] of cases) {
    if (!c.test) continue;
    const where = `${c.file}: ${id}`;
    const full = join(root, c.test.path);
    if (!existsSync(full) || !statSync(full).isFile()) { errors.push(`${where}: test file ${c.test.path} does not exist`); continue; }
    const {calls, comments} = scanFile(c.test.path);
    const named = calls.filter(call => call.name === c.test.name);
    const plain = named.filter(call => !call.skipped);
    if (!named.length) { errors.push(`${where}: no test named "${c.test.name}" in ${c.test.path}`); continue; }
    if (named.length !== plain.length) { errors.push(`${where}: "${c.test.name}" is skipped, todo or only; a skipped test cannot prove a case`); continue; }
    if (plain.length > 1) { errors.push(`${where}: ${plain.length} tests are named "${c.test.name}"; names must be unique`); continue; }
    const want = `Spec: ${id} (${c.file}#${c.anchor})`;
    if (!specCommentsAbove(comments, plain[0].line).includes(want)) errors.push(`${where}: the test needs "// ${want}" directly above its call (${c.test.path}:${plain[0].line})`);
  }

  // Every Spec comment in the repo points at a case that names that test.
  for (const full of walk(join(root, 'packages'))) {
    const path = posix(relative(root, full));
    const text = read(full);
    if (!text.includes('Spec:')) continue;
    const {calls, comments} = scanFile(path);
    const attached = new Set();
    for (const call of calls) for (let l = call.line - 1; comments.has(l); l--) attached.add(l);
    for (const call of calls) for (const line of specCommentsAbove(comments, call.line)) {
      const m = /^Spec:\s*(MUS-SPEC-\S+)\s*\(([^)#\s]+)#([^)\s]+)\)$/.exec(line);
      if (!m) { errors.push(`${path}:${call.line}: malformed "// ${line}"; use "// Spec: <ID> (docs/spec/clauses/NN-area.md#<anchor>)"`); continue; }
      const [, id, specFile, anchor] = m;
      const c = cases.get(id);
      if (!c) { errors.push(`${path}:${call.line}: Spec comment names ${id}, which is not a case`); continue; }
      if (specFile !== c.file || anchor !== c.anchor) errors.push(`${path}:${call.line}: Spec comment for ${id} must point at ${c.file}#${c.anchor}`);
      if (!c.test || c.test.path !== path || c.test.name !== call.name) errors.push(`${path}:${call.line}: ${id} does not name this test; the case and the test must name each other`);
    }
    for (const [line, body] of comments) if (body.trim().startsWith('Spec:') && !attached.has(line)) errors.push(`${path}:${line}: a Spec comment must sit directly above a test(…), it(…) or check(…) call`);
  }

  // The traceability index lists exactly the clauses that have cases.
  const indexPath = join(specDir, 'test-traceability.md');
  const index = existsSync(indexPath) ? read(indexPath) : '';
  const indexed = new Set([...index.matchAll(/^\|\s*`MUS-SPEC-(\d{2})`\s*\|/gm)].map(m => m[1]));
  for (const nn of clausesWithCases) if (!indexed.has(nn)) errors.push(`docs/spec/test-traceability.md: MUS-SPEC-${nn} has cases but no row`);
  for (const nn of indexed) if (!clausesWithCases.has(nn)) errors.push(`docs/spec/test-traceability.md: MUS-SPEC-${nn} has a row but no cases`);

  return {errors, cases: cases.size};
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-spec.mjs')) {
  const {root} = args(process.argv);
  const {errors, cases} = check(root);
  if (errors.length) {
    for (const error of errors) process.stderr.write(`${error}\n`);
    process.stderr.write(`\ncheck-spec: ${errors.length} problem${errors.length === 1 ? '' : 's'} in ${cases} case${cases === 1 ? '' : 's'}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`check-spec: ${cases} case${cases === 1 ? '' : 's'} OK\n`);
  }
}
