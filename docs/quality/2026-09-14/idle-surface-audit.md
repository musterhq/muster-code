# Idle surface audit

| Component | Decision | Rationale | Trigger/state |
|---|---|---|---|
| Large marketing-style welcome hero and headline | Refine | The idle surface needs a visual anchor, but it should orient the next task rather than sell the product. The hero is now a restrained “What are we working on?” task prompt. | Empty chat |
| Welcome shortcut row (Add context / Plan / Review) | Remove | These duplicate real composer/review affordances and create three competing starts. | Empty chat |
| Compact starter sentence | Keep | One short orientation line preserves discoverability without a second action surface. | Empty chat |
| Masthead wordmark | Keep small | Retains product identity while avoiding a second hero treatment. | All chat states |
| Masthead “New task” affordance | Keep | Gives the empty state a direct task start and keeps task creation tied to the host. | All chat states |
| Masthead Tasks and Agents actions | Keep | These are the two contextual workspace surfaces needed for concurrent task and child-agent inspection. | All chat states |
| Style / Tools / Managed terminals / Browser | Move to More menu | They remain reachable and keyboard accessible without turning the masthead into a row of unrelated controls. | All chat states; menu on demand |
| Activity summary | Keep while active | Running, waiting, failed, and completed work needs a durable state signal. | `running`, `waiting`, `failed`, `completed` |
| Activity summary when ready | Hide | “Ready Ready Details” adds height and noise before a task exists. | `ready` with no details |
| Usage details | Keep behind disclosure | Counts and prompt estimates remain inspectable on demand while the idle/active surface stays compact. | Provider usage or ledger exists |
| Composer mode/access/model controls | Keep | These are task-local execution controls and must remain visible at the point of composition. | All chat states |
| Context shelf Add Context | Keep | Single contextual entry point for files/browser selections. | All composer states |
| Chat history entry | Keep in More | The internal tab strip is intentionally quiet, so its previous History button was unreachable when the tabs strip was hidden. More now exposes the same existing view-history host message, and the renderer shows an explicit empty-provider state. | All chat states; provider rows or empty result |
| Full-file diff/review entry points | Keep | Review and file inspection are core work surfaces and must not be hidden behind idle polish. | Changes reported |
| Empty explorer | De-emphasize | Navigation remains available in the host; an empty tree should not compete with task start. | No files/tasks |

The implementation is a structural idle-state change in the existing vanilla webview. It preserves `state`, `messages`, `delta`, `telemetry`, `agentWorkspace`, and `taskWorkspace` contracts, keeps context and task preferences persisted, and retains keyboard paths. The More menu is an in-webview command surface; its actions continue to emit the existing host messages.
