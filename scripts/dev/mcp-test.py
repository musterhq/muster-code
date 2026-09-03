import json, os, subprocess, sys, time, re, glob
log = sorted(glob.glob("/tmp/mc-udd/logs/*/window1/exthost/muster.muster-code/Muster.log"), key=os.path.getmtime)[-1]
line = [l for l in open(log) if "browser tools listening" in l][-1].strip()
m = re.search(r"listening on (.*) \(shim: (.*)\)$", line); sock, shim = m.group(1), m.group(2)
p = subprocess.Popen([shim, "packages/builtin/dist-ext/browser-mcp.js"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(os.environ, ELECTRON_RUN_AS_NODE="1", MUSTER_BROWSER_SOCK=sock), text=True)
seq = 0
def rpc(method, params=None):
    global seq; seq += 1
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": seq, "method": method, "params": params or {}}) + "\n"); p.stdin.flush()
    while True:
        line = p.stdout.readline()
        if not line: raise SystemExit(f"shim exited: {p.stderr.read()[:400]}")
        m = json.loads(line)
        if m.get("id") == seq: return m
def call(name, args=None):
    t0 = time.time(); r = rpc("tools/call", {"name": name, "arguments": args or {}}).get("result") or {}
    texts = [c.get("text", "") for c in r.get("content", []) if c.get("type") == "text"]
    return ("ERR " if r.get("isError") else "ok  ") + f"{round((time.time()-t0)*1000)}ms " + " | ".join(t[:100].replace("\n", " ⏎ ") for t in texts), texts
rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
s, texts = call("browser_navigate", {"url": "http://127.0.0.1:8765/"}); snap = texts[0]
print("--- snapshot ---"); print("\n".join(snap.split("\n")[2:14]))
inv = {m.group(2): m.group(1) for m in re.finditer(r'- (?:\w+) "([^"]+)" \[ref=(e\d+)\]', snap)}
def ref_of(label): return next((r for r, n in inv.items() if n.startswith(label)), None)
out = lambda: call("browser_evaluate", {"expression": "document.getElementById('out').textContent"})[0]
s, _ = call("browser_click", {"ref": ref_of("Click me")}); print("click button ", s[:50], "→ out =", out())
s, _ = call("browser_type", {"ref": ref_of("Search"), "text": "muster", "submit": True}); print("type+submit  ", s[:50], "→ out =", out())
s, _ = call("browser_select_option", {"selector": "#color", "value": "Green"}); print("select       ", s[:50], "→ out =", out())
s, _ = call("browser_hover", {"selector": "#hover"}); print("hover        ", s[:50], "→ out =", out())
s, texts = call("browser_click", {"ref": ref_of("Page two")}); print("click link   ", s[:60])
s, _ = call("browser_evaluate", {"expression": "location.pathname + ' ' + document.title"}); print("  where =", s)
s, texts = call("browser_go_back"); print("go_back      ", s[:60])
s, texts = call("browser_reload"); print("reload       ", s[:60])
s, _ = call("browser_navigate", {"url": "http://127.0.0.1:9/nothing"}); print("bad navigate ", s[:90])
s, _ = call("browser_click", {"ref": "e99"}); print("bad ref      ", s[:90])
p.stdin.close(); time.sleep(0.3); p.terminate()
