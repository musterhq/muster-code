# Full syntax check of the pane webview script (the TS template literal eats lone backslashes; node --check catches what tsc cannot).
import subprocess, tempfile, sys, os
src = os.path.join(os.path.dirname(__file__), "..", "..", "packages", "builtin", "src", "agent-pane.ts")
s = open(src).read(); i = s.index('function paneHtml(csp: string, codicon = ""): string {'); fn = s[i:].replace('function paneHtml(csp: string, codicon = ""): string {', 'function paneHtml(csp, codicon = "") {', 1)
node = fn + '\nconst html = paneHtml("x"); const sc=[...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)].map(m=>m[1]); require("fs").writeFileSync(process.argv[2], sc[sc.length-1]);'
t = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False); t.write(node); t.close(); m = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False).name
r = subprocess.run(["node", t.name, m], capture_output=True, text=True)
if r.returncode == 0: r = subprocess.run(["node", "--check", m], capture_output=True, text=True)
print("pane webview script:", "ok" if r.returncode == 0 else r.stderr[:600]); sys.exit(r.returncode)
