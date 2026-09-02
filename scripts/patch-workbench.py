#!/usr/bin/env python3
"""Distribution patches on the workbench bundle (Cursor-style). Idempotent.

1. Do not auto-disable the designated chat extension on first run: VS Code's
   ensureChatExtensionInitialDisabledState() disables it unless a Copilot-shaped
   'chat setup' is marked completed. Muster IS the chat extension; it is always on.
"""
import sys
path = sys.argv[1]
s = open(path, encoding="utf-8").read()
needle = "ensureChatExtensionInitialDisabledState(){if(!this._chatExtensionId||"
patched = "ensureChatExtensionInitialDisabledState(){return;if(!this._chatExtensionId||"
if patched in s:
    print("  workbench: chat-extension auto-disable already neutralized")
elif needle in s:
    s = s.replace(needle, patched, 1)
    open(path, "w", encoding="utf-8").write(s)
    print("  workbench: chat-extension auto-disable neutralized")
else:
    print("  workbench: PATCH ANCHOR NOT FOUND — upstream changed; review before shipping", file=sys.stderr)
    sys.exit(1)
