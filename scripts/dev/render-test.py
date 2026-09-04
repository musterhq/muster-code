# Unit-test the pane's markdown renderer outside the webview: extract the pure functions from the generated script and run samples in node.
import subprocess, tempfile, sys, re, os
src = os.path.join(os.path.dirname(__file__), "..", "..", "packages", "builtin", "src", "agent-pane.ts")
s = open(src).read(); i = s.index('function paneHtml(csp: string, codicon = ""): string {'); fn = s[i:].replace('function paneHtml(csp: string, codicon = ""): string {', 'function paneHtml(csp, codicon = "") {', 1)
node = fn + '\nconst html = paneHtml("x"); const sc=[...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)].map(m=>m[1]); require("fs").writeFileSync(process.argv[2], sc[sc.length-1]);'
t = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False); t.write(node); t.close(); m = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False).name
subprocess.run(["node", t.name, m], check=True)
js = open(m).read()
def piece(name):
    i = js.find("function " + name + "(")
    if i >= 0:
        depth = 0; j = i
        while True:
            c = js[j]
            if c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0: return js[i:j + 1]
            j += 1
    mm = re.search(r"const " + re.escape(name) + r" = [^\n]*;", js)
    if not mm: raise SystemExit(f"cannot extract {name}")
    return mm.group(0)
pieces = [piece(n) for n in ["COD", "cod", "PATH_RE", "escape", "fileLink", "inline", "renderMarkdown"]]
test = "\n".join(pieces) + r'''
const out = renderMarkdown("See `src/agent-pane.ts:12` and packages/builtin/src/codex.ts:5-9 here 【F:docs/HANDOFF.md†L3-L4】.\n\n- [ ] todo\n- [x] done\n\n```ts src/x.ts\nconst a = 1;\n```\n\n```bash\nls\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
const checks = { citeChip: out.includes('class="cite"') && out.includes('data-path="docs/HANDOFF.md"') && out.includes('data-line="3"'), backtickPath: out.includes('data-path="src/agent-pane.ts" data-line="12"'), barePath: out.includes('data-path="packages/builtin/src/codex.ts" data-line="5" data-end="9"'), taskOpen: out.includes('class="task"'), taskDone: out.includes('class="task done"'), fencePath: out.includes('data-path="src/x.ts"') && out.includes("data-apply"), fenceNoPath: out.includes("data-insert"), table: out.includes("<table>"), linkCount4: (out.match(/<a class="file"/g) || []).length === 4 };
console.log(JSON.stringify(checks)); if (Object.values(checks).some((v) => !v)) { console.log(out); process.exit(1); }
'''
open(m + ".test.js", "w").write(test); r = subprocess.run(["node", m + ".test.js"], capture_output=True, text=True); print("renderer test:", r.stdout.strip()[:1200], r.stderr[:400]); sys.exit(r.returncode)
