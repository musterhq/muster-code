# Devices (iOS Simulator and Android Emulator)

Issue #363. Muster shows and drives this computer's iOS Simulators and Android Emulators in the right sidebar, as a
picture-in-picture card, and through agent tools.

## Pieces

| Where | What |
|---|---|
| `src/main/devices/discovery.ts` | Read-only checks and discovery: `xcode-select`, `xcrun simctl list`, `adb devices`, `emulator -list-avds`. |
| `src/main/devices/helper.ts` | Installs and runs the pinned helper (Expo Device Hub 0.15.3). |
| `src/main/devices/link.ts` | Main's own client of the helper: MJPEG (iOS) and H.264 (Android) video, input sockets, flow control, reconnects. |
| `src/main/devices/manager.ts` | Settings, lifetimes, boot and shutdown, sessions, screenshots. |
| `src/main/devices/agent-tools.ts` | The `muster_device` MCP tools. |
| `src/main/devices/models.ts` | Opt-in download and cache of Apple's device models (see below). |
| `src/renderer/devices/*`, `src/renderer/components/devices/*` | Feed decoding, the live view, the 3D frame, Settings, the PiP card. |
| `resources/device-helper/` | The helper's `package.json` and `package-lock.json`, shipped instead of the helper itself. |

## Security model

- **The helper is never reachable from outside Muster.** It binds `127.0.0.1` on a random port and runs with
  `--require-token`; the token is printed once on its stdout, which only main reads, and every request carries it as a
  bearer header (never in a URL). The renderer has no address or token: it receives frames over IPC and sends input
  through main, which validates each message (`parseDeviceInput`) and checks the sender frame like every other command.
  serve-sim's shell-exec routes and serve-emu's action routes are never called.
- **Install is reproducible and inert.** `npm ci --ignore-scripts` of the shipped lockfile: every tarball is checked
  against its sha512, no package script runs, and the install is staged and renamed into place only when complete.
- **Isolation.** The helper gets an allowlisted environment (PATH, HOME, locale, Android/Xcode locations; no API keys or tokens from Muster's environment) and its own `TMPDIR` under Muster's data, so stopping it (`serve-sim --kill`) touches
  only the helpers Muster started. It starts on demand and stops 45 s after the last session closes; turning Devices off
  stops it and every session. The user's simulators and emulators keep running.
- **Agents are a separate opt-in.** The MCP server is added to a run only when Devices and "Let agents use devices" are
  both on and the chat is in Agent mode; every call re-checks that. Read-only chats can list and screenshot only. Taps and
  typing need a session the agent opened for its own chat (so the user sees it live), and stop as soon as the user takes
  control. The tool host listens on 127.0.0.1 behind a random bearer token kept in a 0600 file, like Muster's other agent
  tools, and Project tool rules (`mcp` match, e.g. `muster_device/device_tap`) apply.

## Apple device models (opt-in)

Muster does not commit, bundle or redistribute any Apple-derived 3D asset. With "Apple device models in 3D" on, main
downloads Apple's public AR Quick Look files from apple.com on the user's computer and checks their SHA-256:

| Model | Source | SHA-256 |
|---|---|---|
| iPhone | `https://www.apple.com/105/media/us/iphone-18-pro/2026/591df885-5ee2-4173-86e6-401021249f7c/ar/iphone-18-pro-e-sim.usdz` | `0f2dac354fbc6505e7917983de460f2cc68e253f96aabf52e9f0468a4803f317` |
| iPad | `https://www.apple.com/105/media/us/ipad-pro/2025/adee90db-c01e-430d-b726-fe64c0063f08/ar/ipad-pro-space-black.usdz` | `48098daf7c49117c81a4e4e1808899b93fad081faeba6c8b65124946b83b5ac6` |

URLs and checksums were cross-checked against T3 Code's `apps/web/src/components/device/models/sources.json` (whose
README states no redistribution licence for the assets themselves). The renderer then converts each file locally
(`src/renderer/devices/appleModels.ts`): parse with three.js `USDLoader` (plus USD `PayloadListOp` support, which
Apple's files need), keep the body prim and its display mesh, bake transforms, rotate so the display faces +Z with its
long side up, centre and scale the display to 2.2 units, replace the marketing picture with the live-screen placeholder
and planar UVs, cap textures at 1024 px, and export a binary glTF that main caches under app data. Turning the option off
deletes every downloaded and converted file. Any failure (offline, checksum mismatch, a file that changed) falls back to
Muster's own bodies with a quiet note.

## Muster's own bodies

`src/renderer/devices/bodies.ts` builds stylised generic phone, tablet and foldable bodies from three.js primitives in
code. They are original to this repository (MIT) and use no external model, scan or trade dress. Android always uses them.

## Verification

`.github/workflows/agent-app-devices.yml` boots an iOS Simulator (macOS runner) and an Android Emulator (Linux, KVM)
headless, installs the helper exactly as the app does, and streams a first frame through it, then checks input, presses
Home and takes a screenshot. The frame, screenshot and a step report are uploaded as artifacts.
