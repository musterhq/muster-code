/**
 * The turn note a sandbox chat's agent reads (#652). It names sandbox_exec and sandbox_write only on routes that receive
 * them; on every such route Muster also denies the provider's own host shell and edit tools (#653, see provider.ts), so the
 * note says so plainly and still admits that the provider's read tools read files on the user's Mac.
 */
import {sandboxToolsReach} from '../shared/sandbox-routes.ts';

export const SANDBOX_ENV_LABEL = 'Sandbox · Linux container';
/** SBX-11: the note's browser sentence when the chat's browser runs inside the container instead. */
export const SANDBOX_BROWSER_ENDPOINT = 'http://127.0.0.1:9222';
const HOST_BROWSER_SENTENCE = 'The agent browser, when available, runs on the user\'s Mac, not in the container.';
const CONTAINER_BROWSER_SENTENCE = `This chat's browser runs inside the container, not on the user's Mac: headless Chromium with its DevTools endpoint at ${SANDBOX_BROWSER_ENDPOINT} (reachable only inside the container). Drive it from sandbox_exec (for example a CDP or Playwright script); do not use host browser tools for this chat's pages.`;
/** Every sandbox note starts with this sentence, so a route without the sandbox tools can swap the note for its own. */
const LEAD = `This chat runs in ${SANDBOX_ENV_LABEL}.`;
/** What the provider's own tools can still do on the host: they stay on the Mac, with commands and edits denied there. */
const HOST_TOOLS_SENTENCE = 'Your own shell and file-editing tools are turned off for this chat: they would run on the user\'s Mac, outside the container. If one is still offered, do not use it. Your own read and search tools still read files on the user\'s Mac.';

/** Turn note for a sandbox chat on a route that has the sandbox tools; the tools describe themselves, this fixes where work happens. */
export function sandboxNote(browser: 'host' | 'sandbox' = 'host'): string {
  return `${LEAD} The working folder you see is the host side of the container's /workspace (an isolated copy of the project). Run every command with the sandbox_exec tool and make every file change with sandbox_write. ${HOST_TOOLS_SENTENCE} Paths passed to sandbox tools are relative to /workspace. The user applies your changes to their Mac later through a diff review. ${browser === 'sandbox' ? CONTAINER_BROWSER_SENTENCE : HOST_BROWSER_SENTENCE}`;
}
/** The note on a route that never receives the sandbox tools: nothing runs in the container, and host access stays read-only. */
export const NO_SANDBOX_TOOLS_NOTE = `${LEAD.replace('runs in', 'is set to run in')} This model has no sandbox tools, so nothing you do runs in the container. Your own tools run on the user's Mac with read-only access: you can read files and answer, but you cannot run commands or change files in this chat. If the task needs that, say so; the user can switch to a model that supports the sandbox or move the chat back to their Mac.`;

/** The note as a route with this driver should read it: unchanged where the sandbox tools arrive, replaced where they don't. */
export function routeSandboxNote(instructions: string | undefined, driver: string | undefined): string | undefined {
  if (!instructions || sandboxToolsReach(driver)) return instructions;
  const at = instructions.indexOf(LEAD);
  if (at < 0) return instructions;
  const end = instructions.indexOf('\n', at);
  return instructions.slice(0, at) + NO_SANDBOX_TOOLS_NOTE + (end < 0 ? '' : instructions.slice(end));
}
