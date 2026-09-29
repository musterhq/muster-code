# Full syntax check of the pane webview script (the TS template literal eats lone backslashes; node --check catches what tsc cannot).
import subprocess, tempfile, sys, os
here = os.path.dirname(os.path.abspath(__file__))
m = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False).name
ex = subprocess.run(["node", "--import", "tsx", os.path.join(here, "extract-pane-script.ts"), m], cwd=os.path.join(here, "..", "..", "packages", "builtin"), capture_output=True, text=True)
if ex.returncode != 0: print("extract pane script failed:", ex.stderr[:800]); sys.exit(ex.returncode)
r = subprocess.run(["node", "--check", m], capture_output=True, text=True)
print("pane webview script:", "ok" if r.returncode == 0 else r.stderr[:600]); sys.exit(r.returncode)
