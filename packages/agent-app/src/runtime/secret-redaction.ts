/**
 * One shared secret redactor for anything that leaves the live session: chat exports, memory notes
 * (local store and Hindsight retain), suggested run notes, and memory bank exports/backups.
 * Only credential *shapes* are matched, so ordinary hex hashes and commit SHAs are left alone.
 *
 * Every quantifier that can repeat from many start positions is bounded, so a long adversarial run
 * (a minified bundle, `sk-sk-sk-…`, thousands of unterminated PEM headers) stays linear.
 */
import { redactGitText } from './git-local.ts';

/** Token and credential shapes, on top of the Git credential rules (URL userinfo, GitHub/GitLab tokens).
 *  Patterns with a `label` group keep it (`Bearer `, `api_key=`); a `value`/`qvalue` group is masked only
 *  when it is not an obvious placeholder or code (`password: string`, `token = getToken()`, `${TOKEN}`). */
export const SECRET_PATTERNS: readonly RegExp[] = [
  // A truncated key (no END line: `head -5 id_rsa`) is masked to the end of the text rather than leaked.
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
  // A vendor prefix (sk-ant-, sk-proj-, …) is signal enough; a bare `sk-` must also carry a digit, so a kebab-case
  // name that merely starts with `sk-` (a CSS class, a slug) is left alone.
  /\bsk-(?:(?:ant-(?:api\d+-|admin\d+-)?|proj-|svcacct-|admin-)[A-Za-z0-9_-]{20,}|(?:live-|test-)?(?=[A-Za-z0-9_-]{0,64}\d)[A-Za-z0-9_-]{20,})\b/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(?<label>Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?<label>Authorization\s*:\s*(?:Basic|Token|Digest)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  // key: value / key=value, including prefixed names (aws_secret_access_key, db-password) and quoted values.
  /\b(?<label>(?:[a-z0-9]{1,32}[_-]){0,4}(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token)(?:[_-](?:key|base|value)){0,2}["']?\s*[:=]\s*)(?:(?<q>["'])(?<qvalue>[^"'\r\n]{4,512})\k<q>|(?<value>[^\s"',;]{6,}))/gi,
  // .env style: GITHUB_TOKEN=…, export DB_PASSWORD="…", AWS_SECRET_ACCESS_KEY=…, OPENAI_APIKEY=…
  /\b(?<label>(?:[A-Z0-9]{1,32}_){0,6}(?:API|ACCESS|SECRET|PRIVATE|AUTH|CLIENT|MASTER)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)(?:_(?:KEY|TOKEN|SECRET|ID|B64|BASE64|VALUE|RAW|PROD|DEV|TEST|LIVE)){0,3}\s*=\s*)(?:(?<q>["'])(?<qvalue>[^"'\r\n]{1,512})\k<q>|(?<value>[^\s"'`]{4,}))/g,
];
export const SECRET_MASK = '[redacted]';

/** Values after `password:`/`TOKEN=` that are types, references or placeholders rather than secrets. */
const NOT_A_SECRET = /^(?:string|number|boolean|bigint|undefined|null|none|nil|true|false|any|unknown|object|required|optional|redacted|\[redacted\]|\*+|x{3,}|\.{3,}|…|<[^>]*>|\{\{.*\}\}|\$\{?[A-Za-z_][\w.]*\}?|%[A-Za-z_][\w]*%|(?:process\.env|import\.meta\.env|os\.environ|env|secrets|config|settings|options|opts|props|this|self|req|request|ctx|context|input|args|params)\b.*|[A-Za-z_$][\w$.]*\(.*|your[_-].*|.*[_-]here)$/i;

/** Masks secret-looking strings; `count` accumulates how many were replaced. */
export function redactSecrets(text: string, count = { value: 0 }): string {
  let out = redactGitText(text);
  if (out !== text) count.value += Math.max(1, (out.match(/\*\*\*/g)?.length ?? 0) - (text.match(/\*\*\*/g)?.length ?? 0));
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (...args: unknown[]) => {
      const whole = args[0] as string;
      const groups = typeof args[args.length - 1] === 'object' ? args[args.length - 1] as Record<string, string | undefined> | undefined : undefined;
      const value = groups?.qvalue ?? groups?.value;
      if (value !== undefined && NOT_A_SECRET.test(value.trim())) return whole;
      count.value++;
      // Keep a captured label (`Bearer `, `api_key=`) and any quotes so the text still reads.
      const quote = groups?.qvalue !== undefined ? groups.q ?? '' : '';
      return (groups?.label ?? '') + quote + SECRET_MASK + quote;
    });
  }
  return out;
}
