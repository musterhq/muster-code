/**
 * The org domain (Wave 4: G16 export and import, G17 teams catalog). Contract: shared/domains/org-protocol.ts.
 * Everything goes through the same commands the app uses (members, governance, tasks, automations). Those inner calls are NOT re-checked by a
 * server's role policy (only the outer org.import.* command is), so the import itself keeps to least privilege: agents arrive paused, with the
 * default permissions and no tool rules, unless the person confirmed what the package asks for. Event-driven: nothing here runs on its own.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import catalogJson from '../catalogs/teams-catalog.json' with { type: 'json' };
import { DEFAULT_CAPABILITIES } from '../../shared/domains/project-governance-protocol.ts';
import { DEFAULT_AGENT_ID } from '../../shared/domains/project-team-protocol.ts';
import type { AutomationView } from '../../shared/domains/automations-protocol.ts';
import type { CatalogTeam, OrgExport, OrgImportOptions, OrgImportResult, OrgPending, OrgPermissions, OrgPreview, OrgPreviewAgent, OrgSource } from '../../shared/domains/org-protocol.ts';
import { dumpDoc, dumpYaml, readPackage, slugify, unzipFiles, zipFiles, ZIP_LIMITS, type PkgModel, type Yaml } from '../org/agent-companies.ts';
import type { DomainContext, DomainModule } from './types.ts';

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const id = (v: unknown, field = 'id'): string => { if (typeof v !== 'string' || !ID.test(v)) throw new Error(`Invalid ${field}.`); return v; };
const uniq = (base: string, taken: Set<string>) => { let s = base, n = 2; while (taken.has(s)) s = `${base}-${n++}`; taken.add(s); return s; };
const OPEN_STATES = new Set(['backlog', 'todo', 'blocked', 'failed', 'review']);
interface CatalogEntry { key: string; kind: 'bundled' | 'optional'; category: string; slug: string; name: string; description: string; tags: string[]; files: Record<string, string> }
const CATALOG = (catalogJson as unknown as { teams: CatalogEntry[] }).teams;
const SCHEDULE_DEFAULT = { kind: 'daily', time: '09:00', days: [1] } as const;
type Member = { id: string; name: string; kind: string; role: string; title?: string | null; reportsTo?: string | null; runner?: { providerId: string; model: string } | null; instructions?: string; revokedAt: string | null; pendingAt?: string | null; pausedAt?: string | null; secrets: string[] };

export function createOrgDomain(ctx: DomainContext): DomainModule {
  const inv = <T = unknown>(command: string, input: Record<string, unknown>): Promise<T> => ctx.invoke(command as never, input as never) as Promise<T>;
  const importsFile = join(ctx.dataDir, 'muster-org-imports.json');
  type Imports = Record<string, { agents: string[]; routines: string[] }>;
  const readImports = (): Imports => { try { return JSON.parse(readFileSync(importsFile, 'utf8')) as Imports; } catch { return {}; } };
  const writeImports = (v: Imports) => { const tmp = `${importsFile}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 }); renameSync(tmp, importsFile); try { chmodSync(importsFile, 0o600); } catch { /* no modes */ } };
  const members = async (projectId: string) => ((await inv<{ members: Member[] }>('project.members.list', { projectId })).members);
  const activeAgents = (list: Member[]) => list.filter(m => m.kind === 'agent' && m.id !== DEFAULT_AGENT_ID && !m.revokedAt);
  const providers = () => ctx.modelCatalog?.().providers ?? [];
  const projectOf = async (projectId: string) => { const p = (await inv<{ id: string; name: string; goal?: string }[]>('project.list', {})).find(x => x.id === projectId); if (!p) throw new Error('Project not found.'); return p; };

  // ── export ────────────────────────────────────────────────────────────────
  async function buildExport(projectId: string, includeTasks: boolean, includeRoutines: boolean): Promise<{ files: Record<string, string>; name: string; slug: string; warnings: string[] }> {
    const project = await projectOf(projectId), list = activeAgents(await members(projectId)).filter(m => !m.pendingAt), warnings: string[] = [];
    const taken = new Set<string>(), slugOf = new Map<string, string>();
    for (const m of list) slugOf.set(m.id, uniq(slugify(m.name), taken));
    const files: Record<string, string> = {}, agentExt: Record<string, Yaml> = {}, secrets = new Set<string>();
    for (const m of list) {
      const slug = slugOf.get(m.id)!;
      const view = await inv<{ governance: { capabilities: Yaml; heartbeat: Yaml; toolRules: { match: string; pattern: string; effect: string; note?: string }[] }; files: { name: string; text: string }[] }>('project.agent.gov.get', { projectId, memberId: m.id });
      files[`agents/${slug}/AGENTS.md`] = dumpDoc({ name: m.name, slug, title: m.title ?? null, reportsTo: m.reportsTo ? slugOf.get(m.reportsTo) ?? null : null, skills: [] }, m.instructions ?? '');
      for (const f of view.files) if (f.name !== 'AGENTS.md' && f.text.trim()) files[`agents/${slug}/${f.name}`] = f.text;
      agentExt[slug] = { ...(m.runner ? { runner: { providerId: m.runner.providerId, model: m.runner.model } } : {}), capabilities: view.governance.capabilities, heartbeat: view.governance.heartbeat, ...(view.governance.toolRules.length ? { toolRules: view.governance.toolRules.map(r => ({ match: r.match, pattern: r.pattern, effect: r.effect })) } : {}) };
      for (const s of m.secrets) secrets.add(s);
    }
    const routines: Record<string, Yaml> = {}, tslugs = new Set<string>();
    if (includeTasks) {
      const work = await inv<{ tasks: { items: { title: string; acceptance: string; owner: { kind: string; id: string }; priority: number; state: string }[] } }>('project.work', { projectId, activityLimit: 1 });
      for (const t of work.tasks.items.filter(x => OPEN_STATES.has(x.state))) {
        const slug = uniq(slugify(t.title), tslugs), assignee = t.owner.kind === 'agent' ? slugOf.get(t.owner.id) ?? null : null;
        files[`tasks/${slug}/TASK.md`] = dumpDoc({ name: t.title, slug, assignee, priority: t.priority }, t.acceptance || t.title);
      }
    }
    if (includeRoutines) {
      const autos = (await inv<AutomationView[]>('automations.list', {} as never)).filter(a => a.target.kind === 'task' && a.target.projectId === projectId);
      for (const a of autos) {
        const slug = uniq(slugify(a.name), tslugs), t = a.target as Extract<AutomationView['target'], { kind: 'task' }>, assignee = t.assigneeId?.startsWith('member:') ? slugOf.get(t.assigneeId.slice(7)) ?? null : null;
        files[`tasks/${slug}/TASK.md`] = dumpDoc({ name: a.name, slug, assignee, recurring: true }, a.prompt);
        routines[slug] = { schedule: a.schedule as unknown as Yaml, timezone: a.timezone, ...(t.titleTemplate ? { titleTemplate: t.titleTemplate } : {}) };
      }
    }
    const slug = slugify(project.name);
    files['COMPANY.md'] = dumpDoc({ name: project.name, slug, description: (project.goal ?? '').split('\n')[0]!.slice(0, 200), schema: 'agentcompanies/v1', version: '1.0.0', goals: project.goal ? [project.goal.slice(0, 500)] : [], ...(secrets.size ? { requirements: { secrets: [...secrets].sort() } } : {}) }, project.goal || `The ${project.name} project.`);
    files['.muster.yaml'] = `${dumpYaml({ schema: 'muster/v1', agents: agentExt, ...(Object.keys(routines).length ? { routines } : {}) })}\n`;
    files['README.md'] = `# ${project.name}\n\nAn Agent Companies package exported from Muster (\`agentcompanies/v1\`). Import it from a project's Roster or with \`muster-server org import\`.\n\n- ${list.length} agent${list.length === 1 ? '' : 's'}\n- ${Object.keys(files).filter(f => f.startsWith('tasks/')).length} task or routine file(s)\n\nSecret values, git identities and local paths are not part of the package.\n`;
    if (list.some(m => m.secrets.length)) warnings.push('Agents hold secrets; only the names are listed under requirements.secrets, never the values.');
    if (!list.length) warnings.push('This project has no agents of its own to export.');
    warnings.push('Skills are not exported; install them from the Skills page.');
    return { files, name: project.name, slug, warnings };
  }
  const sizes = (files: Record<string, string>) => Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text) }));

  // ── import ────────────────────────────────────────────────────────────────
  function loadSource(source: OrgSource): { files: Record<string, string>; label: string; catalog?: CatalogEntry } {
    if (source.kind === 'catalog') { const t = CATALOG.find(x => x.key === source.key); if (!t) throw new Error('That team is not in the catalog.'); return { files: t.files, label: t.name, catalog: t }; }
    if (source.kind === 'zip') {
      if (typeof source.base64 !== 'string' || source.base64.length > Math.ceil(ZIP_LIMITS.totalBytes * 4 / 3) + 64) throw new Error('The package is too large to import.');
      return { files: unzipFiles(Buffer.from(source.base64, 'base64')), label: 'a zip package' };
    }
    if (source.kind === 'folder') {
      const dir = resolve(String(source.path ?? ''));
      if (!isAbsolute(String(source.path ?? '')) || !existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('Choose an existing folder (an absolute path).');
      const out: Record<string, string> = {}; let total = 0, count = 0;
      const walk = (d: string) => { for (const n of readdirSync(d, { withFileTypes: true })) {
        if (n.name === 'node_modules' || n.name === '.git') continue;
        const p = join(d, n.name);
        if (n.isSymbolicLink()) continue;
        if (n.isDirectory()) { walk(p); continue; }
        if (!/\.(md|ya?ml|json|txt)$/i.test(n.name)) continue;
        const size = statSync(p).size; if (size > ZIP_LIMITS.fileBytes || (total += size) > ZIP_LIMITS.totalBytes || ++count > ZIP_LIMITS.files) throw new Error('The folder is too large to import.');
        out[relative(dir, p).split('\\').join('/')] = readFileSync(p, 'utf8');
      } };
      walk(dir);
      return { files: out, label: basename(dir) };
    }
    throw new Error('Choose a zip, a folder or a catalog team.');
  }
  const scheduleText = (s: unknown): string => { const x = s as { kind?: string; time?: string; days?: number[]; minutes?: number; expr?: string } | undefined; if (!x?.kind) return 'Mondays at 09:00'; return x.kind === 'daily' ? `${(x.days ?? []).length === 7 || !(x.days ?? []).length ? 'every day' : `on ${(x.days ?? []).map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}`} at ${x.time}` : x.kind === 'interval' ? `every ${x.minutes} minutes` : x.kind === 'cron' ? `cron ${x.expr}` : x.kind; };
  function runnerFor(e: { [k: string]: Yaml }): { runner: { providerId: string; model: string } | null; note: string | null } {
    const r = e.runner && typeof e.runner === 'object' && !Array.isArray(e.runner) ? e.runner as { providerId?: Yaml; model?: Yaml } : null;
    if (!r || typeof r.providerId !== 'string' || typeof r.model !== 'string') return { runner: null, note: null };
    const p = providers().find(x => x.id === r.providerId && x.available);
    if (!p) return { runner: null, note: `${r.providerId} is not set up here: it will use the project's default runner.` };
    if (!p.models.some(m => m.id === r.model)) return { runner: null, note: `${r.model} is not offered by ${p.name}: it will use the project's default runner.` };
    return { runner: { providerId: r.providerId, model: r.model }, note: null };
  }
  /** What a package asks for an agent, read the same way apply reads it. */
  function askedFor(ext: { [k: string]: Yaml }): { caps: Record<string, unknown> | null; toolRules: unknown[]; summary: OrgPermissions | null } {
    const obj = (v: Yaml | undefined) => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, Yaml> : null;
    const c = obj(ext.capabilities), perms = obj(ext.permissions);
    const caps = c ? { canHire: c.canHire === true, canAssign: c.canAssign === true, ...(typeof c.assignScope === 'string' ? { assignScope: c.assignScope } : {}), ...(typeof c.trust === 'string' ? { trust: c.trust } : {}), ...(typeof c.containment === 'string' ? { containment: c.containment } : {}) }
      : perms ? { canHire: perms.canCreateAgents === true } : null;
    const toolRules = Array.isArray(ext.toolRules) ? ext.toolRules as unknown[] : [];
    const summary = caps || toolRules.length ? { ...DEFAULT_CAPABILITIES, ...caps, toolRules: toolRules.length } as OrgPermissions : null;
    return { caps, toolRules, summary };
  }
  const isPrivileged = (p: OrgPermissions | null) => !!p && (p.canHire !== DEFAULT_CAPABILITIES.canHire || p.canAssign !== DEFAULT_CAPABILITIES.canAssign || p.assignScope !== DEFAULT_CAPABILITIES.assignScope || p.trust !== DEFAULT_CAPABILITIES.trust || p.containment !== DEFAULT_CAPABILITIES.containment || p.toolRules > 0);
  async function plan(o: OrgImportOptions) {
    const src = loadSource(o.source), model = readPackage(src.files);
    const existing = o.projectId ? activeAgents(await members(id(o.projectId, 'project id'))) : [];
    const picked = o.agents ? new Set(o.agents) : null, pkgAgents = model.agents.filter(a => !picked || picked.has(a.slug));
    const agents: OrgPreviewAgent[] = pkgAgents.map(a => {
      const hit = existing.find(m => m.name.toLowerCase() === a.name.toLowerCase()), rn = runnerFor(a.ext);
      return { slug: a.slug, name: a.name, title: a.title, reportsTo: a.reportsTo, action: hit ? 'collision' : 'create', existingId: hit?.id ?? null, runner: rn.runner, runnerNote: rn.note, instructionsChars: a.instructions.length, permissions: askedFor(a.ext).summary };
    });
    const includeTasks = o.includeTasks !== false, includeRoutines = o.includeRoutines !== false;
    const tasks = model.tasks.filter(t => (t.recurring ? includeRoutines : includeTasks) && (!t.assignee || !picked || picked.has(t.assignee))).map(t => ({ slug: t.slug, name: t.name, assignee: t.assignee, recurring: t.recurring, schedule: t.recurring ? scheduleText(t.ext.schedule ?? SCHEDULE_DEFAULT) : null }));
    const project = o.projectId ? await projectOf(o.projectId) : null;
    const notes = [...model.ignored];
    if (!o.activate) notes.unshift(`${agents.length ? 'Agents' : ''}${agents.length && tasks.some(t => t.recurring) ? ' and ' : ''}${tasks.some(t => t.recurring) ? 'routines' : ''} start paused; you start them from the Activate panel.`.replace(/^ and /, ''));
    else if (tasks.some(t => t.recurring)) notes.unshift('Routines start paused; you start them from the Activate panel.');
    const clash = agents.filter(a => a.action === 'collision'); if (clash.length) notes.push(`${clash.length} agent${clash.length === 1 ? ' has' : 's have'} the same name as one already here (${clash.slice(0, 3).map(a => a.name).join(', ')}): choose to skip, rename or replace.`);
    for (const a of agents) if (a.runnerNote) notes.push(`${a.name}: ${a.runnerNote}`);
    const preview: OrgPreview = { package: { kind: model.kind, name: model.name, slug: model.slug, description: model.description.slice(0, 400) }, target: { kind: project ? 'existing' : 'new', projectId: project?.id ?? null, name: project?.name ?? o.name?.trim() ?? model.name },
      agents, tasks, skills: model.skills.length, secrets: model.requirements.secrets, privileged: agents.some(a => isPrivileged(a.permissions)), notes };
    if (preview.privileged) notes.push(src.catalog ? 'Some agents can hire or assign work: this team is bundled with Muster, so its permissions are applied.' : 'Some agents ask for more than the default permissions (hiring, assigning work, trust or tool rules). They get the defaults unless you choose to apply what the package asks for.');
    if (model.requirements.secrets.length) notes.push(`It needs these secrets, which are not included: ${model.requirements.secrets.join(', ')}. Add them under the project's Secrets.`);
    return { preview, model, pkgAgents, tasks, src, includeTasks, includeRoutines };
  }

  async function apply(o: OrgImportOptions): Promise<OrgImportResult> {
    const { preview, model, pkgAgents, src, includeTasks, includeRoutines } = await plan(o);
    const strategy = o.collision ?? 'skip', imported = (o.permissions ?? (src.catalog ? 'imported' : 'least')) === 'imported';
    if (o.permissions !== undefined && o.permissions !== 'least' && o.permissions !== 'imported') throw new Error('Choose least or imported for permissions.');
    if (!['skip', 'rename', 'replace'].includes(strategy)) throw new Error('Choose skip, rename or replace for agents that already exist.');
    let projectId = o.projectId ? id(o.projectId, 'project id') : null;
    const notes = [...preview.notes];
    if (!projectId) {
      const name = (o.name?.trim() || model.name).slice(0, 120);
      projectId = (await inv<{ id: string }>('project.create', { name, goal: model.description.slice(0, 2000), folderIds: [] })).id;
    }
    const existing = activeAgents(await members(projectId)), taken = new Set(existing.map(m => m.name.toLowerCase()));
    const idOf = new Map<string, string>(), created: OrgImportResult['created'] = [], replaced: OrgImportResult['replaced'] = [], skipped: OrgImportResult['skipped'] = [], newIds: string[] = [], touchedIds: string[] = [];
    for (const a of pkgAgents) {
      const rn = runnerFor(a.ext), hit = existing.find(m => m.name.toLowerCase() === a.name.toLowerCase());
      const profile = { ...(a.title ? { title: a.title } : {}), instructions: a.instructions, ...(rn.runner ? { runner: rn.runner } : {}) };
      let member: { id: string; name: string } | null = null;
      if (hit && strategy === 'skip') { skipped.push({ slug: a.slug, name: a.name, reason: 'an agent with this name is already here' }); idOf.set(a.slug, hit.id); continue; }
      // A replaced agent may be mid-run with its old instructions: stop it before changing them. It starts again from the Activate panel.
      if (hit && strategy === 'replace') { await inv('project.members.pause', { projectId, id: hit.id, paused: true }); touchedIds.push(hit.id); member = await inv<{ id: string; name: string }>('project.members.update', { projectId, id: hit.id, ...profile }); replaced.push({ slug: a.slug, id: member.id, name: member.name }); }
      else {
        let name = a.name, n = 2; while (taken.has(name.toLowerCase())) name = `${a.name} (${n++})`;
        taken.add(name.toLowerCase());
        member = await inv<{ id: string; name: string }>('project.members.add', { projectId, name, kind: 'agent', role: 'agent', ...profile });
        created.push({ slug: a.slug, id: member.id, name: member.name }); newIds.push(member.id); touchedIds.push(member.id);
        // Paused before anything below can arm a heartbeat for it.
        await inv('project.members.pause', { projectId, id: member.id, paused: true });
      }
      idOf.set(a.slug, member.id);
      const asked = askedFor(a.ext), gov: Record<string, unknown> = {};
      // Least privilege unless the person confirmed what the package asks for. A replaced agent keeps the permissions it already has.
      if (imported && asked.caps) gov.capabilities = asked.caps;
      else if (!imported && !(hit && strategy === 'replace')) gov.capabilities = { ...DEFAULT_CAPABILITIES };
      if (a.ext.heartbeat && typeof a.ext.heartbeat === 'object' && !Array.isArray(a.ext.heartbeat)) gov.heartbeat = a.ext.heartbeat;
      if (imported && asked.toolRules.length) gov.toolRules = asked.toolRules;
      if (Object.keys(gov).length) { try { await inv('project.agent.gov.set', { projectId, memberId: member.id, ...gov }); } catch (e) { notes.push(`${a.name}: permissions were not applied (${e instanceof Error ? e.message : 'error'}).`); } }
      for (const [name, text] of Object.entries(a.files)) if (name !== 'AGENTS.md') { try { await inv('project.agent.files.save', { projectId, memberId: member.id, name, text, note: 'Imported from a package' }); } catch (e) { notes.push(`${a.name}: ${name} was not imported (${e instanceof Error ? e.message : 'error'}).`); } }
    }
    // Reporting lines resolve after everyone exists; a team installed under a manager hangs its root agents off that manager.
    for (const a of pkgAgents) {
      const mine = idOf.get(a.slug); if (!mine || !newIds.includes(mine) && !replaced.some(r => r.id === mine)) continue;
      const boss = a.reportsTo ? idOf.get(a.reportsTo) : (o.attachTo && (model.manager === a.slug || !a.reportsTo) ? o.attachTo : undefined);
      if (boss && boss !== mine) { try { await inv('project.members.update', { projectId, id: mine, reportsTo: boss }); } catch (e) { notes.push(`${a.name}: reporting line not set (${e instanceof Error ? e.message : 'error'}).`); } }
    }
    const tasks: OrgImportResult['tasks'] = [], routines: OrgImportResult['routines'] = [], routineIds: string[] = [];
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    for (const t of model.tasks) {
      if (t.recurring ? !includeRoutines : !includeTasks) continue;
      const owner = t.assignee ? idOf.get(t.assignee) : undefined;
      if (t.assignee && !owner && o.agents) continue;
      if (t.recurring) {
        const ext = t.ext, schedule = ext.schedule && typeof ext.schedule === 'object' && !Array.isArray(ext.schedule) ? ext.schedule : SCHEDULE_DEFAULT;
        try {
          const a = await inv<AutomationView>('automations.create', { name: t.name, prompt: t.body || t.name, timezone: typeof ext.timezone === 'string' ? ext.timezone : tz, schedule, permissionMode: 'workspace', overlap: 'skip', catchUp: 'none',
            target: { kind: 'task', projectId, ...(owner ? { assigneeId: `member:${owner}` } : {}), start: true, mode: 'task', ...(typeof ext.titleTemplate === 'string' ? { titleTemplate: ext.titleTemplate } : {}) } });
          await inv('automations.pause', { id: a.id }); routines.push({ id: a.id, name: t.name }); routineIds.push(a.id);
        } catch (e) { notes.push(`Routine ${t.name} was not created (${e instanceof Error ? e.message : 'error'}).`); }
      } else {
        try {
          const made = await inv<{ id: string; revision: number }>('project.tasks.add', { projectId, title: t.name, acceptance: t.body.slice(0, 4000), dependencies: [], ...(owner ? { owner: { kind: 'agent', id: owner } } : {}), ...(t.priority !== null && t.priority >= 0 && t.priority <= 3 ? { priority: t.priority } : {}) });
          if (!o.activate) await inv('project.tasks.setState', { projectId, id: made.id, revision: made.revision, state: 'backlog', reason: 'Imported from a package' }).catch(() => undefined);
          tasks.push({ id: made.id, title: t.name });
        } catch (e) { notes.push(`Task ${t.name} was not created (${e instanceof Error ? e.message : 'error'}).`); }
      }
    }
    let pausedCount = 0;
    for (const mid of touchedIds) { if (o.activate) await inv('project.members.pause', { projectId, id: mid, paused: false }); else pausedCount++; }
    const importId = randomUUID(), all = readImports();
    all[projectId] = { agents: [...new Set([...(all[projectId]?.agents ?? []), ...(o.activate ? [] : touchedIds)])], routines: [...new Set([...(all[projectId]?.routines ?? []), ...routineIds])] };
    writeImports(all);
    void src; ctx.emit({ type: 'orgChanged', projectId } as never);
    return { projectId, importId, created, replaced, skipped, tasks, routines, paused: pausedCount + routines.length, notes };
  }

  async function pending(projectId: string): Promise<OrgPending> {
    const rec = readImports()[projectId] ?? { agents: [], routines: [] };
    const list = await members(projectId), autos = await inv<AutomationView[]>('automations.list', {} as never);
    return {
      agents: rec.agents.map(aid => list.find(m => m.id === aid)).filter((m): m is Member => !!m && !m.revokedAt && !!m.pausedAt).map(m => ({ id: m.id, name: m.name, title: m.title ?? null })),
      routines: rec.routines.map(rid => autos.find(a => a.id === rid)).filter((a): a is AutomationView => !!a && a.paused).map(a => ({ id: a.id, name: a.name })),
    };
  }

  return {
    handlers: {
      'org.export': async i => {
        const projectId = id(i.projectId, 'project id'), { files, name, slug, warnings } = await buildExport(projectId, i.includeTasks !== false, i.includeRoutines !== false);
        const zip = zipFiles(files);
        return { name, slug, files: sizes(files), zipBase64: zip.toString('base64'), zipBytes: zip.length, warnings } satisfies OrgExport;
      },
      'org.export.write': async i => {
        const projectId = id(i.projectId, 'project id'), dir = String(i.dir ?? '');
        if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('Choose an existing folder (an absolute path).');
        const { files, slug } = await buildExport(projectId, i.includeTasks !== false, i.includeRoutines !== false), out = join(dir, slug);
        if (existsSync(out)) throw new Error(`${out} already exists. Choose another folder or remove it.`);
        for (const [p, text] of Object.entries(files)) { const f = join(out, p); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, text); }
        return { path: out, files: Object.keys(files).length };
      },
      'org.import.preview': async i => (await plan(i as unknown as OrgImportOptions)).preview,
      'org.import.apply': i => apply(i as unknown as OrgImportOptions),
      'org.imports.pending': i => pending(id(i.projectId, 'project id')),
      'org.activate': async i => {
        const projectId = id(i.projectId, 'project id'), cur = await pending(projectId);
        const some = Array.isArray(i.agentIds) || Array.isArray(i.routineIds);
        const agentIds = Array.isArray(i.agentIds) ? i.agentIds.map(x => id(x)) : some ? [] : cur.agents.map(a => a.id), routineIds = Array.isArray(i.routineIds) ? i.routineIds.map(x => id(x)) : some ? [] : cur.routines.map(r => r.id);
        for (const a of agentIds) if (cur.agents.some(x => x.id === a)) await inv('project.members.pause', { projectId, id: a, paused: false });
        for (const r of routineIds) if (cur.routines.some(x => x.id === r)) await inv('automations.resume', { id: r });
        ctx.emit({ type: 'orgChanged', projectId } as never);
        return pending(projectId);
      },
      'org.teams.list': () => ({
        teams: CATALOG.map((t): CatalogTeam => {
          const m: PkgModel = readPackage(t.files);
          return { key: t.key, kind: t.kind, category: t.category, slug: t.slug, name: t.name, description: t.description, tags: t.tags, agents: m.agents.map(a => ({ slug: a.slug, name: a.name, title: a.title })), tasks: m.tasks.filter(x => !x.recurring).length, routines: m.tasks.filter(x => x.recurring).length };
        }),
      }),
    },
  };
}
