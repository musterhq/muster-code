/**
 * Which runtime commands the server accepts over POST /rpc, and who may call them.
 *
 * - The allowlist is the app's own command map (`isCommandName` from the desktop main process); anything else is refused.
 * - `desktop`: needs the Electron main process (native menus, dialogs, embedded browser, screen capture, Quick Look, updater,
 *   host terminals). Refused with a clear "desktop only" error; the web shim handles the ones it can in the browser.
 * - `host`: changes server-wide configuration or the server host itself (providers and keys, extensions, MCP servers,
 *   registered folders, global settings). Admins and owners only.
 * - `read`: no side effects beyond reading. Viewers and up.
 * - `write`: everything else. Members and up, subject to per-project access.
 */
import { isCommandName } from '../../agent-app/src/main/commands.ts';
import type { OrgRole } from './store/types.ts';

export type CommandClass = 'read' | 'write' | 'host' | 'desktop';
export const ROLE_RANK: Record<OrgRole, number> = { owner: 4, admin: 3, member: 2, viewer: 1 };

const DESKTOP_EXACT = new Set([
  'updates.status', 'updates.check', 'updates.setAutoCheck', 'updates.install',
  'chat.contextMenu', 'folder.contextMenu', 'project.contextMenu',
  'folder.pick', 'git.clone.pickDestination', 'import.pickExport',
  'files.saveCopy', 'chat.export.file', 'project.export.file', 'files.trash', 'files.reveal',
  'files.openWith', 'files.openWith.apps', 'files.openFolderWith', 'files.openFolderWith.apps', 'files.external.reveal', 'files.external.openWith',
  'files.nativeAvailable', 'files.nativeShow', 'files.nativePosition', 'files.nativeHide',
  'clipboard.write', 'link.open', 'settings.reveal', 'providers.reveal', 'setup.openTerminal', 'setup.openSystemSettings',
  'plugins.ui.open', 'computer.permissions', 'computer.openPermissionSettings', 'computer.captureSources', 'computer.captureSource',
  'computer.accessibilityText', 'computer.image', 'computer.control', 'computer.lease', 'computer.focusApp', 'providers.captureStatus',
]);
/** Whole families that run on the desktop host: embedded browser, PTY terminals and host processes, Docker scoped computers. */
const DESKTOP_PREFIX = ['browser.', 'terminal.', 'processes.', 'computer.', 'musterServer.'];

const HOST_EXACT = new Set([
  // Wave 4: the server's agent API acts as one remote agent through these; people never call them.
  'project.remote.tasks', 'project.remote.task', 'project.remote.comment', 'project.remote.state', 'project.remote.doc',
  // Wave 4: SSH hosts and dev-server commands run on the server's own machine, so they are for owners and admins.
  'ssh.hosts.list', 'ssh.hosts.save', 'ssh.hosts.remove', 'ssh.hostkey.scan', 'ssh.hostkey.trust', 'ssh.test', 'ssh.chat.set', 'services.save', 'services.remove', 'services.start', 'services.stop',
  'org.export.write', 'backups.settings.set', 'backups.run', 'backups.restore', 'backups.restore.cancel', 'backups.remove',
  'settings.set', 'settings.reset', 'settings.import', 'settings.storage.cleanup', 'settings.folderModel.set',
  'providers.save', 'providers.remove', 'providers.check', 'providers.cancelCheck', 'providers.secret.set', 'providers.secret.clear',
  'providers.cli.update', 'providers.cli.rollback', 'providers.cli.cancel', 'providers.cli.check', 'providers.accounts.add', 'providers.accounts.remove',
  'extensions.sources.add', 'extensions.sources.sync', 'extensions.sources.remove', 'extensions.install', 'extensions.update', 'extensions.rollback',
  'extensions.uninstall', 'extensions.enablement.set', 'extensions.skills.save', 'extensions.skills.restore', 'skills.create',
  'mcp.servers.add', 'mcp.servers.update', 'mcp.servers.remove', 'mcp.servers.test', 'mcp.revoke', 'mcp.hooks.set',
  'memory.config.set', 'memory.config.test', 'memory.models.save', 'memory.models.delete', 'memory.models.clear', 'memory.models.refresh',
  'memory.bank.delete', 'memory.import.apply',
  'folder.add', 'folder.remove', 'folder.rename', 'folder.relink', 'folder.move', 'folder.reorder',
  'git.clone.start', 'git.clone.cancel', 'paperclip.config.set', 'paperclip.import', 'paperclip.ledger.backfill', 'import.run',
  'terminalAccess.set', 'setup.saveProgress', 'setup.refresh', 'models.policy.setHidden', 'models.policy.setPricing', 'models.policy.reset',
  'files.runActions.set', 'studio.skill.inputs.save', 'studio.skill.inputs.remove', 'automations.gate.decide', 'automations.webhook.rotate', 'work.inbox.read', 'work.inbox.snooze', 'work.inbox.decideBy', 'work.inbox.recommend', 'paperclip.test', 'paperclip.pauseAll', 'paperclip.resumeAll', 'paperclip.agent.pause', 'paperclip.agent.resume', 'paperclip.approval.decide', 'sandbox.syncFromHost', 'sandbox.applyToHost', 'sandbox.browserPlacement.set',
]);

/** Final segments of commands that only read. */
const READ_TAIL = new Set([
  'snapshot', 'list', 'get', 'status', 'timeline', 'search', 'read', 'readFull', 'preview', 'info', 'inspect', 'browse', 'stats', 'diff', 'changes',
  'log', 'blame', 'branches', 'events', 'catalog', 'inventory', 'installed', 'transcript', 'capabilities', 'usage', 'identity', 'query', 'latest',
  'runs', 'versions', 'version', 'asset', 'document', 'workbook', 'quickOpen', 'searchContent', 'conflicts', 'conflictFile', 'compare', 'refDiff',
  'commitDetail', 'headMessage', 'marks', 'baselines', 'fileDiff', 'checks', 'files', 'threads', 'conversation', 'repo', 'summary', 'tools', 'logs',
  'observations', 'jobs', 'archives', 'engine', 'offers', 'defaults', 'diagnostics', 'storage', 'badge', 'ledger', 'dashboard', 'sources', 'contextTelemetry',
  'export', 'worktree.list', 'defaultDestination', 'terminalShells', 'select', 'watch', 'pullRequests', 'compareUrl', 'diagnose', 'editOptions', 'editRestorePreview',
  'recall', 'plan', 'dismissed', 'checkLog', 'directives', 'detect', 'archives', 'deletes', 'authorize',
]);
const READ_EXACT = new Set(['org.imports.pending', 'services.previews', 'search.workspace', 'insight.costs', 'insight.profile', 'insight.reflect.inbox', 'studio.skill.fromTask', 'studio.skill.templates', 'work.overlay', 'work.project.meta', 'work.outputs.state', 'work.summaries.revision', 'work.inbox.state', 'automations.templates', 'project.gov.state', 'project.gov.task', 'project.gov.summary', 'project.agent.gov.get', 'project.secrets.list', 'project.secrets.audit', 'app.snapshot', 'chat.timeline', 'workspace.watch', 'git.status', 'git.changes', 'memory.list', 'memory.search', 'memory.inspect',
  'hindsight.status', 'hindsight.recall', 'plugins.list', 'plugins.inventory', 'providers.list', 'settings.get', 'settings.projectModel.get',
  'settings.folderModel.get', 'project.handoff.latest', 'project.work', 'paperclip.watch', 'git.info', 'git.worktree.list', 'providers.cli.status',
  'providers.secret.status', 'chat.defaults', 'project.tasks.list', 'project.decisions.list', 'project.activity.list', 'project.activity.query',
  'project.members.list', 'project.team.settings', 'project.chats.preview', 'project.sources.list', 'project.preview', 'project.stats',
  'mcp.servers.list', 'mcp.servers.tools', 'mcp.servers.logs', 'mcp.hooks.list', 'artifacts.canvas.list', 'artifacts.canvas.get', 'artifacts.canvas.versions',
  'artifacts.canvas.version', 'artifacts.sideChat.list', 'artifacts.read', 'goals.list', 'goals.get', 'mailbox.list', 'mailbox.get', 'stashes.list',
  'models.policy.get', 'models.usage.chat', 'models.usage.project', 'memory.status', 'memory.config.get', 'memory.directives.list', 'memory.deletes.list',
  'memory.models.list', 'memory.models.preview', 'memory.recall.preview', 'memory.bank.preview', 'memory.import.preview', 'setup.status', 'setup.progress',
  'sandbox.chatEnvironment.get', 'sandbox.changes', 'sandbox.fileDiff', 'terminalAccess.get', 'import.sources', 'import.list', 'import.preview',
  'automations.list', 'automations.runs', 'automations.preview', 'attachments.list', 'attachments.preview', 'attachments.info', 'attachments.read',
  'attachments.asset', 'attachments.document', 'attachments.workbook', 'files.list', 'files.search', 'files.read', 'files.asset', 'files.document',
  'files.workbook', 'files.annotations.list', 'files.runActions.list', 'files.external.inspect', 'extensions.sources.list', 'extensions.catalog',
  'extensions.inventory', 'extensions.review', 'extensions.installed', 'extensions.enablement.list', 'extensions.skills.read', 'ci.repair.list',
  'github.repo', 'github.pr.get', 'github.pr.checks', 'github.pr.files', 'github.pr.threads', 'github.pr.conversation', 'subagents.transcript',
  'subagents.capabilities', 'review.baselines', 'review.changes', 'review.fileDiff', 'review.marks', 'chat.search', 'chat.export', 'chat.select',
  'chat.contextTelemetry', 'chat.editOptions', 'chat.editRestorePreview', 'paperclip.config.get', 'paperclip.snapshot', 'paperclip.list', 'paperclip.badge',
  'paperclip.ledger', 'paperclip.dashboard', 'paperclip.memory', 'paperclip.task', 'paperclip.inbox.dismissed', 'paperclip.import.plan', 'project.list',
  'project.export', 'project.events', 'project.handoff.build', 'git.log', 'git.commitDetail', 'git.compare', 'git.refDiff', 'git.blame', 'git.branches',
  'git.headMessage', 'git.conflicts', 'git.conflictFile', 'git.diff', 'git.pullRequests', 'git.compareUrl', 'settings.export', 'settings.diagnostics',
  'settings.storage', 'settings.storage.preview', 'settings.terminalShells', 'providers.identity', 'providers.usage', 'providers.diagnose',
  'providers.accounts.list', 'memory.browse', 'memory.observations', 'memory.jobs', 'memory.archives', 'memory.engine', 'memory.offers', 'memory.export',
  'goals.budget', 'models.usage.chat',
]);

/** Writes whose last word looks like a read (a status is set, not read). */
const WRITE_EXACT = new Set(['work.outputs.status']);

export function classifyCommand(command: string): CommandClass | null {
  if (command.startsWith('server.')) return null; // server.* is dispatched by the server itself, never the runtime
  if (!isCommandName(command)) return null;
  if (DESKTOP_EXACT.has(command) || DESKTOP_PREFIX.some(p => command.startsWith(p))) return 'desktop';
  if (HOST_EXACT.has(command)) return 'host';
  if (WRITE_EXACT.has(command)) return 'write';
  if (READ_EXACT.has(command)) return 'read';
  const tail = command.slice(command.lastIndexOf('.') + 1);
  if (READ_TAIL.has(tail) && !/\.(set|add|create|delete|remove|update|start|run|send)$/.test(command)) return 'read';
  return 'write';
}

const CLASS_MIN: Record<Exclude<CommandClass, 'desktop'>, OrgRole> = { read: 'viewer', write: 'member', host: 'admin' };
export function minimumRole(cls: CommandClass): OrgRole | null { return cls === 'desktop' ? null : CLASS_MIN[cls]; }

export class PolicyError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); this.name = 'PolicyError'; }
}

const DESKTOP_LABEL: Array<[RegExp, string]> = [
  [/^browser\./, 'The built-in browser'], [/^terminal\.|^processes\.|^setup\.openTerminal/, 'Terminals and host commands'],
  [/^computer\./, 'Computer use and scoped computers'], [/^updates\./, 'App updates'], [/contextMenu$/, 'Native menus'],
  [/pick|saveCopy|export\.file/, 'Native file dialogs'], [/^files\.native/, 'Quick Look previews'], [/reveal|openWith|openFolderWith/, 'Opening files in other apps'],
];
export const desktopOnlyMessage = (command: string) =>
  `Desktop only: ${(DESKTOP_LABEL.find(([re]) => re.test(command))?.[1] ?? 'This action')} is available in the Muster desktop app, not on Muster Server.`;

/** Throws a PolicyError unless `role` may run `command`. Returns the command class. */
export function authorizeCommand(command: unknown, role: OrgRole): CommandClass {
  if (typeof command !== 'string' || command.length > 120) throw new PolicyError('Unknown command.', 400, 'unknown-command');
  const cls = classifyCommand(command);
  if (!cls) throw new PolicyError(`Unknown command "${command}".`, 400, 'unknown-command');
  if (cls === 'desktop') throw new PolicyError(desktopOnlyMessage(command), 501, 'desktop-only');
  const min = minimumRole(cls)!;
  if (ROLE_RANK[role] < ROLE_RANK[min]) throw new PolicyError(`Your role (${role}) cannot run ${command}; it needs ${min} or higher.`, 403, 'forbidden');
  return cls;
}
