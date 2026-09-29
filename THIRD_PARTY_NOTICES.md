# Third-party notices

This repository is MIT-licensed (see [LICENSE](LICENSE)). It includes or builds on the following
third-party work, each under its own license:

| Component | Where | License |
|---|---|---|
| Muster core (Codex app-server client, memory and Hindsight stores, local Docker sandbox) | `packages/agent-app/vendor/muster-core`, bundled runtime | MIT, Copyright (c) 2026 Muster contributors |
| QM (scoped-computer contract, adapted) | `packages/agent-app` runtime | MIT, Copyright (c) 2026 QM contributors |
| T3 Code (incremental Markdown parser, table interaction and styling) | `packages/agent-app/src/renderer` | MIT, Copyright (c) 2026 T3 Tools Inc. |
| Mozilla PDF.js, SheetJS SSF | bundled in Muster Agent | Apache-2.0 |
| Code-OSS (Visual Studio Code open source) | Muster Code builds assembled by `scripts/assemble.sh` | MIT, Copyright (c) Microsoft Corporation |
| npm packages bundled into Muster Agent | `dist/renderer/THIRD-PARTY-LICENSES.txt` | per package (MIT, ISC, Apache-2.0, BSD, Zlib, Unlicense) |

Details, attribution and full license texts:

- [`packages/agent-app/THIRD-PARTY-NOTICES.md`](packages/agent-app/THIRD-PARTY-NOTICES.md)
- [`packages/agent-app/licenses/`](packages/agent-app/licenses/): `muster-core-MIT.txt`, `qm-MIT.txt`,
  `t3code-MIT.txt`, and the generated `THIRD-PARTY-LICENSES.txt` covering every bundled npm package
  (regenerate with `scripts/dependency-report.mjs`). The same file ships inside the app under
  Help > Third-Party Notices.

Where a dependency offers a choice of licenses (for example jszip, "MIT OR GPL-3.0-or-later"), Muster
uses it under the MIT license.
