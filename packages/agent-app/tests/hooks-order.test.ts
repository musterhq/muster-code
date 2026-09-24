/**
 * Hooks-order regression guard. A hook placed below an early `return` in a component (e.g. after
 * `if (loading) return <Spinner/>`) changes the hook count between renders; React then throws and the
 * window blanks. This static check flags any hook call — useX(...), useX<T>(...), React.useX(...) — in a
 * component or custom hook body that comes after a completed `return` statement of that same function.
 * Hooks inside nested callbacks are not counted, and the value of the function's first return
 * (`return useContext(Ctx)`) is allowed.
 *
 * The repo's `typescript` package is the native (Go) compiler with no JS API, so each file is first lowered
 * with esbuild (types, generics and JSX removed; output is plain JS with explicit semicolons) and then read
 * by a small JS tokenizer.
 */
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {transformSync} from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer');

function files(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : entry.name.endsWith('.tsx') ? [full] : [];
  });
}

interface Token { type: 'ident' | 'punct' | 'string' | 'number' | 'regex'; value: string; }

const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const templates: number[] = []; // brace depth at which each open `${` resumes its template
  let depth = 0;
  let i = 0;
  const regexAllowed = (): boolean => {
    const previous = tokens[tokens.length - 1];
    if (!previous) return true;
    if (previous.type === 'ident') return REGEX_AFTER_KEYWORD.has(previous.value);
    if (previous.type === 'punct') return previous.value !== ')' && previous.value !== ']';
    return false;
  };
  const template = (): void => { // i is just past a backtick or the `}` closing a `${`
    while (i < src.length) {
      const c = src[i]!;
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; tokens.push({type: 'string', value: '`'}); return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; tokens.push({type: 'punct', value: '${'}); templates.push(depth); depth++; return; }
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      tokens.push({type: 'string', value: src.slice(i, j + 1)}); i = j + 1; continue;
    }
    if (c === '`') { i++; template(); continue; }
    if (/[A-Za-z_$#]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j]!)) j++;
      tokens.push({type: 'ident', value: src.slice(i, j)}); i = j; continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[\w.]/.test(src[j]!)) j++;
      tokens.push({type: 'number', value: src.slice(i, j)}); i = j; continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, inClass = false;
      while (j < src.length) {
        const d = src[j]!;
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true; else if (d === ']') inClass = false; else if (d === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/.test(src[j]!)) j++;
      tokens.push({type: 'regex', value: src.slice(i, j)}); i = j; continue;
    }
    if (c === '}' && templates.length && templates[templates.length - 1] === depth - 1) {
      templates.pop(); depth--; i++; tokens.push({type: 'punct', value: '}$'}); template(); continue;
    }
    const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
    const value = three === '...' ? three : two === '=>' || two === '?.' ? two : c;
    if (value === '{') depth++; else if (value === '}') depth--;
    tokens.push({type: 'punct', value}); i += value.length;
  }
  return tokens;
}

const OPEN: Record<string, string> = {'(': ')', '[': ']', '{': '}', '${': '}$'};

function partners(tokens: Token[]): Int32Array {
  const match = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'punct') return;
    if (OPEN[token.value]) { stack.push(index); return; }
    if (token.value === ')' || token.value === ']' || token.value === '}' || token.value === '}$') {
      const open = stack.pop();
      if (open !== undefined) { match[open] = index; match[index] = open; }
    }
  });
  return match;
}

interface Scope { start: number; bodyOpen: number; end: number; name: string | null; block: boolean; }

function scopes(tokens: Token[], match: Int32Array): Scope[] {
  const is = (index: number, value: string): boolean => tokens[index]?.value === value && tokens[index]?.type !== 'string';
  const nameBefore = (start: number): string | null => {
    // const Name = <fn> / const Name = memo(<fn>) / const Name = React.forwardRef(<fn>)
    let k = start - 1;
    if (is(k, 'async')) k--;
    if (is(k, '(')) {
      const callee = tokens[k - 1];
      if (callee?.type === 'ident' && (callee.value === 'memo' || callee.value === 'forwardRef')) {
        k -= 2;
        if (is(k, '.') && tokens[k - 1]?.value === 'React') k -= 2;
        return is(k, '=') && tokens[k - 1]?.type === 'ident' ? tokens[k - 1]!.value : 'AnonymousComponent';
      }
      return null;
    }
    return is(k, '=') && tokens[k - 1]?.type === 'ident' ? tokens[k - 1]!.value : null;
  };
  const found: Scope[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'punct') return;
    if (token.value === '=>') {
      const before = index - 1;
      const start = is(before, ')') ? match[before]! : before;
      if (is(index + 1, '{')) { found.push({start, bodyOpen: index + 1, end: match[index + 1]!, name: nameBefore(start), block: true}); return; }
      // Expression body: runs to the first `,` `;` or unmatched closer at its own depth.
      let k = index + 1;
      while (k < tokens.length) {
        const t = tokens[k]!;
        if (t.type === 'punct') {
          if (OPEN[t.value] && match[k]! > k) { k = match[k]! + 1; continue; }
          if (t.value === ',' || t.value === ';' || t.value === ')' || t.value === ']' || t.value === '}' || t.value === '}$') break;
        }
        k++;
      }
      found.push({start, bodyOpen: index + 1, end: k - 1, name: nameBefore(start), block: false});
      return;
    }
    if (token.value === '{' && is(index - 1, ')')) {
      const open = match[index - 1]!;
      const before = tokens[open - 1];
      if (!before) return;
      if (before.value === 'function') { found.push({start: open - 1, bodyOpen: index, end: match[index]!, name: nameBefore(open - 1), block: true}); return; }
      if (before.type === 'ident' && (tokens[open - 2]?.value === 'function' || tokens[open - 2]?.value === '*')) {
        found.push({start: open - 2, bodyOpen: index, end: match[index]!, name: before.value, block: true}); return;
      }
      if (before.type === 'ident' && !CONTROL.has(before.value)) found.push({start: open - 1, bodyOpen: index, end: match[index]!, name: null, block: true}); // method
    }
  });
  return found;
}

const isHook = (tokens: Token[], index: number): boolean => {
  const token = tokens[index]!;
  if (token.type !== 'ident' || !/^use[A-Z0-9]/.test(token.value) || tokens[index + 1]?.value !== '(') return false;
  const previous = tokens[index - 1];
  return previous?.value !== '.' || tokens[index - 2]?.value === 'React';
};

export interface HookOrderViolation { file: string; component: string; hook: string; }

export function findViolations(fileName: string, source: string): HookOrderViolation[] {
  const code = transformSync(source, {loader: fileName.endsWith('.tsx') ? 'tsx' : 'ts', jsx: 'transform', sourcefile: fileName}).code;
  const tokens = tokenize(code);
  const match = partners(tokens);
  const all = scopes(tokens, match);
  const skipFrom = new Map<number, number>();
  for (const scope of all) skipFrom.set(scope.start, Math.max(skipFrom.get(scope.start) ?? -1, scope.end));
  const violations: HookOrderViolation[] = [];
  for (const fn of all) {
    if (!fn.block || !fn.name || !/^(?:[A-Z]|use[A-Z0-9])/.test(fn.name)) continue;
    let depth = 0, returned = false, returnDepth = -1;
    for (let i = fn.bodyOpen + 1; i < fn.end; i++) {
      const skip = skipFrom.get(i);
      if (skip !== undefined && skip > i) { i = skip; continue; }
      const token = tokens[i]!;
      if (token.type === 'punct') {
        if (OPEN[token.value]) depth++;
        else if (token.value === ')' || token.value === ']' || token.value === '}' || token.value === '}$') {
          depth--;
          if (returnDepth >= 0 && depth < returnDepth) { returned = true; returnDepth = -1; }
        } else if (token.value === ';' && returnDepth >= 0 && depth === returnDepth) { returned = true; returnDepth = -1; }
        continue;
      }
      if (token.type === 'ident' && token.value === 'return' && tokens[i - 1]?.value !== '.' && returnDepth < 0) { returnDepth = depth; continue; }
      if (returned && isHook(tokens, i)) violations.push({file: path.relative(root, fileName) || fileName, component: fn.name, hook: token.value});
    }
  }
  return violations;
}

test('the checker flags a hook after an early return, including generic and React.-qualified hooks', () => {
  const bad = `
    export function Panel({loading}: {loading: boolean}) {
      const [a] = useState(0);
      if (loading) return <p className={\`x \${a > 1 ? 'y' : 'z'}\`}>Loading</p>;
      const b = useMemo<number>(() => a / 2, [a]);
      React.useEffect(() => {}, []);
      return <div>{b}</div>;
    }
    export const Card = ({x}: {x?: string}) => {
      if (!x) { return null; }
      const ref = useRef<HTMLDivElement>(null);
      return <div ref={ref}/>;
    };
    export const Memo = memo(function Inner() { if (/^a/.test(String(Math.random()))) return null; useLayoutEffect(() => {}); return null; });
    export function useThing(flag: boolean) { if (flag) return 1; return useContext(Ctx); }`;
  const found = findViolations('fixture.tsx', bad).map(v => `${v.component}:${v.hook}`);
  assert.deepEqual(found, ['Panel:useMemo', 'Panel:useEffect', 'Card:useRef', 'Inner:useLayoutEffect', 'useThing:useContext']);
});

test('the checker ignores hooks in nested callbacks, returns in nested functions, a first return value and use()', () => {
  const good = `
    export function Row({items}: {items: string[]}) {
      const onPick = useCallback(() => { if (!items.length) return; }, [items]);
      const mapped = items.map(item => { if (!item) return null; return item; });
      const first = items.find(item => item.length > 1);
      const value = use(promise);
      useEffect(() => { return () => {}; }, []);
      if (!mapped.length) return null;
      return <ul>{mapped.map(item => <Item key={item} onClick={() => useless()}/>)}</ul>;
    }
    export function useSelected() { return useContext(Ctx); }
    function helper() { if (x) return; useNotAComponentScope(); }
    const obj = { method() { if (a) return; useInsideMethod(); } };`;
  assert.deepEqual(findViolations('fixture.tsx', good), []);
});

test('no renderer component calls a hook after an early return', () => {
  const violations = files(root).flatMap(file => findViolations(file, readFileSync(file, 'utf8')));
  assert.deepEqual(violations.map(v => `${v.file}: ${v.component} calls ${v.hook} after an early return`), []);
});
