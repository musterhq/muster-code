/**
 * #160: agents that speak the Agent Client Protocol (ACP, agentclientprotocol.com): JSON-RPC 2.0 over the agent's
 * stdin/stdout. Any such command can be added in Settings › Providers; the presets below only fill in the command.
 * Nothing here downloads or installs anything. Pure data and pure functions, shared by the runtime, renderer and tests.
 */

/** The driver of every ACP agent route. */
export const ACP_DRIVER = 'acp-agent';
/** Provider ids of ACP agents added in Muster. */
export const ACP_ID = /^acp_[A-Za-z0-9-]{1,80}$/;
export const isAcpProviderId = (id: string): boolean => ACP_ID.test(id);

export interface AcpPreset {
  id: string; name: string; description: string;
  command: string; args: string[];
  /** Shown in the sheet: how to install the agent yourself. Muster never runs it. */
  installHint: string; installUrl: string;
  /** The agent's own sign-in variables, passed from Muster's environment when set (the person's shell). */
  envNames?: string[];
}

/** Known ACP agents. Command presets only: the person installs and signs in to each one themselves. */
export const ACP_PRESETS: readonly AcpPreset[] = [
  {id: 'gemini', name: 'Gemini CLI', description: 'Google’s Gemini CLI in ACP mode.', command: 'gemini', args: ['--experimental-acp'],
    installHint: 'npm install -g @google/gemini-cli, then run gemini once to sign in.', installUrl: 'https://github.com/google-gemini/gemini-cli', envNames: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI']},
  {id: 'claude-code-acp', name: 'Claude Code (ACP adapter)', description: 'Claude Code through its ACP adapter.', command: 'claude-code-acp', args: [],
    installHint: 'npm install -g @zed-industries/claude-code-acp, and sign in to Claude Code.', installUrl: 'https://github.com/zed-industries/claude-code-acp', envNames: ['ANTHROPIC_API_KEY']},
  {id: 'codex-acp', name: 'Codex (ACP adapter)', description: 'The Codex agent through its ACP adapter.', command: 'codex-acp', args: [],
    installHint: 'Install codex-acp from its releases page, and sign in to Codex.', installUrl: 'https://github.com/zed-industries/codex-acp', envNames: ['OPENAI_API_KEY']},
  {id: 'goose', name: 'Goose', description: 'Block’s open-source agent.', command: 'goose', args: ['acp'],
    installHint: 'Install Goose from block.github.io/goose, then run goose configure.', installUrl: 'https://block.github.io/goose/docs/getting-started/installation'},
  {id: 'opencode', name: 'OpenCode (ACP)', description: 'OpenCode as an ACP agent.', command: 'opencode', args: ['acp'],
    installHint: 'npm install -g opencode-ai, then opencode auth login.', installUrl: 'https://opencode.ai/docs'},
  {id: 'qwen', name: 'Qwen Code', description: 'Qwen Code in ACP mode.', command: 'qwen', args: ['--experimental-acp'],
    installHint: 'npm install -g @qwen-code/qwen-code, then run qwen once to sign in.', installUrl: 'https://github.com/QwenLM/qwen-code', envNames: ['OPENAI_API_KEY', 'DASHSCOPE_API_KEY']},
];
export const acpPreset = (id: string | undefined): AcpPreset | undefined => ACP_PRESETS.find(preset => preset.id === id);

/** Shell-like split of an arguments line: whitespace separates, single and double quotes group, backslash escapes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let word = '', quote: '"' | "'" | null = null, started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === '\\' && i + 1 < line.length) { word += line[++i]; started = true; continue; }
    if (/\s/.test(c)) { if (started) out.push(word); word = ''; started = false; continue; }
    word += c; started = true;
  }
  if (quote) throw new Error('An argument has an unclosed quote.');
  if (started) out.push(word);
  return out;
}
/** The inverse of splitArgs, for showing saved arguments in one field. */
export const joinArgs = (args: readonly string[]): string => args.map(arg => arg && !/[\s"'\\]/.test(arg) ? arg : `'${arg.replace(/'/g, `'"'"'`)}'`).join(' ');

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** `NAME=value` lines (blank lines and `#` comments skipped). */
export function parseEnvLines(textValue: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of textValue.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('='), name = at > 0 ? line.slice(0, at).trim() : '';
    if (!ENV_NAME.test(name)) throw new Error(`“${line.slice(0, 40)}” is not NAME=value.`);
    env[name] = line.slice(at + 1);
  }
  return env;
}
