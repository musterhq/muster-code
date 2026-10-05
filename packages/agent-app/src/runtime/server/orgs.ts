/**
 * Every org (company) the signed-in person belongs to on the server (#117). The workspace snapshot shows one org at a time (the one Projects,
 * Roster and Ledger are about); this reads all the ticked ones side by side so the sidebar, My work and the Inbox can show the person's own
 * work in each. It reuses the one `ServerBackend` (same token, same ETag cache), never opens another connection, and reads nothing for an org
 * the person unticked.
 */
import type { WorkspaceCompany } from '../../shared/domains/paperclip-protocol.ts';
import type { MyWorkTask, OrgEntry, OrgsList, OrgWork } from '../../shared/domains/checkout-protocol.ts';
import { groupByProject, leadAgentIds, mineOnly, normalizeOrgSetting, projectCounts, scopeInbox, workTasks, type Me, type OrgSetting } from '../../shared/org-work.ts';
import type { ServerBackend, ServerPart } from './backend.ts';

export interface OrgReaderDeps {
  backend(): ServerBackend | null;
  settings(): Readonly<Record<string, OrgSetting | undefined>>;
  /** The company the workspace snapshot is about right now. */
  activeId(): string | null;
  /** Where the orgs live (the server's host), shown beside each. */
  serverLabel(): string;
  /** An open check-out for a task, as the badge a row shows. */
  badge?(taskId: string): MyWorkTask['checkout'];
  /** The person this Mac signed in as, kept in server.json: used when the server cannot be asked, and saved when it answers. */
  remembered?(): Me | null;
  remember?(person: Me): void;
}

export class OrgReader {
  private companies: WorkspaceCompany[] = [];
  private readonly parts = new Map<string, { generation: number; part: ServerPart }>();
  private readonly stale = new Map<string, string>();
  constructor(private readonly deps: OrgReaderDeps) {}

  /** Forget what was read (the connection changed). */
  reset(): void { this.companies = []; this.parts.clear(); this.stale.clear(); }

  /** The person as last saved (no network). */
  remembered(): Me | null { return this.deps.remembered?.() ?? null; }
  async me(): Promise<Me | null> {
    const backend = this.deps.backend();
    const person = backend?.whoami ? await backend.whoami().catch(() => null) : null;
    if (person) { const me = { id: person.id, name: person.name }; this.deps.remember?.(me); return me; }
    return backend?.whoami ? this.deps.remembered?.() ?? null : null;
  }
  /** The orgs as last listed (no network): what offline work falls back to. */
  knownOrgs(): WorkspaceCompany[] { return this.companies; }
  async orgs(): Promise<WorkspaceCompany[]> {
    const backend = this.deps.backend();
    if (!backend) return [];
    this.companies = await backend.companies();
    return this.companies;
  }
  /** One org's part, revalidated (a conditional read), with the last good copy kept for when the server is unreachable. */
  async part(company: WorkspaceCompany, fresh = false): Promise<ServerPart> {
    const backend = this.deps.backend();
    if (!backend) throw new Error('Muster Server is not connected.');
    const had = this.parts.get(company.id);
    try {
      const part = await backend.read(company, had ? { generation: backend.generation, companyId: company.id, part: had.part } : undefined, { fresh });
      this.parts.set(company.id, { generation: backend.generation, part }); this.stale.delete(company.id);
      return part;
    } catch (cause) {
      this.stale.set(company.id, cause instanceof Error ? cause.message : String(cause));
      if (had) return had.part;
      throw cause;
    }
  }
  /** The last good part for an org, if any (no network). */
  cached(companyId: string): ServerPart | undefined { return this.parts.get(companyId)?.part; }
  staleOf(companyId: string): string | undefined { return this.stale.get(companyId); }

  /** The list for Settings: every org on the server with its settings (counts come from the last read, so listing never reads each org). */
  async list(): Promise<OrgsList> {
    const backend = this.deps.backend();
    if (!backend) return { connected: false, server: null, me: null, orgs: [] };
    const [companies, me] = await Promise.all([this.orgs(), this.me()]);
    const settings = this.deps.settings(), active = this.deps.activeId() ?? companies[0]?.id ?? null, server = this.deps.serverLabel();
    const orgs: OrgEntry[] = await Promise.all(companies.map(async c => {
      // The first time an org is listed its counts are unknown: read it once (conditional on later calls) so Settings can say "5 projects · 17 agents".
      const part = this.cached(c.id) ?? await this.part(c).catch(() => undefined), s = normalizeOrgSetting(settings[c.id]);
      return { id: c.id, name: c.name, prefix: c.prefix, server, projects: part?.projects.length ?? 0, agents: part?.agents.length ?? 0, enabled: s.enabled, sidebar: s.sidebar, active: c.id === active };
    }));
    return { connected: true, server, me: me ? { id: me.id, name: me.name } : null, orgs };
  }

  /** The person's work in one org's part, by the rules in shared/org-work.ts. */
  build(company: WorkspaceCompany, part: ServerPart, me: Me | null, setting: OrgSetting): OrgWork {
    const mode = setting.sidebar === 'none' ? 'mine' : setting.sidebar;
    const reporting = { agentIds: leadAgentIds(me, part.tasks, part.agents) };
    const rows = workTasks(part.tasks, me, mode, reporting);
    const projectName = new Map(part.projects.map(p => [p.id, p.name]));
    const counts = projectCounts(rows);
    const server = this.deps.serverLabel();
    const tasks: MyWorkTask[] = rows.map(({ task, why }) => ({
      id: task.id, key: task.key, title: task.title, status: task.status, priority: task.priority, orgId: company.id, orgName: company.name, projectId: task.projectId, projectName: task.projectId ? projectName.get(task.projectId) ?? null : null,
      createdAt: task.createdAt, updatedAt: task.updatedAt, why, assignee: why === 'team' ? task.assigneeLabel : null, checkout: this.deps.badge?.(task.id) ?? null,
    }));
    const inbox = scopeInbox(part.inbox, part.tasks, me, { team: setting.sidebar === 'team', reporting }).map(item => ({ ...item, org: { id: company.id, name: company.name } }));
    const stale = this.stale.get(company.id);
    return {
      org: { id: company.id, name: company.name, prefix: company.prefix, server }, sidebar: setting.sidebar, open: mineOnly(rows).length, tasks,
      projects: part.projects.filter(p => p.status !== 'archived').map(p => ({ id: p.id, name: p.name, open: counts.get(p.id) ?? 0 })).sort((a, b) => a.name.localeCompare(b.name)), inbox, ...(stale ? { stale } : {}),
    };
  }

  /** Every ticked org, read side by side (one failing org shows its last copy, or nothing, and never blocks the others). */
  async work(fresh = false): Promise<{ me: Me | null; orgs: OrgWork[] }> {
    const [companies, me] = await Promise.all([this.orgs(), this.me()]);
    const settings = this.deps.settings();
    const enabled = companies.filter(c => normalizeOrgSetting(settings[c.id]).enabled);
    const built = await Promise.all(enabled.map(async company => {
      const setting = normalizeOrgSetting(settings[company.id]);
      try { return this.build(company, await this.part(company, fresh), me, setting); }
      catch (cause) {
        const part = this.cached(company.id);
        if (part) return this.build(company, part, me, setting);
        return { org: { id: company.id, name: company.name, prefix: company.prefix, server: this.deps.serverLabel() }, sidebar: setting.sidebar, open: 0, tasks: [], projects: [], inbox: [], stale: cause instanceof Error ? cause.message : String(cause) } as OrgWork;
      }
    }));
    return { me, orgs: built };
  }

  /** Server Inbox items of the ticked orgs OTHER than the one the snapshot already has, scoped to what asks the person. */
  async otherInbox(exceptId: string | null, fresh = false): Promise<import('../../shared/domains/paperclip-protocol.ts').WorkspaceInboxItem[]> {
    const [companies, me] = await Promise.all([this.orgs(), this.me()]);
    const settings = this.deps.settings();
    const rows = await Promise.all(companies.filter(c => c.id !== exceptId && normalizeOrgSetting(settings[c.id]).enabled).map(async company => {
      const part = await this.part(company, fresh).catch(() => this.cached(company.id));
      return part ? this.build(company, part, me, normalizeOrgSetting(settings[company.id])).inbox : [];
    }));
    return rows.flat();
  }
}
export { groupByProject };

// --- one registry per runtime, so the checkout domain reaches the reader the workspace domain built -------------------------------------
export interface ServerHub {
  reader: OrgReader | null; backend: (() => ServerBackend | null) | null;
  /** The open check-out of a task, for the badge on its row (set by the checkout domain). */
  badge?: (taskId: string) => MyWorkTask['checkout'];
  /** The server answered again after being unreachable: queued posts are sent (set by the checkout domain). */
  onOnline?: () => void;
}
const hubs = new WeakMap<object, ServerHub>();
export function serverHubFor(context: object): ServerHub {
  let hub = hubs.get(context);
  if (!hub) { hub = { reader: null, backend: null }; hubs.set(context, hub); }
  return hub;
}
