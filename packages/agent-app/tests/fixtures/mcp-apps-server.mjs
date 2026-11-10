// #844: a fake MCP server (stdio, newline-delimited JSON-RPC) with MCP Apps tools. Every tools/call is appended to FAKE_LOG
// as one JSON line, so a test can prove a refused call never reached the server.
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';

const send = message => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n');
const APP = '<!doctype html><html><head><title>Board</title></head><body><h1>Board</h1><script>parent.postMessage({jsonrpc:"2.0",id:1,method:"ui/initialize",params:{appCapabilities:{}}},"*")</script></body></html>';
const tools = [
  {name: 'show_board', description: 'Shows the board', inputSchema: {type: 'object'}, annotations: {readOnlyHint: true}, _meta: {ui: {resourceUri: 'ui://board/app.html'}}},
  {name: 'plain', description: 'No UI', inputSchema: {type: 'object'}},
  {name: 'count', description: 'Counts cards', inputSchema: {type: 'object'}, annotations: {readOnlyHint: true}},
  {name: 'move_card', description: 'Moves a card', inputSchema: {type: 'object'}},
  {name: 'secret_admin', description: 'Model only', inputSchema: {type: 'object'}, annotations: {readOnlyHint: true}, _meta: {ui: {visibility: ['model']}}},
  {name: 'wrong_ui', description: 'Declares a resource that is not an MCP app', inputSchema: {type: 'object'}, _meta: {ui: {resourceUri: 'ui://board/wrong.html'}}},
  {name: 'no_domains', description: 'An app that asks for no network', inputSchema: {type: 'object'}, _meta: {'ui/resourceUri': 'ui://board/offline.html'}},
  {name: 'web_ui', description: 'Not a ui:// resource', inputSchema: {type: 'object'}, _meta: {ui: {resourceUri: 'https://example.com/app.html'}}},
];
const resources = {
  'ui://board/app.html': {mimeType: 'text/html;profile=mcp-app', text: APP, _meta: {ui: {prefersBorder: true, csp: {connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.com', 'http://insecure.example.com']}}}},
  'ui://board/wrong.html': {mimeType: 'text/html', text: '<p>plain page</p>'},
  'ui://board/offline.html': {mimeType: 'text/html;profile=mcp-app', text: '<p>offline app</p>'},
};
createInterface({input: process.stdin}).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const {id, method, params} = message;
  if (id === undefined) return;
  if (method === 'initialize') return send({id, result: {protocolVersion: params.protocolVersion, capabilities: {tools: {}, resources: {}}, serverInfo: {name: 'board', version: '1.0.0'}, _client: params.capabilities}});
  if (method === 'tools/list') return send({id, result: {tools}});
  if (method === 'resources/read') {
    const found = resources[params?.uri];
    return found ? send({id, result: {contents: [{uri: params.uri, ...found}]}}) : send({id, error: {code: -32002, message: 'Resource not found'}});
  }
  if (method === 'tools/call') {
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({name: params?.name, arguments: params?.arguments ?? {}}) + '\n');
    return send({id, result: {content: [{type: 'text', text: `${params?.name} ok`}], structuredContent: {name: params?.name, arguments: params?.arguments ?? {}}}});
  }
  send({id, error: {code: -32601, message: `Unknown method ${method}`}});
});
