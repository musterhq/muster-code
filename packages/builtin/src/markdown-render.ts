/** Browser JS for the agent transcript (injected into paneHtml) plus a Node-testable factory. */

export type MarkdownRenderer = {
  escape: (s: string) => string;
  inline: (t: string) => string;
  fileLink: (path: string, line: string, endLine: string, label: string) => string;
  PATH_RE: RegExp;
  renderMarkdown: (text: string) => string;
  renderMarkdownIncremental: (el: { dataset: { raw?: string }; innerHTML: string; classList: { contains: (c: string) => boolean } }) => void;
  stats: { lastParsedChars: number };
};

export const MARKDOWN_RENDER_SCRIPT: string = String.raw`
  var PATH_RE = /^((?:[\w.@-]+\/)*[\w.@-]+\.[a-zA-Z0-9]{1,8})(?::(\d+)(?:-(\d+))?)?$/;
  var stats = { lastParsedChars: 0 };
  var mdStableCache = typeof WeakMap !== "undefined" ? new WeakMap() : null;
  var mdPendingImages = typeof Set !== "undefined" ? new Set() : null;
  var mdImgBound = false;
  function imageKey(src) {
    var s = String(src || "").trim();
    try { s = decodeURIComponent(s); } catch (e) {}
    s = s.replace(/^image:/, "");
    if (s.toLowerCase().indexOf("file://") === 0) s = s.slice(7);
    return s.replace(/^["']|["']$/g, "");
  }
  function escape(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function fileLink(path, line, endLine, label) { return '<a class="file" data-path="' + escape(path) + '"' + (line ? ' data-line="' + line + '"' : "") + (endLine ? ' data-end="' + endLine + '"' : "") + ' title="' + escape(path) + (line ? ":" + line : "") + '">' + label + "</a>"; }
  function mdBindImages() {
    if (mdImgBound || typeof window === "undefined" || typeof document === "undefined") return;
    mdImgBound = true;
    window.addEventListener("message", function (event) {
      var m = event.data;
      if (!m || m.type !== "imageResolved") return;
      var key = imageKey(m.src);
      if (mdPendingImages) { mdPendingImages.delete(m.src); mdPendingImages.delete(key); }
      var imgs = document.querySelectorAll("img.md-img, img.ctx-thumb, img.human-thumb");
      for (var i = 0; i < imgs.length; i++) {
        if (imageKey(imgs[i].getAttribute("data-src") || "") === key) { imgs[i].src = m.uri; imgs[i].removeAttribute("data-pending"); }
      }
    });
    document.addEventListener("click", function (e) {
      var t = e.target;
      var img = t && t.closest ? t.closest("img.md-img") : null;
      if (!img) return;
      var path = img.getAttribute("data-path");
      if (!path || /^(https?:|data:)/i.test(path)) return;
      e.preventDefault();
      if (typeof vscode !== "undefined") vscode.postMessage({ type: "openPath", path: path });
    });
  }
  function mdQueueImage(src) {
    if (mdPendingImages) {
      if (mdPendingImages.has(src)) return;
      mdPendingImages.add(src);
    }
    if (typeof vscode !== "undefined") vscode.postMessage({ type: "resolveImage", src: src });
  }
  function mdImage(alt, src) {
    var a = escape(alt), d = escape(src);
    if (/^(https?:|data:)/i.test(src)) return '<img class="md-img" alt="' + a + '" data-src="' + d + '" src="' + d + '">';
    mdQueueImage(src);
    return '<img class="md-img" alt="' + a + '" data-src="' + d + '" data-path="' + d + '">';
  }
  function codeSpan(c) {
    var f = PATH_RE.exec(c);
    return f && (c.includes("/") || f[2] || /\.[a-z]{1,5}$/.test(c)) ? fileLink(f[1], f[2], f[3], "<code>" + escape(c) + "</code>") : "<code>" + escape(c) + "</code>";
  }
  function inlineLimited(t) {
    var slots = [];
    function keep(html) { slots.push(html); return "\0" + (slots.length - 1) + "\0"; }
    var s = String(t);
    s = s.replace(/\\([\\\x60*_[\]()#!+.!~<>-])/g, function (_, c) { return keep(escape(c)); });
    s = s.replace(/\x60([^\x60\n]+)\x60/g, function (m, c) { return keep(codeSpan(c)); });
    s = escape(s);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
    s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
    s = s.replace(/\0(\d+)\0/g, function (_, i) { return slots[Number(i)]; });
    return s;
  }
  function inline(t) {
    var slots = [];
    function keep(html) { slots.push(html); return "\0" + (slots.length - 1) + "\0"; }
    var s = String(t);
    s = s.replace(/\\([\\\x60*_[\]()#!+.!~<>-])/g, function (_, c) { return keep(escape(c)); });
    s = s.replace(/\u3010F:([^\u2020\u3011]+)\u2020L(\d+)(?:-L(\d+))?\u3011/g, function (m, p, l1, l2) { return keep(fileLink(p, l1, l2, '<span class="cite">' + cod("file") + escape(p.split("/").pop()) + ":" + l1 + (l2 ? "-" + l2 : "") + "</span>")); });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, src) { return keep(mdImage(alt, src)); });
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, function (_, text, href) { return keep('<a href="' + escape(href) + '">' + inlineLimited(text) + "</a>"); });
    s = s.replace(/\x60([^\x60\n]+)\x60/g, function (m, c) { return keep(codeSpan(c)); });
    s = s.replace(/<(https?:\/\/[^>\s]+)>/g, function (_, u) { return keep('<a href="' + escape(u) + '">' + escape(u) + "</a>"); });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)(?=$|[\s,.;)])/g, function (m, pre, u) { return pre + keep('<a href="' + escape(u) + '">' + escape(u) + "</a>"); });
    s = escape(s);
    s = s.replace(/(^|[\s(])((?:[\w.@-]+\/)+[\w.@-]+\.[a-zA-Z0-9]{1,8}(?::\d+(?:-\d+)?)?)(?=$|[\s,.;:)])/g, function (m, pre, ref) { var f = PATH_RE.exec(ref); return f ? pre + fileLink(f[1], f[2], f[3], ref) : m; });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
    s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
    s = s.replace(/\0(\d+)\0/g, function (_, i) { return slots[Number(i)]; });
    return s;
  }
  function fenceOpen(l) { return /^(\x60{3,}|~{3,})\s*([\w+#.-]*)(?:[:\s]+([^\s\x60~]+))?\s*$/.exec(l); }
  function fenceClose(l, mark) { return new RegExp("^" + mark[0] + "{" + mark.length + ",}\\s*$").test(l); }
  function isHeading(l) { return /^(#{1,6})\s+(.*)$/.exec(l); }
  function isHr(l) { return /^\s*(-{3,}|\*{3,})\s*$/.test(l); }
  function isQuote(l) { return /^\s*>/.test(l); }
  function isTable(l) { return /^\s*\|/.test(l); }
  function listItem(l) { return /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(l); }
  function isSpecial(l) { return !!(fenceOpen(l) || isHeading(l) || isHr(l) || isQuote(l) || isTable(l) || listItem(l)); }
  function codeBlockHtml(lang, path, code) {
    return '<div class="code"' + (path ? ' data-path="' + escape(path) + '"' : "") + ' data-lang="' + escape(lang) + '"><div class="head">' + (path ? fileLink(path, "", "", '<span class="path">' + escape(path) + "</span>") : "<span>" + escape(lang || "code") + "</span>") + '<span class="spacer"></span><button class="copy" data-copy>Copy</button>' + (path ? '<button class="apply" data-apply>Apply</button>' : '<button class="apply" data-insert>Insert</button>') + "</div><pre>" + escape(code.join("\n")) + "</pre></div>";
  }
  function liHtml(text, children) {
    var task = /^\[( |x|X)\]\s*/.exec(text);
    var body = task ? text.slice(task[0].length) : text;
    return "<li" + (task ? ' class="task' + (task[1] !== " " ? " done" : "") + '"' : "") + ">" + (task ? cod(task[1] !== " " ? "pass-filled" : "circle-large") : "") + inline(body) + (children || "") + "</li>";
  }
  function parseList(lines, i) {
    var first = listItem(lines[i]);
    if (!first) return null;
    function level(minIndent) {
      var items = [];
      var ordered = null;
      var startN = 1;
      while (i < lines.length) {
        var m = listItem(lines[i]);
        if (!m) break;
        var indent = m[1].length;
        if (indent < minIndent) break;
        if (indent >= minIndent + 2 && items.length) {
          var child = level(indent);
          items[items.length - 1].children += child.html;
          continue;
        }
        if (indent !== minIndent) break;
        var isOl = /^\d+\.$/.test(m[2]);
        if (ordered === null) { ordered = isOl; if (isOl) startN = parseInt(m[2], 10); }
        if (isOl !== ordered) break;
        items.push({ text: m[3], children: "" });
        i++;
      }
      var tag = ordered ? "ol" : "ul";
      var startAttr = ordered && startN !== 1 ? ' start="' + startN + '"' : "";
      var html = "<" + tag + startAttr + ">" + items.map(function (it) { return liHtml(it.text, it.children); }).join("") + "</" + tag + ">";
      return { html: html };
    }
    var out = level(first[1].length);
    return { html: out.html, i: i, closed: true };
  }
  function nextBlock(lines, i) {
    var l = lines[i];
    var fence = fenceOpen(l);
    if (fence) {
      var mark = fence[1], lang = fence[2], path = fence[3] && /[\w.-]+\.[a-zA-Z0-9]{1,8}$/.test(fence[3]) ? fence[3] : "";
      var code = [];
      i++;
      var closed = false;
      while (i < lines.length) {
        if (fenceClose(lines[i], mark)) { closed = true; i++; break; }
        code.push(lines[i++]);
      }
      return { html: codeBlockHtml(lang, path, code), i: i, closed: closed };
    }
    var h = isHeading(l);
    if (h) return { html: "<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">", i: i + 1, closed: true };
    if (listItem(l)) return parseList(lines, i);
    if (isQuote(l)) {
      var q = [];
      while (i < lines.length && isQuote(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      return { html: "<blockquote>" + inline(q.join(" ")) + "</blockquote>", i: i, closed: true };
    }
    if (isTable(l)) {
      var rows = [];
      while (i < lines.length && isTable(lines[i])) rows.push(lines[i++]);
      var cells = function (r) { return r.trim().replace(/^\||\|$/g, "").split("|").map(function (c) { return c.trim(); }); };
      var head = cells(rows[0]);
      var bodyRows = rows.slice(1).filter(function (r) { return !/^\s*\|?\s*:?-+/.test(r); });
      var html = "<table><tr>" + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr>" + bodyRows.map(function (r) { return "<tr>" + cells(r).map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</table>";
      return { html: html, i: i, closed: true };
    }
    if (isHr(l)) return { html: "<hr>", i: i + 1, closed: true };
    var para = [];
    while (i < lines.length && lines[i].trim() && !isSpecial(lines[i])) { para.push(lines[i]); i++; }
    var out = "";
    for (var j = 0; j < para.length; j++) {
      var line = para[j];
      var hard = /  $/.test(line);
      out += inline(hard ? line.slice(0, -2) : line);
      if (j < para.length - 1) out += hard ? "<br>" : " ";
    }
    return { html: para.length ? "<p>" + out + "</p>" : "", i: i, closed: true };
  }
  function renderMarkdown(text) {
    var lines = String(text).split("\n");
    var html = "", i = 0;
    while (i < lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      var b = nextBlock(lines, i);
      html += b.html;
      i = b.i;
    }
    return html;
  }
  function lastStableOffset(text) {
    var lines = text.split("\n");
    var starts = [];
    var pos = 0;
    for (var k = 0; k < lines.length; k++) {
      starts.push(pos);
      pos += lines[k].length + (k < lines.length - 1 ? 1 : 0);
    }
    var i = 0, last = 0;
    while (i < lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      var b = nextBlock(lines, i);
      var j = b.i;
      if (b.closed && j < lines.length && !lines[j].trim()) {
        var afterBlank = j + 1 < lines.length ? starts[j + 1] : text.length;
        last = afterBlank;
      }
      i = j;
    }
    return last;
  }
  function renderMarkdownIncremental(el) {
    mdBindImages();
    var raw = (el.dataset && el.dataset.raw) || "";
    var cache = mdStableCache ? mdStableCache.get(el) : null;
    if (cache && raw.indexOf(cache.prefix) !== 0) cache = null;
    var offset = cache ? cache.offset : 0;
    var head = cache ? cache.html : "";
    var tail = raw.slice(offset);
    stats.lastParsedChars = tail.length;
    var html = head + renderMarkdown(tail);
    var stable = lastStableOffset(raw);
    if (mdStableCache && stable > offset) {
      mdStableCache.set(el, { prefix: raw.slice(0, stable), html: head + renderMarkdown(raw.slice(offset, stable)), offset: stable });
    }
    if (el.classList && el.classList.contains("streaming") && /<div class="code"[\s\S]*<\/div>\s*$/.test(html)) html += "<p></p>";
    var host = el.querySelector && el.querySelector(".assistant-body");
    (host || el).innerHTML = html;
  }
`;

export function createMarkdownRenderer(deps: { cod: (name: string) => string }): MarkdownRenderer {
  const factory = new Function(
    "cod",
    MARKDOWN_RENDER_SCRIPT + "\nreturn { escape, inline, fileLink, PATH_RE, renderMarkdown, renderMarkdownIncremental, stats };",
  ) as (cod: (name: string) => string) => MarkdownRenderer;
  return factory(deps.cod);
}
