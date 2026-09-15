# Host capability audit · 14 September 2026

This is a read-only inventory of the installed OpenAI host and its documented interfaces. No auth files, tokens, account state, or installed application files were changed.

## Installed versions and paths

| Component | Evidence | Classification |
| --- | --- | --- |
| ChatGPT desktop app | `/Applications/ChatGPT.app`, bundle id `com.openai.codex`, `CFBundleShortVersionString 26.908.40834`, bundle version `8881` | Installed first-party host |
| Bundled Codex CLI/app-server | `/Applications/ChatGPT.app/Contents/Resources/codex`, `codex-cli 0.154.0-alpha.6.2`; `codex app-server --help` exposes `stdio`, `unix`, `ws`, `off`, `daemon`, `proxy`, and schema generation | Public app-server CLI surface; app-server is marked experimental by the CLI |
| Muster Code package | `dist/Muster Code.app`, bundle id `dev.themuster.code`, version `1.126.04524`; extension `/Contents/Resources/app/extensions/muster.muster-code/extension.js` | Local product artifact, not an OpenAI host API |
| Installed CUA service | `/Users/dhairya/.codex/computer-use/Codex Computer Use.app`, bundle id `com.openai.sky.CUAService`, version `26.902.1000968`, bundle version `1000968` | First-party desktop service with private IPC transport |
| Bundled CUA JS package | `/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua`, version `0.2.4`; bundled `@oai/sky`, version `0.6.32` | Host-bundled implementation surface; not a stable external extension contract |

The installed Codex CLI generated a version-matched schema with `codex app-server generate-ts --out /tmp/muster-schema.6uqTKC`. Relevant generated symbols include `ServerNotification`, `Thread`, `ThreadStatus`, `ThreadStatusChangedNotification`, `ThreadForkParams`, `ThreadItem`, `CollabAgentTool`, and `CollabAgentToolCallStatus`. The stable transport is newline-delimited JSON over stdio; the CLI labels app-server and WebSocket support experimental.

## Computer Use

The official ChatGPT documentation says Computer Use in the ChatGPT desktop app is available on macOS and Windows with Work and Codex, is enabled through the Computer Use plugin, and requires macOS Screen Recording and Accessibility permissions. It describes app approval, scoped tasks, user confirmation, and the existing built-in browser as the preferred path for local web apps. See [ChatGPT Computer Use](https://learn.chatgpt.com/docs/computer-use).

The bundled CUA package exposes these named TypeScript/JavaScript symbols:

- `MacComputerUseClient` and `client` in `.../@oai/cua/.../targets/mac/client.d.ts`.
- Actions `listApps`, `startApp`, `getAppState`, `click`, `drag`, `paste`, `performSecondaryAction`, `pressKey`, `scroll`, `setValue`, `selectText`, and `typeText`.
- Audio helpers `startAudioRecording` and `stopAudioRecording`, gated in the bundled implementation by `SKY_ENABLE_AUDIO=1`.
- `MacNativePipeTransport` in `.../targets/mac/native-pipe.js`, using the native pipe path `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock` or a host-provided environment override.

The package's public-looking client still requires a trusted `nodeRepl` service, `nodeRepl.rpc("sky", ...)`, and host launch/pipe services. The native service contains private implementation symbols such as `ComputerUseIPCJSONRPCSocketConnection`, `ComputerUseIPCRequestTypes`, `ComputerUseIPCSenderAuthorization`, and `ComputerUseJSONRPCRequest`. The native pipe and IPC request names are app-internal authorization boundaries; an extension host cannot safely reuse them merely because the binaries are installed. Muster can reuse Computer Use without an additional API key only by running inside the first-party trusted host/plugin path, if the host exposes that connector to the extension. There is no documented public ChatGPT-account IPC bridge for a third-party Code-OSS extension.

## Live voice

The official ChatGPT Voice documentation says Voice is available in the ChatGPT desktop app for supported plans and rollout states, works in Codex tasks, can start/check/follow up on separate tasks, and can use macOS screen context after the user enables it. It also states that only one desktop voice chat can be active at a time and that Voice uses a separate plan-dependent allowance. See [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice).

That desktop feature is a GPT-Live product surface, not a documented extension transport. One developer route for a new application is the separate Realtime API: an application server mints a short-lived `ek_` client secret, then a browser/client connects with `RealtimeSession` over WebRTC or a server connects over WebSocket. See [Realtime API getting started](https://developers.openai.com/api/docs/guides/realtime) and [Realtime API reference](https://platform.openai.com/docs/api-reference/realtime). This route requires an API-key-backed server to mint the ephemeral secret. It cannot satisfy the “reuse ChatGPT account with no extra API key” constraint by itself.

The installed CUA audio helpers only record computer/system audio to a WAV result. They are not a microphone-to-GPT voice session and do not expose GPT-Live conversation control. The ChatGPT desktop app contains private realtime voice implementation strings and native audio services, but no stable desktop-specific extension API was found. The experimental app-server realtime protocol requires separate evaluation (see correction below). Reusing those private IPC or renderer channels would couple Muster to app internals and could bypass host consent/plan controls.

## Feasibility and bounded next steps

1. Keep Muster’s Codex integration on the public local app-server stdio protocol and use its documented streamed events, approvals, thread controls, and generated schema. This reuses the signed-in Codex host without an API key, subject to the app-server’s experimental status and account permissions.
2. For Computer Use, integrate through the first-party Computer Use MCP/plugin boundary exposed by the host. Detect and report connector availability, app permission state, and missing Screen Recording/Accessibility permissions. Do not call the CUA Unix socket or private XPC symbols directly.
3. For voice without a new API key, offer a host handoff/deep link or instruct the user to start ChatGPT Voice in the desktop Codex task when supported. Do not claim that an embedded Muster voice session is available.
4. If standalone embedded voice is later required, make the API-key-backed Realtime path an explicit separate configuration with ephemeral-token issuance, consent, safety identifier, and audio permission handling. Do not silently route a ChatGPT-plan task through the API.

## Boundary summary

| Capability | Reusable under current no-extra-key constraint? | Reason |
| --- | --- | --- |
| Local Codex app-server | Yes, through documented stdio protocol | Bundled CLI and generated schema expose the protocol; user account auth remains host-owned |
| ChatGPT desktop Voice session | Only by host handoff/use in ChatGPT | Official feature exists, but no public extension bridge was found |
| Embedded realtime voice via app-server | Experimental candidate; session not verified | Installed schema exposes thread/realtime/start, WebRTC/WebSocket transports and voice catalog; account entitlement and audio lifecycle require testing |
| CUA desktop actions from an extension host | No direct reuse | Bundled `@oai/cua` requires trusted `nodeRepl` and private native pipe authorization |
| Computer Use via host plugin/MCP | Conditional | Supported by ChatGPT/Codex host with plugin enablement and OS/app approvals |


## Orchestrator correction and live read-only evidence

The initial voice conclusion omitted experimental RPCs. On 14 September, the installed 0.154.0-alpha.6.2 CLI generated `/tmp/muster-schema-experimental-20260914` with `app-server generate-ts --experimental`. It exposes `thread/realtime/start`, `appendAudio`, `appendText`, `appendSpeech`, `listVoices` and `stop`, with WebSocket, WebRTC SDP and existing-call transports. This is an app-server protocol seam distinct from private desktop IPC and from a separately keyed Realtime API client.

A local stdio probe initialized with `experimentalApi: true`, then called `thread/realtime/listVoices` successfully. It returned V1/V2 voice catalogs without supplying a new API key. Evidence: [realtime-catalog.json](evidence/realtime-catalog.json). No voice session, microphone capture, transcription or model inference was started. Catalog success does not prove session entitlement.

The [official Codex app-server repository](https://github.com/openai/codex/tree/main/codex-rs/app-server) documents experimental realtime transport; use installed generated types for version matching. Next gate: a disposable thread plus a bounded start/stop transport test, then native audio permission and stream/cancel/reconnect QA. Do not label account-backed embedded voice impossible or production-ready from catalog discovery alone.
