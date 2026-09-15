# Live QA log · staged baseline

## MC-001 baseline
- Confirmed native webview URL uses `dist/verified/Muster Code.app`, not the older `dist/Muster Code.app`.
- Native Lucide product icons and the Style control load. Existing draft from previous session is present.
- Old app had no running inference; closed before staged launch.
- Native file-only Open dialog rejected selecting a folder as expected. Switching to Open Folder exposed computer-use dialog timing/clipboard failures; not yet classified as a product defect.
- Use the documented app CLI with an isolated profile and `/tmp/muster-qa-20260913` to avoid altering the user’s working project. Human prompt/attachment interaction will be exercised through the native UI.
- No card marked Done from this setup evidence.

## Q7 live stress fixture
Defined 72 messages, 40 activity events, 80 deltas, 24 references, 20 usage rows completed; DOM has 96 message/summary nodes. Unicode typing and removal (2→1 retained refs) work. Expanded context/usage panels were 695/661px high and pushed composer offscreen in a ~733×889 viewport. Failed MC-203; sent to frontend for targeted repair. This is synthetic load in the real renderer, not paid model output.
