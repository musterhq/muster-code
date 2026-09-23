/** Every domain's commands and events, merged. Waves add domains without touching protocol.ts or main/commands.ts. */
import {type ModelsCommands, type ModelsEvent, MODELS_COMMANDS} from './models-protocol.ts';
import {type MemoryCommands, type MemoryEvent, MEMORY_COMMANDS} from './memory-protocol.ts';
import {type SettingsCommands, type SettingsEvent, SETTINGS_COMMANDS} from './settings-protocol.ts';
import {type ProjectsCommands, type ProjectsEvent, PROJECTS_COMMANDS} from './projects-protocol.ts';
import {type GitCommands, type GitEvent, GIT_COMMANDS} from './git-protocol.ts';
import {type SubagentsCommands, type SubagentsEvent, SUBAGENTS_COMMANDS} from './subagents-protocol.ts';
import {type ReviewCommands, type ReviewEvent, REVIEW_COMMANDS} from './review-protocol.ts';
import {type AutomationsCommands, type AutomationsEvent, AUTOMATIONS_COMMANDS} from './automations-protocol.ts';
import {type ComputerCommands, type ComputerEvent, COMPUTER_COMMANDS} from './computer-protocol.ts';
import {type ProvidersCommands, type ProvidersEvent, PROVIDERS_COMMANDS} from './providers-protocol.ts';
import {type ExtensionsCommands, type ExtensionsEvent, EXTENSIONS_COMMANDS} from './extensions-protocol.ts';
import {type FilesCommands, type FilesEvent, FILES_COMMANDS} from './files-protocol.ts';
import {type SearchCommands, type SearchEvent, SEARCH_COMMANDS} from './search-protocol.ts';
import {type McpCommands, type McpEvent, MCP_COMMANDS} from './mcp-protocol.ts';
import {type ArtifactsCommands, type ArtifactsEvent, ARTIFACTS_COMMANDS} from './artifacts-protocol.ts';
import {type GoalsCommands, type GoalsEvent, GOALS_COMMANDS} from './goals-protocol.ts';
import {type MailboxCommands, type MailboxEvent, MAILBOX_COMMANDS} from './mailbox-protocol.ts';
import {type SandboxCommands, type SandboxEvent, SANDBOX_COMMANDS} from './sandbox-protocol.ts';
import {type ImportCommands, type ImportEvent, IMPORT_COMMANDS} from './import-protocol.ts';
import {type GitHubCommands, type GitHubEvent, GITHUB_COMMANDS} from './github-protocol.ts';
import {type StashesCommands, type StashesEvent, STASHES_COMMANDS} from './stashes-protocol.ts';
import {type CiCommands, type CiEvent, CI_COMMANDS} from './ci-protocol.ts';
import {type TerminalCommands, type TerminalEvent, TERMINAL_COMMANDS} from './terminal-protocol.ts';

export interface DomainCommands extends ModelsCommands, MemoryCommands, SettingsCommands, ProjectsCommands, GitCommands, SubagentsCommands, ReviewCommands, AutomationsCommands, ComputerCommands, ProvidersCommands, ExtensionsCommands, FilesCommands, SearchCommands, McpCommands, ArtifactsCommands, GoalsCommands, MailboxCommands, SandboxCommands, ImportCommands, StashesCommands, GitHubCommands, CiCommands, TerminalCommands {}
export type DomainEvent = ModelsEvent | MemoryEvent | SettingsEvent | ProjectsEvent | GitEvent | SubagentsEvent | ReviewEvent | AutomationsEvent | ComputerEvent | ProvidersEvent | ExtensionsEvent | FilesEvent | SearchEvent | McpEvent | ArtifactsEvent | GoalsEvent | MailboxEvent | SandboxEvent | ImportEvent | StashesEvent | GitHubEvent | CiEvent | TerminalEvent;
export const DOMAIN_COMMANDS = {...MODELS_COMMANDS, ...MEMORY_COMMANDS, ...SETTINGS_COMMANDS, ...PROJECTS_COMMANDS, ...GIT_COMMANDS, ...SUBAGENTS_COMMANDS, ...REVIEW_COMMANDS, ...AUTOMATIONS_COMMANDS, ...COMPUTER_COMMANDS, ...PROVIDERS_COMMANDS, ...EXTENSIONS_COMMANDS, ...FILES_COMMANDS, ...SEARCH_COMMANDS, ...MCP_COMMANDS, ...ARTIFACTS_COMMANDS, ...GOALS_COMMANDS, ...MAILBOX_COMMANDS, ...SANDBOX_COMMANDS, ...IMPORT_COMMANDS, ...STASHES_COMMANDS, ...GITHUB_COMMANDS, ...CI_COMMANDS, ...TERMINAL_COMMANDS} as const satisfies Record<keyof DomainCommands, true>;
export const DOMAIN_NAMES = ['models', 'memory', 'settings', 'projects', 'git', 'subagents', 'review', 'automations', 'computer', 'providers', 'extensions', 'files', 'search', 'mcp', 'artifacts', 'goals', 'mailbox', 'sandbox', 'import', 'stashes', 'github', 'ci', 'terminal'] as const;
export type DomainName = typeof DOMAIN_NAMES[number];
