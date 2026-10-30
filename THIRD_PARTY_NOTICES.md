# Third-party notices

This repository is MIT-licensed (see [LICENSE](LICENSE)). It includes or builds on the following
third-party work, each under its own license:

| Component | Where | License |
|---|---|---|
| Muster core (Codex app-server client, memory and Hindsight stores, local Docker sandbox) | `packages/agent-app/vendor/muster-core`, bundled runtime | MIT, Copyright (c) 2026 Muster contributors |
| QM (scoped-computer contract, adapted) | `packages/agent-app` runtime | MIT, Copyright (c) 2026 QM contributors |
| T3 Code (incremental Markdown parser, table interaction and styling, HTML render and preview, maths in replies and copy-as-source) | `packages/agent-app/src/renderer`, `packages/agent-app/src/shared/markdown-math.ts` | MIT, Copyright (c) 2026 T3 Tools Inc. |
| micromark-extension-llm-math, mdast-util-math, micromark-extension-gfm-table (patched maths tokenizer) | `packages/agent-app/patched-packages` | MIT, Copyright (c) Titus Wormer |
| KaTeX and its fonts | bundled in Muster Agent | MIT, Copyright (c) Khan Academy and other contributors |
| T3 Code (incremental Markdown parser, table interaction and styling, HTML render and preview, notebook and Mermaid file previews) | `packages/agent-app/src/renderer`, `packages/agent-app/src/shared` | MIT, Copyright (c) 2026 T3 Tools Inc. |
| Mozilla PDF.js, SheetJS SSF | bundled in Muster Agent | Apache-2.0 |
| three.js and its 3D model loaders and decoders (Draco, meshopt) | bundled in Muster Agent, loaded when a model opens | MIT (three.js), Apache-2.0 (Draco), MIT (meshoptimizer) |
| T3 Code (device streaming, the H.264 stall fix `avcConfig.ts` and its tests from commit fa4e4677c0ecc437aece2dcea39f76ef31414152, and device-model conversion approach) | `packages/agent-app/src/main/devices`, `packages/agent-app/src/renderer/devices` | MIT, Copyright (c) 2026 T3 Tools Inc. |
| Expo Device Hub (with serve-sim and serve-emu), scrcpy-server | installed on the user's computer at runtime by Devices, not bundled | MIT; Apache-2.0 |
| Code-OSS (Visual Studio Code open source) | Muster Code builds assembled by `scripts/assemble.sh` | MIT, Copyright (c) Microsoft Corporation |
| npm packages bundled into Muster Agent | `dist/renderer/THIRD-PARTY-LICENSES.txt` | per package (MIT, ISC, Apache-2.0, BSD, Zlib, Unlicense, EPL-2.0, MPL-2.0 OR Apache-2.0) |

Details, attribution and full license texts:

- [`packages/agent-app/THIRD-PARTY-NOTICES.md`](packages/agent-app/THIRD-PARTY-NOTICES.md)
- [`packages/agent-app/licenses/`](packages/agent-app/licenses/): `muster-core-MIT.txt`, `qm-MIT.txt`,
  `t3code-MIT.txt`, and the generated `THIRD-PARTY-LICENSES.txt` covering every bundled npm package
  (regenerate with `scripts/dependency-report.mjs`). The same file ships inside the app under
  Help > Third-Party Notices.

Where a dependency offers a choice of licenses (for example jszip, "MIT OR GPL-3.0-or-later"), Muster
uses it under the MIT license. DOMPurify ("MPL-2.0 OR Apache-2.0") is used under Apache-2.0. elkjs (EPL-2.0, the
diagram layout engine Mermaid loads) is bundled unmodified; its source is the published npm package.
