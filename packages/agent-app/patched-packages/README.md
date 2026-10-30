# Patched packages

The maths tokenizer replies use (#785). Each directory is the published npm package with one patch applied, installed in
place of the published package through `package.json` (a `file:` dependency plus a matching `overrides` entry, so every
dependent, remark-math and remark-gfm included, gets the patched copy).

| Directory | Published package | Installed as | Patch |
|---|---|---|---|
| `micromark-extension-llm-math` | micromark-extension-llm-math 3.1.0 (MIT) | `micromark-extension-math` | `patches/micromark-extension-llm-math@3.1.0.patch` |
| `mdast-util-math` | mdast-util-math 3.0.0 (MIT) | `mdast-util-math` | `patches/mdast-util-math@3.0.0.patch` |
| `micromark-extension-gfm-table` | micromark-extension-gfm-table 2.1.1 (MIT) | `micromark-extension-gfm-table` | `patches/micromark-extension-gfm-table@2.1.1.patch` |

What the patches do: `$…$` and `\(…\)` / `\[…\]` are read the way models write them, while prices (`$5 and $10`) and shell
variables (`$HOME`) stay text; same-line `$$…$$` display formulas; `$$…$$` and `\[…\]` within a sentence are display style;
and a formula's pipes stay inside its table cell.

The patches are T3 Code's (https://github.com/pingdotgg/t3code, MIT, Copyright (c) 2026 T3 Tools Inc.), `patches/` at
commit `fa4f3a2925822201e6fe4f11db45c8649383e420`; see `../THIRD-PARTY-NOTICES.md`. The two micromark packages export
their patched `dev/` build only (the unpatched `lib/` build was removed), and build-only fields were dropped from their
`package.json`; micromark-extension-llm-math no longer lists katex, which only its unused HTML output needs.

To move a package forward: `npm pack <name>@<version>`, unpack it here, apply the patch with `patch -p1`, repeat the
`package.json` edits above, then `npm install` and `npm test -- tests/markdown-math.test.ts`.
