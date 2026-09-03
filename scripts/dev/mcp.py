import json, os, subprocess, time, re, glob
class Shim:
    def __init__(self):
        log = sorted(glob.glob("/tmp/mc-udd/logs/*/window1/exthost/muster.muster-code/Muster.log"), key=os.path.getmtime)[-1]
        line = [l for l in open(log) if "browser tools listening" in l][-1].strip()
        m = re.search(r"listening on (.*) \(shim: (.*)\)$", line); self.sock, self.shim = m.group(1), m.group(2)
        self.p = subprocess.Popen([self.shim, "packages/builtin/dist-ext/browser-mcp.js"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(os.environ, ELECTRON_RUN_AS_NODE="1", MUSTER_BROWSER_SOCK=self.sock), text=True)
        self.seq = 0; self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
    def rpc(self, method, params=None):
        self.seq += 1; self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params or {}}) + "\n"); self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line: raise SystemExit(f"shim exited: {self.p.stderr.read()[:400]}")
            m = json.loads(line)
            if m.get("id") == self.seq: return m
    def call(self, name, args=None):
        t0 = time.time(); r = self.rpc("tools/call", {"name": name, "arguments": args or {}}).get("result") or {}
        texts = [c.get("text", "") for c in r.get("content", []) if c.get("type") == "text"]
        return ("ERR " if r.get("isError") else "ok  ") + f"{round((time.time()-t0)*1000)}ms " + " | ".join(t[:100].replace("\n", " ⏎ ") for t in texts), texts
    def close(self): self.p.stdin.close(); time.sleep(0.2); self.p.terminate()
