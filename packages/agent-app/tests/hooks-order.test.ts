/**
 * Hooks-order regression guard. A hook placed below an early `return` in a component (e.g. after
 * `if (loading) return <Spinner/>`) changes the hook count between renders; React then throws and the
 * window blanks. This static check parses every renderer .tsx file and flags any hook call
 * (useX(...), useX<T>(...), React.useX(...)) in a component or custom hook body that comes after a
 * top-level statement which can return. Hooks inside nested callbacks are not counted.
 */
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer');

function files(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : entry.name.endsWith('.tsx') ? [full] : [];
  });
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
const isNestedScope = (node: ts.Node): boolean => ts.isFunctionLike(node) || ts.isClassLike(node);

function hookName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'React' ? callee.name.text : null;
  return name && /^use[A-Z0-9]/.test(name) ? name : null;
}

/** Hook calls in `node`, not descending into nested functions or classes. */
function hooksIn(node: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (current: ts.Node): void => {
    if (current !== node && isNestedScope(current)) return;
    if (ts.isCallExpression(current) && hookName(current)) found.push(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** True when `node` holds a return statement of the enclosing function (not of a nested one). */
function canReturn(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found || (current !== node && isNestedScope(current))) return;
    if (ts.isReturnStatement(current)) { found = true; return; }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function functionName(fn: FunctionLike): string | null {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  // memo(function …) / forwardRef((props, ref) => …) / React.memo(…)
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    if (name === 'memo' || name === 'forwardRef') {
      const holder = parent.parent;
      return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text : 'AnonymousComponent';
    }
  }
  return null;
}

export interface HookOrderViolation { file: string; line: number; component: string; hook: string; }

export function findViolations(fileName: string, source: string): HookOrderViolation[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: HookOrderViolation[] = [];
  const check = (fn: FunctionLike): void => {
    const name = functionName(fn);
    if (!name || !/^(?:[A-Z]|use[A-Z0-9])/.test(name) || !fn.body || !ts.isBlock(fn.body)) return;
    let returned = false;
    for (const statement of fn.body.statements) {
      if (returned) {
        for (const call of hooksIn(statement)) {
          violations.push({file: path.relative(root, fileName) || fileName, line: sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1, component: name, hook: hookName(call)!});
        }
      }
      if (canReturn(statement)) returned = true;
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) check(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

test('the checker flags a hook after an early return, including generic and React.-qualified hooks', () => {
  const bad = `
    export function Panel({loading}: {loading: boolean}) {
      const [a] = useState(0);
      if (loading) return <p>Loading</p>;
      const b = useMemo<number>(() => a + 1, [a]);
      React.useEffect(() => {}, []);
      return <div>{b}</div>;
    }
    export const Card = ({x}: {x?: string}) => {
      if (!x) { return null; }
      const ref = useRef<HTMLDivElement>(null);
      return <div ref={ref}/>;
    };
    export const Memo = memo(function Inner() { if (Math.random()) return null; useLayoutEffect(() => {}); return null; });
    export function useThing(flag: boolean) { if (flag) return 1; return useContext(Ctx); }`;
  const found = findViolations('fixture.tsx', bad).map(v => `${v.component}:${v.hook}`);
  assert.deepEqual(found, ['Panel:useMemo', 'Panel:useEffect', 'Card:useRef', 'Inner:useLayoutEffect']);
});

test('the checker ignores hooks in nested callbacks, returns in nested functions and non-hook use() calls', () => {
  const good = `
    export function Row({items}: {items: string[]}) {
      const onPick = useCallback(() => { if (!items.length) return; }, [items]);
      const mapped = items.map(item => { if (!item) return null; return item; });
      const value = use(promise);
      useEffect(() => { return () => {}; }, []);
      if (!mapped.length) return null;
      return <ul>{mapped.map(item => <Item key={item} onClick={() => useless()}/>)}</ul>;
    }
    function helper() { if (x) return; useNotAComponentScope(); }`;
  assert.deepEqual(findViolations('fixture.tsx', good), []);
});

test('no renderer component calls a hook after an early return', () => {
  const violations = files(root).flatMap(file => findViolations(file, readFileSync(file, 'utf8')));
  assert.deepEqual(violations.map(v => `${v.file}:${v.line} ${v.component} calls ${v.hook} after an early return`), []);
});
