/** #688: the driver name of a turn that runs a Claude model over a router's Messages API with Muster's own shell, file and
 *  browser tools. It is not a route's driver: a Codex gateway route picks it per turn, and a chat records it as the lane of
 *  its provider thread. It is deliberately not 'anthropic-messages', which names the chat-only Anthropic API route. */
export const CLAUDE_LANE_DRIVER = 'anthropic-messages-tools';
/** The driver a chat's next turn behaves as, for compaction, sub-agent notices and mail: the lane of its saved thread when it has one. */
export const effectiveDriver = (routeDriver: string | undefined, chat: {providerThreadDriver?: string}): string | undefined => chat.providerThreadDriver ?? routeDriver;
/** #730: the lane of a router turn that runs a Claude model through Claude Code (the Claude Code route's own driver). */
export const CLAUDE_CODE_LANE_DRIVER = 'claude-code-cli';
/** Lanes that run inside Muster: an unfinished turn ends with the app instead of continuing remotely. */
export const inProcessLane = (driver: string | undefined): boolean => driver === CLAUDE_LANE_DRIVER || driver === CLAUDE_CODE_LANE_DRIVER;
