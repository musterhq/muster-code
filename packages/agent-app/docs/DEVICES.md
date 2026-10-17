# Devices (iOS Simulator and Android Emulator)

Issue #363. Muster shows and drives this computer's iOS Simulators and Android Emulators in the right sidebar, as a
picture-in-picture card, and through agent tools.

## Pieces

| Where | What |
|---|---|
| `src/main/devices/discovery.ts` | Read-only checks and discovery: `xcode-select`, `xcrun simctl list`, `adb devices`, `emulator -list-avds`. |
| `src/main/devices/helper.ts` | Installs and runs the pinned helper (Expo Device Hub 0.15.3). |
| `src/main/devices/link.ts` | Main's own client of the helper: H.264 video (iOS AVCC, Android SEMU) with MJPEG as the iOS fallback, input sockets, flow control, reconnects. |
| `src/main/devices/chrome.ts` | Real device frames read at runtime: Xcode's DeviceKit chrome (through the helper) and the AVD's Android SDK skin. |
| `src/main/devices/models.ts`, `src/renderer/devices/appleModels.ts` | Realistic 3D models downloaded on demand from apple.com, verified, converted and cached locally. |
| `src/main/devices/manager.ts` | Settings, lifetimes, boot and shutdown, sessions, screenshots. |
| `src/main/devices/agent-tools.ts` | The `muster_device` MCP tools: `device_list`, `device_open`, `device_screenshot`, `device_tap`, `device_type`, `device_apps`, `device_launch_app`, `device_button`, `device_close`. |
| `src/shared/device-frames.ts` | The parametric frame spec, the built-in families, deriving a spec from simctl and AVD data, and the layout both views draw. |
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
  Android video uses scrcpy's on-device H.264 encoder (no ffmpeg on the computer): the install also fetches
  `scrcpy-server-v4.0` (Apache-2.0) from the scrcpy GitHub release and checks it against the published SHA-256
  `84924bd5…3210f3a`, so serve-emu never downloads an unverified copy itself.
- **Isolation.** The helper gets an allowlisted environment (PATH, HOME, locale, Android/Xcode locations; no API keys or tokens from Muster's environment) and its own `TMPDIR` under Muster's data, so stopping it (`serve-sim --kill`) touches
  only the helpers Muster started. It starts on demand and stops 45 s after the last session closes; turning Devices off
  stops it and every session. The user's simulators and emulators keep running.
- **Agents are a separate opt-in.** The MCP server is added to a run only when Devices and "Let agents use devices" are
  both on and the chat is in Agent mode; every call re-checks that. Read-only chats can list and screenshot only. Taps and
  typing need a session the agent opened for its own chat (so the user sees it live), and stop as soon as the user takes
  control. Launching an app runs a fixed command (`simctl launch <udid> <bundle id>`, or `adb shell monkey -p <package>
  -c android.intent.category.LAUNCHER 1`) with the id checked against a strict pattern, so no text reaches a shell. Routes that
  load no MCP servers (API-only models) get neither the server nor the note about it. The tool host listens on 127.0.0.1 behind a random bearer token kept in a 0600 file, like Muster's other agent
  tools, and Project tool rules (`mcp` match, e.g. `muster_device/device_tap`) apply.

## Device frames

Every device is drawn in its own frame, from one parametric spec (`src/shared/device-frames.ts`): screen size and
aspect, the display's corner radius, the cut-out (none, Dynamic Island, notch, waterdrop, centre or side punch-hole: kind,
size, position), bezels, edge (flat or curved), colour, buttons (edge, position, length, kind), extras (Home button,
bezel camera, speaker, hinge, TV stand) and the form: phone, foldable (open and folded), tablet, round or square watch,
TV, automotive. The flat view draws it in SVG/CSS (`DeviceFrameFlat.tsx`) and the 3D view builds its body from the same
layout (`src/renderer/devices/bodies.ts`), so both always show the same device.

Where the spec comes from:

- **iOS:** the simulator's device type from `simctl list devices` (e.g. `SimDeviceType.iPhone-16-Pro`). iPhones map to
  Dynamic Island (14 Pro, 15 and later, Air; 16 and later add the Camera Control), notch (X to 14, 16e) or Home button
  (SE, 8 and earlier); iPads to no Home button (camera on the long edge), mini (camera on the short edge) or Home button.
- **Android:** the AVD's own files, `<avd>.ini` → `config.ini`, overlaid by `hardware-qemu.ini` while it runs:
  `hw.device.name`, `hw.device.manufacturer`, `hw.lcd.width`/`height`/`density`, `tag.id`, `skin.name`/`skin.path`,
  `hw.sensor.hinge` and display regions. A running emulator also reports its display cut-out (`dumpsys window
  displays`, with `wm size`). Built-in specs cover Pixel generations (punch-hole, side punch-hole, forehead, notch,
  curved Pro), Pixel Fold, Pixel Tablet, centre punch-hole phones (Samsung-style), small phones, Wear OS round and
  square, TV and automotive. Anything else gets a generic Android spec computed from its own screen size, density and
  reported cut-out, so a device never wears another OS's frame.
- **Foldables** follow their posture: the folded spec is used while the picture has the outer display's shape.

What is drawn over the live picture: only the cut-out, where the device has it (the simulator and emulator streams do
not include the island or the punch-hole, which the device's own status bar lays out around). The picture is masked to
the display's real corner radius.

### Real frames from the user's own tools

When the user's tools have them, the flat view draws the device's real frame instead, read at runtime and never copied
into Muster: for a simulator, the DeviceKit chrome Apple's Simulator draws (the helper reads the device type's profile
and its `.devicechrome` bundle under `/Library/Developer` and rasterises it; main fetches the parsed descriptor and the
allowlisted images from the helper's read-only loopback routes `GET /grid/api` and `GET /grid/api/devicekit-chrome`);
for an emulator, the AVD's skin from the Android SDK (`skin.path`/`skin.name` → `skins/<name>/layout` and its images,
Apache-2.0, with the display mask when it matches). The live picture sits in the frame's screen rectangle, masked to its
corners; only the cut-out is drawn over it. Sliced chromes, mismatched skins, missing tools and landscape use the
parametric frame. Each device's frame source is logged, and the CI device smoke records it.

## Streaming

- **iOS:** H.264 from the helper's AVCC route (`/helper/<udid>/stream.avcc`): a seed JPEG, an avcC decoder description,
  then length-prefixed access units, at the simulator's native 60 fps. Main demuxes and forwards them in order; the
  renderer decodes with WebCodecs after `isConfigSupported` (some decoders reject the simulators' High 5.1 profile) and
  acknowledges each decoded frame. About a second behind, main reopens the subscription, which starts with a fresh
  keyframe. A window that cannot decode H.264 asks main to stream MJPEG for that device instead.
- **Android:** scrcpy's H.264 inside SEMU frames on the helper's socket (Annex-B, configured from the first keyframe's
  SPS); a backlog skips to the next keyframe and asks the encoder for one.
- The approach (AVCC demuxing, the probe and the MJPEG fallback) adapts T3 Code's device stream client (MIT; see
  `THIRD-PARTY-NOTICES.md`). The renderer still never reaches the helper: frames come over IPC and input goes through main.

## Realistic 3D models

For an iPhone with Dynamic Island or an iPad, the 3D view can show the real device: the first time it needs one, main
downloads Apple's AR Quick Look file from apple.com (pinned URL), refuses it unless its SHA-256 matches, and caches it
under app data; the renderer converts it in JavaScript (body extracted, axes and scale normalised, the baked screen
replaced by the named live screen, textures at most 1024 px as WebP) and the GLB is cached too. Muster's own body shows
until it is ready, and stays when offline or on any failure. A one-time note says "Downloads device models from
apple.com"; Settings has the switch (on by default), and turning it off deletes the cache. `metadata.json` in the cache
records each file's source URL, checksum, author (Apple Inc.) and that it has no open-source or redistribution licence.
Nothing Apple-derived is committed, bundled or uploaded.

## Verification

`.github/workflows/agent-app-devices.yml` boots an iOS Simulator (macOS runner) and an Android Emulator (Linux, KVM)
headless, installs the helper exactly as the app does, and streams a first frame through it, then checks input, presses
Home and takes a screenshot. The frame, screenshot and a step report are uploaded as artifacts.

## Performance

Nothing runs between frames: no animation loop, no timers. Video flows only while a viewer (the tab or a PiP card) is
on screen in a focused window; an unwatched device costs nothing. Each frame is decoded once into a shared canvas and
copied into each viewer outside React, so the view re-renders only when the picture's size changes (first frame,
rotation). `scripts/readme-shots/device-perf.mjs` measures it in headless Chrome: at 30 fps over 5 s, flat view script
time 1.6 ms (96 ms before frames bypassed React), 3D view 49 ms (149 ms), PiP card 1.5 ms (22 ms), zero React commits per
frame, and no animation frames or long tasks while idle.
