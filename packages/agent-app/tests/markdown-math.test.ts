/* Portions adapted from T3 Code (https://github.com/pingdotgg/t3code, commit fa4f3a2), packages/shared/src/markdownMath.test.ts. Copyright (c) 2026 T3 Tools Inc., MIT License; see THIRD-PARTY-NOTICES.md and licenses/t3code-MIT.txt. */
// The maths parser replies use (src/shared/markdown-math.ts): which `$`, `\(` and `\[` open a formula, and which stay text.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Nodes} from 'mdast';
import {markdownMathRanges, mathKind, parseMarkdownWithMath} from '../src/shared/markdown-math.ts';

const parse = parseMarkdownWithMath;

function collect(node: Nodes, out: Nodes[] = []): Nodes[] {
  out.push(node);
  if ('children' in node) for (const child of node.children) collect(child, out);
  return out;
}

/** Formulas as `[kind, tex]`, in document order. */
function formulas(markdown: string): Array<[string | null, string]> {
  return collect(parse(markdown)).flatMap((node): Array<[string | null, string]> => {
    if (node.type === 'math') return [['display', node.value]];
    if (node.type !== 'inlineMath') return [];
    const className = (node.data as {hProperties?: {className?: unknown}} | undefined)?.hProperties?.className;
    return [[mathKind(Array.isArray(className) ? className.join(' ') : undefined), node.value]];
  });
}

function text(markdown: string): string {
  return collect(parse(markdown)).flatMap(node => (node.type === 'text' ? [node.value] : [])).join('');
}

/** Every key in `expected` matches `actual`, recursively (the rest of `actual` is ignored). */
function like(actual: unknown, expected: unknown, message?: string): void {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    assert.ok(actual && typeof actual === 'object', message ?? `expected an object, got ${JSON.stringify(actual)}`);
    for (const [key, value] of Object.entries(expected)) like((actual as Record<string, unknown>)[key], value, message ?? `at ${key}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), message ?? 'expected an array');
    assert.equal(actual.length, expected.length, message ?? 'array length');
    expected.forEach((value, index) => like(actual[index], value, message));
  } else assert.deepEqual(actual, expected, message ?? "unexpected value");
}

// Spec: MUS-SPEC-21-785B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-785b)
test('maths parsing: prices, shell variables, code, escapes and links stay text', () => {
  for (const prose of [
    'It costs $5 and $10.',
    'Budget $5-$10 per seat, or $20,000-$30,000 a year.',
    'Plans are $5/$10 monthly.',
    'Pay $5,$10 now.',
    'Run $browser then $deploy on it.',
    'Set $HOME before running.',
    'Set $HOME,$PATH before running.',
    'Set $HOME, $PATH before running.',
    'Set $HOME,$_PATH before running.',
    'Set $home,$path before running.',
    'Set $HOME,${PATH} before running.',
    'Set $HOME,$? before running.',
    'Set $HOME,$@ before running.',
    'Set $HOME,$(pwd) before running.',
    'Pay $1,000,$2,000 now.',
  ]) {
    assert.deepEqual(formulas(prose), [], prose);
    assert.equal(text(prose), prose, prose);
  }
  // A price before a real formula on the same line stays a price.
  for (const price of ['$5-$10', '$5 and $10', '$5/$10', '$20,000-$30,000']) {
    const source = `Price ${price} stays literal. The formula is $x_i$ and $5$.`;
    assert.deepEqual(formulas(source), [['inline', 'x_i'], ['inline', '5']], source);
    assert.equal(text(source), `Price ${price} stays literal. The formula is  and .`);
  }
  for (const [markdown, rendered] of [
    ['Use `$x$` in code.', 'Use  in code.'],
    ['It costs $5 and $10, and `$HOME` stays code.', 'It costs $5 and $10, and  stays code.'],
    ['Export $PATH, then `$HOME`.', 'Export $PATH, then .'],
    ['\\(a `\\)` b', '(a  b'],
    ['Set $TOKEN, then open [users](https://graph.microsoft.com/v1.0/users?$select=id).', 'Set $TOKEN, then open users.'],
    ['Set $TOKEN, then open <https://graph.microsoft.com/v1.0/users?$select=id>.', 'Set $TOKEN, then open https://graph.microsoft.com/v1.0/users?$select=id.'],
    ['```\n$x$ \\(y\\)\n```', ''],
    ['Escaped \\$x\\$ stays.', 'Escaped $x$ stays.'],
    ['Escaped \\\\(x\\\\) stays.', 'Escaped \\(x\\) stays.'],
    ['See [docs](https://example.com/\\(a\\)) here.', 'See docs here.'],
    ['As shown in \\[1\\] and \\[2, 3\\].', 'As shown in [1] and [2, 3].'],
  ] as const) {
    assert.deepEqual(formulas(markdown), [], markdown);
    assert.equal(text(markdown), rendered, markdown);
  }
  // Code spans next to a would-be formula keep their text.
  for (const [source, code] of [['$a`$HOME`', '$HOME'], ['\\(a`\\)`', '\\)'], ['\\(a\\alpha`\\)`', '\\)'], ['text \\[a`\\]`', '\\]']]) {
    assert.deepEqual(formulas(source!), [], source);
    like(collect(parse(source!)).find(node => node.type === 'inlineCode'), {value: code}, source);
  }
  // Indented code holds its formula as code.
  for (const formula of ['\\(x\\)', '$x$', '$$x$$']) {
    const source = `    ${formula}`;
    like(collect(parse(source)).find(node => node.type === 'code'), {value: formula});
    assert.deepEqual(markdownMathRanges(source), []);
  }
  // A GFM autolink keeps its `$` destination.
  const autolink = 'Query www.example.com/?$select=id and $x$.';
  like(collect(parse(autolink)).find(node => node.type === 'link'), {url: 'http://www.example.com/?$select=id'});
  assert.deepEqual(formulas(autolink), [['inline', 'x']]);
  // Private-use characters are not reserved by the parser.
  for (const reference of ['&#57344;', '&#xE000;', '&#xe000;']) {
    const source = `${reference} [${reference}](https://example.com/?q=${reference}) $x$`;
    const nodes = collect(parse(source));
    assert.equal(nodes.filter(node => node.type === 'text').map(node => (node as {value: string}).value).join(''), '\uE000 \uE000 ');
    like(nodes.find(node => node.type === 'link'), {url: 'https://example.com/?q=\uE000'});
    assert.deepEqual(formulas(source), [['inline', 'x']]);
  }
  const characters = Array.from({length: 6400}, (_, index) => String.fromCharCode(0xe000 + index)).join('');
  assert.deepEqual(formulas('$x$ ' + characters), [['inline', 'x']]);
  assert.equal(text('$x$ ' + characters), ' ' + characters);
});

// Spec: MUS-SPEC-21-785C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-785c)
test('maths parsing: the four delimiters, display blocks and source offsets', () => {
  assert.deepEqual(formulas('Inline $x^2$ and \\(y_1\\), display $$a+b$$ and \\[c\\].'), [['inline', 'x^2'], ['inline', 'y_1'], ['display', 'a+b'], ['display', 'c']]);
  assert.deepEqual(formulas('$$\n\\frac{a}{b}\n$$'), [['display', '\\frac{a}{b}']]);
  assert.deepEqual(formulas('Where\n\\[\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n\\]\nholds.'), [['display', '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}']]);
  for (const trailing of [' is the first formula.', ', followed by prose.', ' \tthen more text.']) {
    const source = `$$a$$${trailing}\nSome prose.\n$$\nb\n$$`;
    like(collect(parse(source)).filter(node => node.type === 'inlineMath' || node.type === 'math'), [{type: 'inlineMath', value: 'a'}, {type: 'math', value: 'b'}]);
    assert.ok(text(source).includes(`${trailing}\nSome prose.`));
    assert.deepEqual(markdownMathRanges(source).map(formula => formula.source), ['$$a$$', '$$\nb\n$$']);
  }
  // Block syntax inside a display block is TeX, not Markdown.
  assert.deepEqual(formulas('\\[\nx\n- y\n# z\n\\]\nafter'), [['display', 'x\n- y\n# z']]);
  assert.deepEqual(formulas('> $$\n> x\n> $$'), [['display', 'x']]);
  assert.deepEqual(formulas('$$x^2\n+y^2$$'), [['display', 'x^2\n+y^2']]);
  assert.equal(text('$$E=mc^2'), '$$E=mc^2');
  // Formulas that end in a comma.
  for (const boundary of ['', ' ', '\n', '.', ',', ';', ':', ')', ']', '}']) assert.deepEqual(formulas(`$x,$${boundary}`), [['inline', 'x,']], JSON.stringify(boundary));
  assert.deepEqual(formulas('Where $x = 1,$ with $$a,$$ and $$ b,$$.'), [['inline', 'x = 1,'], ['display', 'a,'], ['display', ' b,']]);
  assert.deepEqual(formulas('Pay \\$$x$ now.'), [['inline', 'x']]);
  // Backslashes before a display fence.
  for (const count of [1, 2]) {
    const prefix = 'a+' + '\\'.repeat(count);
    for (const opening of ['$$', '$$\n']) {
      const source = `${opening}${prefix}$$\nb\n$$`;
      assert.deepEqual(formulas(source), [['display', count % 2 === 1 ? `${prefix}$$\nb` : prefix]]);
      assert.equal(markdownMathRanges(source)[0]?.source, count % 2 === 1 ? source : `${opening}${prefix}$$`);
    }
  }
  assert.deepEqual(formulas('Cost $a\\$b$ and \\(\\left(x\\right)\\).'), [['inline', 'a\\$b'], ['inline', '\\left(x\\right)']]);
  // Source offsets of the original message.
  const markdown = '- [ ] check \\(x\\)\n- [x] then $y$';
  assert.deepEqual(collect(parse(markdown)).flatMap(node => node.type === 'inlineMath' || node.type === 'listItem' ? [[node.type, node.position?.start.offset]] : []),
    [['listItem', 0], ['inlineMath', markdown.indexOf('\\(')], ['listItem', markdown.indexOf('- [x]')], ['inlineMath', markdown.indexOf('$y$')]]);
  for (const eol of ['\n', '\r\n', '\r']) {
    const source = `😀 \\(x${eol}+y\\)${eol}${eol}- [ ] check $z$`;
    const nodes = collect(parse(source));
    const formula = nodes.find(node => node.type === 'inlineMath' && node.value === 'x' + eol + '+y');
    assert.deepEqual(formula?.position?.start, {line: 1, column: 4, offset: 3}, JSON.stringify(eol));
    assert.deepEqual(formula?.position?.end, {line: 2, column: 5, offset: source.indexOf(eol + eol)}, JSON.stringify(eol));
    assert.deepEqual(nodes.find(node => node.type === 'listItem')?.position?.start, {line: 4, column: 1, offset: source.indexOf('- [ ]')});
  }
});

// Spec: MUS-SPEC-21-785D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-785d)
test('maths parsing: an unfinished formula stays text at every point of a streaming reply', () => {
  const message = 'Energy \\(E = mc^2\\) and $$\\sum_i x_i$$ done.';
  for (let end = 0; end <= message.length; end++) assert.doesNotThrow(() => parse(message.slice(0, end)));
  assert.equal(text('Energy \\(E = mc'), 'Energy (E = mc');
  assert.deepEqual(formulas('$$\nx^2'), []);
  assert.deepEqual(formulas('\\[\nx^2\n- y'), []);
  assert.deepEqual(formulas(message), [['inline', 'E = mc^2'], ['display', '\\sum_i x_i']]);
  // A ```math fence counts once it is closed.
  assert.deepEqual(markdownMathRanges('```math\nx^2'), []);
  assert.equal(markdownMathRanges('```math\nx^2\n```')[0]?.tex, 'x^2');
  assert.equal(markdownMathRanges('> ```math\n> x^2\n> ```')[0]?.tex, 'x^2');
});

// Spec: MUS-SPEC-21-785E (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-785e)
test('maths parsing: TeX pipes stay in their table cell and a display = line is not a heading', () => {
  const tableOf = (source: string) => {
    const tree = parse(source), table = tree.children[0];
    assert.equal(table?.type, 'table', source);
    if (table?.type !== 'table') throw new Error('Missing table');
    return {tree, table};
  };
  // Maths in a link label; dollars in the destination stay.
  const row = '| [norm $|x|$](https://example.com/$path) | y$ |';
  for (const source of [`${row}\n| --- | --- |`, `| First | Second |\n| --- | --- |\n${row}`]) {
    const {tree, table} = tableOf(source);
    assert.ok(table.children.every(entry => entry.children.length === 2));
    assert.deepEqual(markdownMathRanges(source, tree).map(range => range.tex), ['|x|']);
    like(collect(tree).find(node => node.type === 'link'), {url: 'https://example.com/$path'});
  }
  for (const literal of ['[a](https://example.com/$x)', '`$x`', '<span title="$x">a</span>']) {
    const literalRow = `| ${literal} | y$ |`;
    for (const source of [`${literalRow}\n| --- | --- |`, `| First | Second |\n| --- | --- |\n${literalRow}`]) {
      const {tree, table} = tableOf(source);
      assert.ok(table.children.every(entry => entry.children.length === 2), source);
      assert.deepEqual(markdownMathRanges(source, tree), []);
    }
  }
  const prosePipe = 'a | b: \\(x\n+y\\)';
  assert.deepEqual(formulas(prosePipe), [['inline', 'x\n+y']]);
  like(markdownMathRanges(prosePipe), [{source: '\\(x\n+y\\)', inTable: false}]);
  for (const opener of ['\\(', '\\[']) {
    const closer = opener === '\\(' ? '\\)' : '\\]';
    const source = `| Name | Value |\n| --- | --- |\n| first | ${opener}x |\n| second | y${closer} |\n| valid | $|z|$ |`;
    const {tree, table} = tableOf(source);
    assert.deepEqual(table.children.map(entry => entry.children.length), [2, 2, 2, 2]);
    assert.deepEqual(collect(tree).filter(node => node.type === 'text').map(node => (node as {value: string}).value), ['Name', 'Value', 'first', opener.slice(1) + 'x', 'second', 'y' + closer.slice(1), 'valid']);
    like(markdownMathRanges(source), [{source: '$|z|$', tex: '|z|'}]);
    assert.doesNotMatch(JSON.stringify(tree), /[\uE000-\uF8FF]/);
  }
  for (const formula of ['\\(\\frac{1}{|x|}\\)', '$$|x|$$', '$|x|$']) {
    const source = `| Name | Value |\n| --- | --- |\n| x | ${formula} |\n\n- [ ] next`;
    const {tree, table} = tableOf(source);
    assert.deepEqual(table.children.map(entry => entry.children.length), [2, 2], formula);
    like(markdownMathRanges(source), [{source: formula, start: source.indexOf(formula)}]);
    assert.equal(collect(tree).find(node => node.type === 'listItem')?.position?.start.offset, source.indexOf('- [ ]'));
  }
  assert.deepEqual(markdownMathRanges('| Formula |\n| --- |\n| \\(\\|x\\|\\) |\n\n\\(\\|x\\|\\)').map(formula => formula.tex), ['\\|x\\|', '\\|x\\|']);
  const mixed = '| Value | Other |\n| --- | --- |\n| `\\(a\\|b\\)` | \\(x|y\\) |\n\n\uE000\n\n[link](https://example.com/$x|y$)\n\nUnclosed \\(x|y';
  const mixedTree = parse(mixed);
  assert.deepEqual(markdownMathRanges(mixed).map(formula => formula.tex), ['x|y']);
  assert.ok(JSON.stringify(mixedTree).includes('https://example.com/$x|y$'));
  like(collect(mixedTree).find(node => node.type === 'inlineCode'), {value: '\\(a|b\\)'});
  assert.ok(JSON.stringify(mixedTree).includes('\uE000'));
  // A display equation's lone `=` line is TeX, not a setext heading underline.
  like(parse('\\[\na\n=\nb\n\\]').children, [{type: 'math', value: 'a\n=\nb'}]);
});
