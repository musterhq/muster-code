#!/usr/bin/env python3
"""plist-set.py <Info.plist> key=value [key=value ...] — set (or add) string keys."""
import plistlib, sys
path, *pairs = sys.argv[1:]
with open(path, "rb") as f: d = plistlib.load(f)
for pair in pairs:
    k, v = pair.split("=", 1); d[k] = v
with open(path, "wb") as f: plistlib.dump(d, f)
