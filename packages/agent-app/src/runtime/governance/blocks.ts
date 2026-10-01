/**
 * Fenced blocks an agent may put in its final message, in the same style as the coordinator's ```muster-tasks block.
 * Muster parses them when the run settles and applies them inside the agent's permissions. Nothing here runs code.
 *   ```muster-secret-request   {"name":"NPM_TOKEN","purpose":"publish the package"}
 *   ```muster-review           {"decision":"approve"|"request_changes","note":"…"}      (a reviewer agent)
 *   ```muster-watchdog         {"verdict":"accept"|"reopen"|"reassign","note":"…","reassignTo":"Name"}
 *   ```muster-hire             {"name":"…","title":"…","reportsTo":"Name","instructions":"…"}
 *   ```muster-subtasks         [{"title":"…","acceptance":"…","assignee":"Name","priority":2}, {"reassign":"OSS-3","to":"Name"}]
 */
export type BlockTag = 'muster-secret-request' | 'muster-review' | 'muster-watchdog' | 'muster-hire' | 'muster-subtasks';
export interface ParsedBlock { value?: Record<string, unknown>; error?: string }

export function parseJsonBlocks(text: string, tag: BlockTag): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  const re = new RegExp('```' + tag + '[^\\n]*\\n([\\s\\S]*?)```', 'g');
  for (const m of text.matchAll(re)) {
    try {
      const raw: unknown = JSON.parse(m[1]!);
      const list = Array.isArray(raw) ? raw : [raw];
      if (!list.length || list.length > 10) throw new Error('A block holds 1–10 entries.');
      for (const entry of list) { if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Each entry must be an object.'); out.push({ value: entry as Record<string, unknown> }); }
    } catch (err) { out.push({ error: err instanceof Error ? err.message : 'Unreadable block.' }); }
  }
  return out;
}
const s = (v: unknown, max: number): string | null => typeof v === 'string' && v.trim() && v.length <= max && !v.includes('\0') ? v.trim() : null;

export interface SecretRequest { name: string; purpose: string }
/** Names are upper-case identifiers, like environment variables. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Names that steer the shell, the loader, git, Node or Muster's own providers. A lent secret with one of these would change how a run behaves, so they are never accepted. */
const RESERVED = /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|PWD|OLDPWD|IFS|BASH_ENV|ENV|LANG|TERM|EDITOR|VISUAL|PAGER|SSH_AUTH_SOCK|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|CLASSPATH|JAVA_TOOL_OPTIONS|NODE_OPTIONS|NODE_PATH|LC_[A-Z_]*|LD_[A-Z_]*|DYLD_[A-Z_]*|GIT_[A-Z_]*|NODE_[A-Z_]*|NPM_CONFIG_[A-Z_]*|XDG_[A-Z_]*|ELECTRON_[A-Z_]*|CODEX_[A-Z_]*|ANTHROPIC_[A-Z_]*|OPENAI_[A-Z_]*|CLAUDE_[A-Z_]*|MUSTER_[A-Z_]*)$/;
export const isReservedName = (name: string): boolean => RESERVED.test(name);
export const RESERVED_HELP = 'That name is reserved: it would change how a run starts or how git, the shell or Muster behave. Choose a name for the service, like NPM_TOKEN or DEPLOY_KEY.';
export function secretRequests(text: string): { requests: SecretRequest[]; errors: string[] } {
  const requests: SecretRequest[] = [], errors: string[] = [];
  for (const b of parseJsonBlocks(text, 'muster-secret-request')) {
    if (b.error || !b.value) { errors.push(b.error ?? 'Unreadable request.'); continue; }
    const name = s(b.value.name, 64)?.toUpperCase().replace(/[^A-Z0-9_]/g, '_') ?? '', purpose = s(b.value.purpose, 500);
    if (!SECRET_NAME.test(name)) { errors.push('A secret name is 2–64 capital letters, digits or underscores, starting with a letter.'); continue; }
    if (isReservedName(name)) { errors.push(`${name}: ${RESERVED_HELP}`); continue; }
    if (!purpose) { errors.push(`Say what ${name} is for.`); continue; }
    requests.push({ name, purpose });
  }
  return { requests: requests.slice(0, 5), errors };
}
export function reviewVerdict(text: string): { decision: 'approve' | 'request_changes'; note: string } | null {
  for (const b of parseJsonBlocks(text, 'muster-review').reverse()) {
    const d = b.value?.decision, note = s(b.value?.note, 4000) ?? '';
    if (d === 'approve' || d === 'request_changes') return { decision: d, note };
  }
  return null;
}
export function watchdogVerdict(text: string): { verdict: 'accept' | 'reopen' | 'reassign'; note: string; reassignTo: string | null } | null {
  for (const b of parseJsonBlocks(text, 'muster-watchdog').reverse()) {
    const v = b.value?.verdict, note = s(b.value?.note, 4000) ?? '';
    if (v === 'accept' || v === 'reopen' || v === 'reassign') return { verdict: v, note, reassignTo: s(b.value?.reassignTo, 128) };
  }
  return null;
}
export interface HireRequest { name: string; title: string | null; reportsTo: string | null; instructions: string }
export function hireRequests(text: string): { hires: HireRequest[]; errors: string[] } {
  const hires: HireRequest[] = [], errors: string[] = [];
  for (const b of parseJsonBlocks(text, 'muster-hire')) {
    if (b.error || !b.value) { errors.push(b.error ?? 'Unreadable hire.'); continue; }
    const name = s(b.value.name, 120);
    if (!name) { errors.push('A hire needs a name.'); continue; }
    hires.push({ name, title: s(b.value.title, 120), reportsTo: s(b.value.reportsTo, 128), instructions: s(b.value.instructions, 20_000) ?? '' });
  }
  return { hires: hires.slice(0, 3), errors };
}

export interface SubtaskRequest { title: string; acceptance: string; assignee: string | null; priority: 0 | 1 | 2 | 3 | null }
export interface ReassignRequest { key: string; to: string }
export function subtaskRequests(text: string): { creates: SubtaskRequest[]; reassigns: ReassignRequest[]; errors: string[] } {
  const creates: SubtaskRequest[] = [], reassigns: ReassignRequest[] = [], errors: string[] = [];
  for (const b of parseJsonBlocks(text, 'muster-subtasks')) {
    if (b.error || !b.value) { errors.push(b.error ?? 'Unreadable entry.'); continue; }
    const v = b.value;
    if (typeof v.reassign === 'string') { const key = s(v.reassign, 64), to = s(v.to, 128); if (key && to) reassigns.push({ key, to }); else errors.push('A reassignment needs the task key and the agent.'); continue; }
    const title = s(v.title, 500);
    if (!title) { errors.push('A subtask needs a title.'); continue; }
    const p = v.priority;
    creates.push({ title, acceptance: s(v.acceptance, 4000) ?? '', assignee: s(v.assignee, 128), priority: p === 0 || p === 1 || p === 2 || p === 3 ? p : null });
  }
  return { creates: creates.slice(0, 10), reassigns: reassigns.slice(0, 10), errors };
}
