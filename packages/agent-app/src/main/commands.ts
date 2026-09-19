import type { Commands } from '../shared/protocol.ts';

/** Runtime allowlist mirroring the keys of the parent-owned `Commands` interface.
 *  `satisfies` keeps it in lockstep: protocol drift breaks typecheck here. */
const COMMANDS = {
  'app.snapshot': true,
  'folder.add': true,
  'folder.pick': true,
  'chat.create': true,
  'chat.select': true,
  'chat.update': true,
  'chat.movePin': true,
  'chat.send': true,
  'chat.stop': true,
  'chat.contextTelemetry': true,
  'approval.respond': true,
  'project.create': true,
  'workspace.watch': true,
  'files.list': true,
  'files.read': true,
  'files.asset': true,
  'git.changes': true,
  'link.open': true,
  'clipboard.write': true,
  'git.diff': true,
  'providers.list': true,
  'providers.reveal': true,
  'providers.save': true,
  'providers.remove': true,
  'providers.check': true,
} as const satisfies Record<keyof Commands, true>;

export type CommandName = keyof typeof COMMANDS;

// Type guard: preserves narrowing for untrusted IPC channel strings.
export function isCommandName(value: unknown): value is CommandName {
  return typeof value === 'string' && Object.hasOwn(COMMANDS, value);
}
