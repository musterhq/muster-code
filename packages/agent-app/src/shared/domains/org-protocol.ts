/**
 * Organization packages and the teams catalog (Wave 4: G16, G17). A project's agents, starter tasks and routines leave as an
 * `agentcompanies/v1` markdown package (a zip or a folder) and come back in through a preview that says what will happen. Imported
 * agents and routines start paused, with an Activate panel. Secret values, git identities and local paths are never exported.
 */
export type OrgSource = { kind: 'zip'; base64: string } | { kind: 'catalog'; key: string } | { kind: 'folder'; path: string };
export type CollisionStrategy = 'skip' | 'rename' | 'replace';
export interface OrgExportFile { path: string; bytes: number }
export interface OrgExport { name: string; slug: string; files: OrgExportFile[]; zipBase64: string; zipBytes: number; warnings: string[] }
/** What the package asks an agent to be allowed to do. Shown before importing; nothing here is applied unless the person confirms it. */
export interface OrgPermissions { canHire: boolean; canAssign: boolean; assignScope: string; trust: string; containment: string; toolRules: number }
export interface OrgPreviewAgent { permissions: OrgPermissions | null; slug: string; name: string; title: string | null; reportsTo: string | null; action: 'create' | 'collision'; existingId: string | null; runner: { providerId: string; model: string } | null; runnerNote: string | null; instructionsChars: number }
export interface OrgPreviewTask { slug: string; name: string; assignee: string | null; recurring: boolean; schedule: string | null }
export interface OrgPreview {
  package: { kind: 'company' | 'team'; name: string; slug: string; description: string };
  target: { kind: 'existing' | 'new'; projectId: string | null; name: string };
  agents: OrgPreviewAgent[]; tasks: OrgPreviewTask[]; skills: number;
  secrets: string[];
  /** True when any agent asks for more than the default permissions or brings tool rules. */
  privileged: boolean;
  /** Said once each: what will be paused, what is not imported, which runner is replaced. */
  notes: string[];
}
export interface OrgImportOptions { source: OrgSource; projectId?: string | null; name?: string; collision?: CollisionStrategy; agents?: string[]; includeTasks?: boolean; includeRoutines?: boolean; attachTo?: string | null; /** `least` (the default for zips and folders) gives every imported agent the default permissions and drops tool rules; `imported` applies what the package asks for, after the person confirmed the preview. Bundled catalog teams are ours and default to `imported`. */ permissions?: 'least' | 'imported'; /** Leave the new agents running (a bundled team) instead of paused. */ activate?: boolean }
export interface OrgImportResult {
  projectId: string; importId: string; created: { slug: string; id: string; name: string }[]; replaced: { slug: string; id: string; name: string }[]; skipped: { slug: string; name: string; reason: string }[];
  tasks: { id: string; title: string }[]; routines: { id: string; name: string }[]; paused: number; notes: string[];
}
export interface OrgPending { agents: { id: string; name: string; title: string | null }[]; routines: { id: string; name: string }[] }
export interface CatalogTeam {
  key: string; kind: 'bundled' | 'optional'; category: string; slug: string; name: string; description: string; tags: string[];
  agents: { slug: string; name: string; title: string | null }[]; tasks: number; routines: number;
}
export interface OrgCommands {
  'org.export': { input: { projectId: string; includeTasks?: boolean; includeRoutines?: boolean }; output: OrgExport };
  /** Writes the package as a folder named after the project inside `dir` (which must exist, and the folder must not). */
  'org.export.write': { input: { projectId: string; dir: string; includeTasks?: boolean; includeRoutines?: boolean }; output: { path: string; files: number } };
  'org.import.preview': { input: OrgImportOptions; output: OrgPreview };
  'org.import.apply': { input: OrgImportOptions; output: OrgImportResult };
  'org.imports.pending': { input: { projectId: string }; output: OrgPending };
  /** Starts imported agents and routines. Name the agents and routines to start; name neither and everything still paused from an import starts. */
  'org.activate': { input: { projectId: string; agentIds?: string[]; routineIds?: string[] }; output: OrgPending };
  'org.teams.list': { input: Record<string, never>; output: { teams: CatalogTeam[] } };
}
export const ORG_COMMANDS = { 'org.export': true, 'org.export.write': true, 'org.import.preview': true, 'org.import.apply': true, 'org.imports.pending': true, 'org.activate': true, 'org.teams.list': true } as const satisfies Record<keyof OrgCommands, true>;
export type OrgEvent = { type: 'orgChanged'; projectId: string };
