import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { createMarkdownRenderer, MARKDOWN_RENDER_SCRIPT } from "../src/markdown-render.js";

const r = createMarkdownRenderer({ cod: (name) => `<i class="cod">${name}</i>` });

function el(raw = "") {
  const { document } = parseHTML("<html><body></body></html>").window;
  const node = document.createElement("div");
  node.className = "assistant";
  node.dataset.raw = raw;
  return node;
}

test("headings through h6, strike, emphasis, hr, blockquote", () => {
  const html = r.renderMarkdown("#### Four\n##### Five\n###### Six\n\n~~gone~~ and **b** and *i*\n\n---\n\n> quoted");
  assert.match(html, /<h4>Four<\/h4>/);
  assert.match(html, /<h5>Five<\/h5>/);
  assert.match(html, /<h6>Six<\/h6>/);
  assert.match(html, /<s>gone<\/s>/);
  assert.match(html, /<b>b<\/b>/);
  assert.match(html, /<i>i<\/i>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<blockquote>quoted<\/blockquote>/);
});

test("tilde fences and unclosed backtick fences render as code blocks", () => {
  const closed = r.renderMarkdown("~~~\nfoo\n~~~");
  assert.match(closed, /<div class="code" data-lang=""/);
  assert.match(closed, /<pre>foo<\/pre>/);
  const open = r.renderMarkdown("```js src/app.ts\nconst x = 1");
  assert.match(open, /class="code"/);
  assert.match(open, /data-path="src\/app.ts"/);
  assert.match(open, /data-lang="js"/);
  assert.match(open, /data-apply/);
  assert.match(open, /<pre>const x = 1<\/pre>/);
  const insert = r.renderMarkdown("```\nplain");
  assert.match(insert, /data-insert/);
  assert.match(insert, />code</);
});

test("nested lists, ordered start-at-N, and task items", () => {
  const html = r.renderMarkdown("- a\n  - b\n  - c\n- d\n\n3. third\n4. fourth\n\n- [ ] todo\n- [x] done");
  assert.match(html, /<ul><li>a<ul><li>b<\/li><li>c<\/li><\/ul><\/li><li>d<\/li><\/ul>/);
  assert.match(html, /<ol start="3"><li>third<\/li><li>fourth<\/li><\/ol>/);
  assert.match(html, /li class="task"/);
  assert.match(html, /cod">circle-large/);
  assert.match(html, /li class="task done"/);
  assert.match(html, /cod">pass-filled/);
});

test("tables render from the first pipe line and drop alignment rows", () => {
  const one = r.renderMarkdown("| A | B |");
  assert.equal(one, "<table><tr><th>A</th><th>B</th></tr></table>");
  const full = r.renderMarkdown("| A | B |\n| --- | ---: |\n| 1 | 2 |");
  assert.equal(full, "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>");
});

test("images, autolinks, bare URLs, markdown links, and escapes", () => {
  const img = r.renderMarkdown("![alt](https://ex.com/a.png)\n\n![disk](/tmp/x.png)\n\n![rel](docs/p.png)");
  assert.match(img, /<img class="md-img" alt="alt" data-src="https:\/\/ex.com\/a.png" src="https:\/\/ex.com\/a.png">/);
  assert.match(img, /<img class="md-img" alt="disk" data-src="\/tmp\/x.png" data-path="\/tmp\/x.png">/);
  assert.match(img, /data-path="docs\/p.png"/);
  const links = r.renderMarkdown("see <https://ex.com/a> and https://ex.com/b plus [t](https://ex.com/c)");
  assert.match(links, /<a href="https:\/\/ex.com\/a">https:\/\/ex.com\/a<\/a>/);
  assert.match(links, /<a href="https:\/\/ex.com\/b">https:\/\/ex.com\/b<\/a>/);
  assert.match(links, /<a href="https:\/\/ex.com\/c">t<\/a>/);
  const esc = r.renderMarkdown("not \\*em\\* here");
  assert.match(esc, /not \*em\* here/);
  assert.doesNotMatch(esc, /<i>/);
});

test("hard breaks and inline code inside links are not double-processed", () => {
  const br = r.renderMarkdown("one  \ntwo");
  assert.equal(br, "<p>one<br>two</p>");
  const linked = r.renderMarkdown("[`src/a.ts`](https://ex.com)");
  assert.equal((linked.match(/<code>/g) || []).length, 1);
  assert.match(linked, /<a href="https:\/\/ex.com">/);
  assert.match(linked, /<a class="file" data-path="src\/a.ts"/);
});

test("file links and Codex citations keep data-path and data-line", () => {
  const html = r.renderMarkdown("see `src/a.ts:12-20` and src/b.ts:4 and \u3010F:src/c.ts\u2020L12-L20\u3011");
  assert.match(html, /<a class="file" data-path="src\/a.ts" data-line="12" data-end="20"/);
  assert.match(html, /<a class="file" data-path="src\/b.ts" data-line="4"/);
  assert.match(html, /<a class="file" data-path="src\/c.ts" data-line="12" data-end="20"/);
  assert.match(html, /class="cite"/);
});

test("</script> in markdown is escaped", () => {
  const html = r.renderMarkdown('alert </script><script>x</script> `</script>`');
  assert.doesNotMatch(html, /<\/script>/i);
  assert.match(html, /&lt;\/script&gt;/);
});

test("streaming chunks keep open fences as code and match the final renderer", () => {
  const prefix = "# Title\n\nClosed paragraph.\n\n```js\nconst a = 1;\n```\n\n";
  const tail = "trailing prose";
  const full = prefix + tail;
  const node = el();
  node.classList.add("streaming");
  let acc = "";
  let sawOpenFence = false;
  const fenceDoc = "```ts\nconst x = 1";
  for (const ch of fenceDoc) {
    acc += ch;
    node.dataset.raw = acc;
    r.renderMarkdownIncremental(node);
    if (acc.endsWith("```ts\n") || acc.startsWith("```ts\n")) {
      assert.ok(node.querySelector(".code"), "unclosed fence must be a .code block once the opening line ends");
      sawOpenFence = true;
    }
  }
  assert.equal(sawOpenFence, true);
  acc = "";
  for (let i = 0; i < full.length; i += 2) {
    acc = full.slice(0, Math.min(full.length, i + 2));
    node.dataset.raw = acc;
    r.renderMarkdownIncremental(node);
  }
  node.classList.remove("streaming");
  r.renderMarkdownIncremental(node);
  const gold = el();
  gold.innerHTML = r.renderMarkdown(full);
  assert.equal(node.innerHTML, gold.innerHTML);
  assert.ok(r.stats.lastParsedChars < 40, `tail reparse should be small, got ${r.stats.lastParsedChars}`);
  assert.ok(r.stats.lastParsedChars < full.length / 2);
});

test("cache invalidates when the prefix no longer matches", () => {
  const node = el();
  const first = "Hello cache.\n\n```\nblock\n```\n\nmore";
  node.dataset.raw = first;
  r.renderMarkdownIncremental(node);
  const next = "Replaced entirely";
  node.dataset.raw = next;
  r.renderMarkdownIncremental(node);
  assert.equal(node.innerHTML, r.renderMarkdown(next));
  assert.equal(r.stats.lastParsedChars, next.length);
});

test("MARKDOWN_RENDER_SCRIPT is browser JS without interpolation holes", () => {
  assert.match(MARKDOWN_RENDER_SCRIPT, /function renderMarkdown\(/);
  assert.match(MARKDOWN_RENDER_SCRIPT, /function renderMarkdownIncremental\(/);
  assert.doesNotMatch(MARKDOWN_RENDER_SCRIPT, /\$\{/);
});
