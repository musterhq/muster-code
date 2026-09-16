# Muster Code

Private. The standalone, Codex-first coding environment around muster: the reference IDE as the bar, every VS Code feature, your Codex threads pinned, the board in the editor.

## Shape

- `product/` — the distribution overlay (branding, Open VSX gallery, Muster as the default chat agent, proposed-API grants).
- `packages/builtin/` — the built-in Muster layer: default chat participant, Codex thread sessions, model provider, threads view, board, live diff, inline completions. Bundled into the app as `muster.muster-code`.
- `scripts/assemble.sh` — builds `dist/Muster Code.app` from a prebuilt Code-OSS binary + overlay + built-in layer. No VS Code compile.
- Engine: `@musterhq/core` (the open-source muster) linked from the sibling checkout.

## Build

```
pnpm install
pnpm assemble          # → dist/Muster Code.app
open "dist/Muster Code.app"
```

Dev launch (isolated profile): `MUSTER_CODE_DEV_SOCK=/tmp/mc-dev.sock "dist/Muster Code.app/Contents/MacOS/Muster Code" --user-data-dir /tmp/mc-udd /tmp/mc-sample`

Base: Code-OSS 1.126 (Electron 42, Node 24 with node:sqlite), from the VSCodium release binaries.
