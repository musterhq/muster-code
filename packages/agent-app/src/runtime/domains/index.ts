import type { DomainName } from '../../shared/domains/index.ts';
import type { DomainContext, DomainFactory, DomainHandler, DomainModule, DomainPowerEvent } from './types.ts';
import { createModelsDomain } from './models.ts';
import { createMemoryDomain } from './memory.ts';
import { createSettingsDomain } from './settings.ts';
import { createProjectsDomain } from './projects.ts';
import { createGitDomain } from './git.ts';
import { createSubagentsDomain } from './subagents.ts';
import { createReviewDomain } from './review.ts';
import { createAutomationsDomain } from './automations.ts';
import { createComputerDomain } from './computer.ts';
import { createProvidersDomain } from './providers.ts';
import { createExtensionsDomain } from './extensions.ts';
import { createFilesDomain } from './files.ts';
import { createSearchDomain } from './search.ts';
import { createMcpDomain } from './mcp.ts';
import { createArtifactsDomain } from './artifacts.ts';
import { createGoalsDomain } from './goals.ts';
import { createMailboxDomain } from './mailbox.ts';
import { createSandboxDomain } from './sandbox.ts';
import { createImportDomain } from './import.ts';
import { createGitHubDomain } from './github.ts';
import { createStashesDomain } from './stashes.ts';
import { createCiDomain } from './ci.ts';
import { createTerminalDomain } from './terminal.ts';
import { createSetupDomain } from './setup.ts';

export const DOMAIN_FACTORIES: Record<DomainName, DomainFactory> = {models: createModelsDomain, memory: createMemoryDomain, settings: createSettingsDomain, projects: createProjectsDomain, git: createGitDomain, subagents: createSubagentsDomain, review: createReviewDomain, automations: createAutomationsDomain, computer: createComputerDomain, providers: createProvidersDomain, extensions: createExtensionsDomain, files: createFilesDomain, search: createSearchDomain, mcp: createMcpDomain, artifacts: createArtifactsDomain, goals: createGoalsDomain, mailbox: createMailboxDomain, sandbox: createSandboxDomain, 'import': createImportDomain, stashes: createStashesDomain, github: createGitHubDomain, ci: createCiDomain, terminal: createTerminalDomain, setup: createSetupDomain};

/** Builds every domain (plus `extra`, used by tests) and merges their handlers. A duplicate command name is a startup error. */
export function createDomains(context: DomainContext, extra: readonly DomainFactory[] = []) {
  const modules: DomainModule[] = [];
  const handlers = new Map<string, DomainHandler>();
  for (const factory of [...Object.values(DOMAIN_FACTORIES), ...extra]) {
    const module = factory(context);
    modules.push(module);
    for (const [command, handler] of Object.entries(module.handlers)) {
      if (handlers.has(command)) throw new Error(`Domain command ${command} is registered twice.`);
      handlers.set(command, handler);
    }
  }
  return {
    handlers,
    async dispose(): Promise<void> { await Promise.allSettled(modules.map(module => module.dispose?.())); },
    /** SBX-13: one domain failing its sleep/wake hook never blocks the others. */
    async power(event: DomainPowerEvent): Promise<void> {
      const results = await Promise.allSettled(modules.map(async module => module.power?.(event)));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}
