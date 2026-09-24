/** The muster_browser MCP server: newline-delimited JSON-RPC on stdio, forwarding tool calls to Muster's local
 * bridge. Codex spawns it per chat through the launcher main writes; it holds no browser state itself. */
import fs from 'node:fs';
import {BROWSER_TOOL_SPECS, textResult, type McpToolResult} from './browser-tools.ts';

type Message = {jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>};
export interface McpServerOptions { call(tool: string, args: unknown): Promise<McpToolResult>; write(line: string): void }

/** One JSON-RPC message in, zero or one response out. Exported for tests. */
export async function handleMcpMessage(message: Message, options: McpServerOptions): Promise<void> {
  const respond = (body: Record<string, unknown>) => { if (message.id !== undefined && message.id !== null) options.write(JSON.stringify({jsonrpc: '2.0', id: message.id, ...body})); };
  switch (message.method) {
    case 'initialize': respond({result: {protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18', capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'muster_browser', title: 'Muster browser', version: '1.0.0'}, instructions: 'Drives the in-app browser the user watches in Muster’s right pane.'}}); return;
    case 'ping': respond({result: {}}); return;
    case 'tools/list': respond({result: {tools: BROWSER_TOOL_SPECS.map(({name, description, inputSchema}) => ({name, description, inputSchema}))}}); return;
    case 'tools/call': {
      const name = typeof message.params?.name === 'string' ? message.params.name : '';
      let result: McpToolResult;
      try { result = await options.call(name, message.params?.arguments ?? {}); } catch (error) { result = textResult(`Muster’s browser is not reachable: ${error instanceof Error ? error.message : String(error)}. Is Muster still open?`, true); }
      respond({result}); return;
    }
    default:
      if (message.method?.startsWith('notifications/')) return;
      respond({error: {code: -32601, message: `Method not found: ${String(message.method)}`}});
  }
}

function main(): void {
  const endpointFile = process.argv[2], chatId = process.env.MUSTER_CHAT_ID ?? '';
  const endpoint = (): {url: string; token: string} => JSON.parse(fs.readFileSync(endpointFile!, 'utf8'));
  const call = async (tool: string, args: unknown): Promise<McpToolResult> => {
    // Re-read each call: a relaunched Muster listens on a new port with a new token.
    const {url, token} = endpoint();
    const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, body: JSON.stringify({chatId, tool, arguments: args}), signal: AbortSignal.timeout(110_000)});
    if (!response.ok) throw new Error(`bridge answered ${response.status}`);
    return await response.json() as McpToolResult;
  };
  const write = (line: string) => { process.stdout.write(line + '\n'); };
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) buffer = '';
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: Message;
      try { message = JSON.parse(line); } catch { write(JSON.stringify({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}})); continue; }
      void handleMcpMessage(message, {call, write});
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
if (process.argv[1] && /browser-mcp\.(c?js|ts)$/.test(process.argv[1]) && process.argv[2]) main();
