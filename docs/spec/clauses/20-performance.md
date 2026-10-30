# MUS-SPEC-20: Performance

Muster stays responsive with long chats, large folders and many running agents.

What the user can do:
- scroll long transcripts and large diffs smoothly;
- switch chats and screens without waiting on slow reads, seeing the last copy straight away while it refreshes.

Boundaries:
- Each performance case names its measure and its limit, and the machine it was measured on.
- A slow provider or server never blocks the interface.

## Acceptance cases

| Case | What the assertions check | Test |
|---|---|---|
| [MUS-SPEC-20-566A](20-performance.md#mus-spec-20-566a) | Building the renderer, the files the first page load pulls in do not include HubSetup.tsx or ProjectTasks.tsx. | [`the startup bundle leaves the hub setup forms and the project task page to their lazy chunks`](../../../packages/agent-app/tests/startup-bundle.test.ts) |
| [MUS-SPEC-20-553A](20-performance.md#mus-spec-20-553a) | After 20 streamed reply tokens, the composer has re-rendered at most 2 times. | [`streaming 20 tokens does not re-render the composer`](../../../packages/agent-app/tests/chat-render-bounds-dom.tsx) |
| [MUS-SPEC-20-553B](20-performance.md#mus-spec-20-553b) | After 20 streamed reply tokens, links in the transcript have re-rendered at most 2 times. | [`streaming 20 tokens does not re-render resource links`](../../../packages/agent-app/tests/chat-render-bounds-dom.tsx) |
| [MUS-SPEC-20-553C](20-performance.md#mus-spec-20-553c) | After 20 streamed reply tokens, the Changes view has re-rendered at most 2 times. | [`streaming 20 tokens does not re-render the changes view`](../../../packages/agent-app/tests/chat-render-bounds-dom.tsx) |
| [MUS-SPEC-20-813A](20-performance.md#mus-spec-20-813a) | A panel that opens while the window is inactive ends its fade-in at full opacity, and no animation keeps ticking while inactive; a focused window still fades in and spins. | [`a panel that opens while the window is inactive is visible, and nothing keeps animating`](../../../packages/agent-app/tests/idle-animations-813.test.ts) |

### Startup size

<a id="mus-spec-20-566a"></a>
#### MUS-SPEC-20-566A: The new-task form and project task page are not loaded at startup

- Precondition: The renderer is bundled the way the app builds it, with code splitting.
- Action: Follow the imports that load before first paint from `main.js`.
- Expected result: Neither `HubSetup.tsx` nor `ProjectTasks.tsx` is in that set; they load on first use.
- Test: `packages/agent-app/tests/startup-bundle.test.ts::the startup bundle leaves the hub setup forms and the project task page to their lazy chunks`
- Environment: Node test runner with esbuild; no network. It builds the renderer, so it takes a few seconds.
- Known gaps: Measure: which files load before first paint. The change cut about 87 KB (1.90 MB to 1.81 MB), measured on the author's machine; the test checks only that the two files are out, not the size. The new-task sheet still opening after a lazy load is checked by the existing DOM suite (nav-components.tsx), which also passes on main, so it is not linked.
- Evidence: UNVERIFIED

### Streaming does not redraw the rest of the screen

<a id="mus-spec-20-553a"></a>
#### MUS-SPEC-20-553A: Streaming a reply does not re-render the composer

- Precondition: A chat is open with its composer, the sidebar and a Summary card on screen. The reply is streaming.
- Action: 20 timeline updates arrive, each adding one more token to the reply.
- Expected result: The reply text grows, and the composer re-renders at most 2 times over the 20 updates (it was 21 before the change).
- Test: `packages/agent-app/tests/chat-render-bounds-dom.tsx::streaming 20 tokens does not re-render the composer`
- Environment: Real components in a DOM suite (linkedom and React Profiler); fake app bridge; no network. The limit is a count of React commits, not a time, so it does not depend on the machine.
- Known gaps: Counts commits only. It does not measure frame time or CPU use in the real app.
- Evidence: UNVERIFIED

<a id="mus-spec-20-553b"></a>
#### MUS-SPEC-20-553B: Streaming a reply does not re-render links in the transcript

- Precondition: Three resource links are on screen next to a streaming reply.
- Action: 20 timeline updates arrive, each adding one more token.
- Expected result: The links re-render at most 2 times over the 20 updates (it was 20 before the change).
- Test: `packages/agent-app/tests/chat-render-bounds-dom.tsx::streaming 20 tokens does not re-render resource links`
- Environment: Real components in a DOM suite (linkedom and React Profiler); fake app bridge; no network. The limit is a count of React commits, so it does not depend on the machine.
- Known gaps: Counts commits only. It uses three links, not a full transcript.
- Evidence: UNVERIFIED

<a id="mus-spec-20-553c"></a>
#### MUS-SPEC-20-553C: Streaming a reply does not re-render the Changes view

- Precondition: The Changes view for the chat's folder is on screen while a reply streams.
- Action: 20 timeline updates arrive, each adding one more token.
- Expected result: The Changes view re-renders at most 2 times over the 20 updates (it was 20 before the change).
- Test: `packages/agent-app/tests/chat-render-bounds-dom.tsx::streaming 20 tokens does not re-render the changes view`
- Environment: Real components in a DOM suite (linkedom and React Profiler); fake app bridge; no network. The limit is a count of React commits, so it does not depend on the machine.
- Known gaps: Counts commits only. The Processes, Subagents and branch picker changes in the same PR have no case of their own.
- Evidence: UNVERIFIED

<a id="mus-spec-20-813a"></a>
#### MUS-SPEC-20-813A: Panels opened while inactive are visible, and nothing animates

- Precondition: The app's own stylesheets are loaded; the window is marked inactive (`data-window-active="false"`), as when an agent opens something while the person works in another app.
- Action: A screen that fades in (`main.center[data-screen] > .settings-screen`) and a running status spinner mount; 600 ms pass.
- Expected result: The screen has opacity 1 and the spinner's animation is not advancing. With the window focused, the screen fades in to opacity 1 and the spinner turns.
- Test: `packages/agent-app/tests/idle-animations-813.test.ts::a panel that opens while the window is inactive is visible, and nothing keeps animating`
- Environment: Headless Chrome over CDP with the real styles.css, app-shell.css and message-body.css; skipped when Chrome is not installed.
- Known gaps: windowActivity.ts, which sets the attribute, is not driven here; the test sets it directly.
- Evidence: UNVERIFIED
