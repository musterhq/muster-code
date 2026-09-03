#!/usr/bin/env python3
"""Patch the assembled workbench (idempotent; exits 1 if an anchor is missing).

  patch-workbench.py <workbench.desktop.main.js> <muster-inline-diff.js> <product.json>

1. Never auto-disable the designated chat extension (VS Code does on first run).
2. Inject the Muster inline-diff contribution after the module export, with its
   service placeholders resolved to the bundle's minified names.
3. Clear product checksums so the patched workbench is not reported as corrupt.
"""
import json
import pathlib
import re
import sys

js_path, contrib_path, product_path = (pathlib.Path(p) for p in sys.argv[1:4])
js = js_path.read_text()

anchor = "ensureChatExtensionInitialDisabledState(){if(!this._chatExtensionId||"
patched = "ensureChatExtensionInitialDisabledState(){return;if(!this._chatExtensionId||"
if anchor in js:
    js = js.replace(anchor, patched, 1)
elif patched not in js:
    sys.exit("anchor missing: ensureChatExtensionInitialDisabledState")

MARK, END = "/*muster-inline-diff*/", "/*muster-inline-diff:end*/"
if MARK in js:
    js = js[: js.index(MARK)] + js[js.index(END) + len(END):]

anchors = {
    "__CommandsRegistry__": r'\("commandService"\),([\w$]+)=new class\{constructor\(\)\{this\._commands=new Map',
    "__ICodeEditorService__": r'(?:var |,)([\w$]+)=[\w$]+\("codeEditorService"\)',
    "__IModelService__": r'(?:var |,)([\w$]+)=[\w$]+\("modelService"\)',
    "__ILanguageService__": r'(?:var |,)([\w$]+)=[\w$]+\("languageService"\)',
    "__ICommandService__": r'(?:var |,)([\w$]+)=[\w$]+\("commandService"\)',
    "__IViewDescriptorService__": r'(?:var |,)([\w$]+)=[\w$]+\("viewDescriptorService"\)',
}
contrib = contrib_path.read_text()
resolved = {}
for placeholder, pattern in anchors.items():
    match = re.search(pattern, js)
    if not match:
        sys.exit(f"anchor missing: {placeholder}")
    resolved[placeholder] = match.group(1)
    contrib = contrib.replace(placeholder, match.group(1))

export_at = js.rfind("export{")
if export_at < 0:
    sys.exit("anchor missing: module export")
insert_at = js.index(";", export_at) + 1
js = js[:insert_at] + "\n" + MARK + "\n" + contrib + "\n" + END + "\n" + js[insert_at:]
js_path.write_text(js)

# 4. Cursor's empty-editor welcome: New Agent / Show Terminal / Search Files / Maximize Chat / Add Repository / Open Settings.
WATERMARK = {
    "workbench.action.showCommands": ('"New Agent"', "muster.agent.new"),
    "workbench.action.quickOpen": ('"Search Files"', "workbench.action.quickOpen"),
    "workbench.action.findInFiles": ('"Maximize Chat"', "muster.agent.maximize"),
    "workbench.action.terminal.toggleTerminal": ('"Show Terminal"', "workbench.action.terminal.toggleTerminal"),
    "workbench.action.debug.start": ('"Add Repository"', "workbench.action.addRootFolder"),
    "workbench.action.openSettings": ('"Open Settings"', "workbench.action.openSettings"),
}
for old_id, (text, new_id) in WATERMARK.items():
    pattern = re.compile(r'text:[a-zA-Z_$]+\(\d+,null\),id:"' + re.escape(old_id) + '"')
    js, count = pattern.subn(f'text:{text},id:"{new_id}"', js, count=1)
    if not count and f'id:"{new_id}"' not in js:
        sys.exit(f"anchor missing: watermark entry {old_id}")
js_path.write_text(js)

product = json.loads(product_path.read_text())
product["checksums"] = {}
product_path.write_text(json.dumps(product, indent=2) + "\n")

names = ", ".join(f"{k.strip('_')}={v}" for k, v in resolved.items())
print(f"workbench patched: chat guard, inline diff ({names}), checksums cleared")
