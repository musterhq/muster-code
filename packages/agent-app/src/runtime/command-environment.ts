/** The environment a shell started for the agent gets. Do not pass provider tokens, API keys, SSH agents or arbitrary app variables. */
export function commandEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  // Windows programs need the Windows environment (SystemRoot, PATHEXT, TEMP, USERPROFILE…) to run.
  if (platform === 'win32') return { ...source, TERM: 'dumb', NO_COLOR: '1' };
  const env: NodeJS.ProcessEnv = { PATH: source.PATH ?? '/usr/bin:/bin', TERM: 'dumb', NO_COLOR: '1' };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL']) if (source[key]) env[key] = source[key];
  return env;
}
const SECRET_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_ID)?|SECRET(?:_\w*)?|\w*_SECRET_KEY|MASTER_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY|CLIENT_?SECRET|TOKEN|PAT|PASS(?:WORD|WD)?|CREDENTIALS?|AUTH(?:ORIZATION)?|SESSION_TOKEN|PRIVATE_KEY|DSN|CONNECTION_?STRING|DATABASE_URL|DB_URL|REDIS_URL|MONGO(?:DB)?_URI)$|PASSW(?:OR)?D$|^MYSQL_PWD$|^MUSTER_|^OMNIROUTE_|^SSH_AUTH_SOCK$|^(?:AWS|AZURE|GOOGLE|GCP|GH|GITHUB|NPM|OPENAI|ANTHROPIC|HF|HUGGING)\w*(?:KEY|TOKEN|SECRET)\w*$/i;
/** commandEnvironment() without anything that looks like a credential or a Muster internal (matters on Windows, which passes the whole environment), plus the run's own lent variables. */
export function agentCommandEnvironment(lent: Record<string, string> | undefined, source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env = commandEnvironment(source, platform);
  for (const key of Object.keys(env)) if (SECRET_NAME.test(key)) delete env[key];
  for (const [key, value] of Object.entries(lent ?? {})) if (/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && typeof value === 'string') env[key] = value;
  return env;
}
