'use strict';
const http = require('node:http');
const https = require('node:https');
const {randomBytes} = require('node:crypto');
const {Transform} = require('node:stream');
const {StringDecoder} = require('node:string_decoder');
const {createGunzip, createInflate, createBrotliDecompress} = require('node:zlib');

// A few Responses gateways emit usage detail objects without their required counters.
// Change only missing counters on an actual completion event. Never invent a completion,
// change model output or replace a reported counter.
function completedUsage(frame) {
  const lines = frame.split(/\r?\n/);
  const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
  let event;
  try { event = JSON.parse(data); } catch { return frame; }
  if (event?.type !== 'response.completed') return frame;
  const usage = event.response?.usage;
  if (!usage || typeof usage !== 'object') return frame;
  let changed = false;
  for (const [field, counter] of [['input_tokens_details', 'cached_tokens'], ['output_tokens_details', 'reasoning_tokens']]) {
    const details = usage[field];
    if (details && typeof details === 'object' && !Array.isArray(details) && details[counter] === undefined) {
      details[counter] = 0; changed = true;
    }
  }
  if (!changed) return frame;
  let written = false;
  return lines.filter(line => !line.startsWith('data:') || !written && (written = true))
    .map(line => line.startsWith('data:') ? 'data: ' + JSON.stringify(event) : line).join('\n');
}

function usageStream() {
  const decoder = new StringDecoder('utf8');
  let buffer = '', oversized = false;
  const consume = function(final = false) {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary) break;
      const frame = buffer.slice(0, boundary.index);
      this.push((oversized ? frame : completedUsage(frame)) + boundary[0]);
      buffer = buffer.slice(boundary.index + boundary[0].length); oversized = false;
    }
    // Streaming must not buffer an unbounded frame from a broken server. Pass an
    // oversized event through intact; retain only enough to find its delimiter.
    if (buffer.length > 16 * 1024 * 1024) {
      this.push(buffer.slice(0, -3)); buffer = buffer.slice(-3); oversized = true;
    }
    if (final && buffer) this.push(buffer); // An unfinished event stays unfinished.
  };
  return new Transform({
    transform(chunk, encoding, done) { buffer += decoder.write(chunk); consume.call(this); done(); },
    flush(done) { buffer += decoder.end(); consume.call(this, true); done(); },
  });
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function headersWithoutHop(headers) {
  const excluded = new Set([...HOP, ...String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

// A router that keeps each Claude tool call's signed thinking itself refuses the whole request when any tool call in
// the history is no longer in its cache (409 "replay state expired or is unavailable"), even on a new user turn. The
// same exchanges given as plain text are accepted, and new tool calls work normally afterwards. Retry such a refusal
// once with those exchanges as text, and remember their ids so later turns send them as text directly. The coding
// client keeps its thread and full history; only this request's wire form changes.
const REPLAY_REFUSED = /replay state expired or is unavailable/i;
const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);

function callIds(input) {
  return [...new Set(input.filter(item => item && CALL_TYPES.has(item.type) && typeof item.call_id === 'string').map(item => item.call_id))];
}

function outputContent(label, output) {
  if (typeof output === 'string') return [{type: 'input_text', text: `${label}\n${output}`}];
  if (Array.isArray(output)) {
    const kept = output.filter(part => part && (part.type === 'input_text' && typeof part.text === 'string' || part.type === 'input_image'));
    return [{type: 'input_text', text: label}, ...kept];
  }
  return [{type: 'input_text', text: `${label}\n${JSON.stringify(output ?? null)}`}];
}

/** Returns a copy of the request with tool exchanges in `stale` as plain messages, or undefined when none apply. */
function toolHistoryAsText(payload, stale) {
  let changed = false;
  const input = payload.input.map(item => {
    if (!item || typeof item.call_id !== 'string' || !stale.has(item.call_id)) return item;
    if (CALL_TYPES.has(item.type)) {
      changed = true;
      const name = item.name ?? (item.type === 'local_shell_call' ? 'local_shell' : 'tool');
      const args = item.arguments ?? item.input ?? (item.action ? JSON.stringify(item.action) : '');
      return {type: 'message', role: 'assistant', content: [{type: 'output_text', text: `[Earlier tool call ${name} (${item.call_id})]\n${args}`}]};
    }
    if (OUTPUT_TYPES.has(item.type)) {
      changed = true;
      return {type: 'message', role: 'user', content: outputContent(`[Earlier tool result (${item.call_id})]`, item.output)};
    }
    return item;
  });
  return changed ? {...payload, input} : undefined;
}

/** A process-owned loopback bridge. Its upstream is fixed by the original provider
 * config; credentials still come from the coding client's existing auth mechanism.
 * Only streamed Responses completions are normalized, and only a refused tool-call replay is retried (once).
 * All other bodies pass through.
 */
async function startResponsesCompatibility(baseUrl) {
  const upstream = new URL(baseUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('The configured Responses provider needs a plain HTTP or HTTPS base URL.');
  }
  const prefix = '/' + randomBytes(24).toString('hex');
  const pending = new Set();
  const staleCalls = new Set();
  const remember = id => { staleCalls.add(id); if (staleCalls.size > 20000) staleCalls.delete(staleCalls.values().next().value); };
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith(prefix + '/')) { res.writeHead(404); res.end(); return; }
    const target = new URL(upstream.href);
    const suffix = req.url.slice(prefix.length), question = suffix.indexOf('?');
    target.pathname = upstream.pathname.replace(/\/$/, '') + (question < 0 ? suffix : suffix.slice(0, question));
    target.search = question < 0 ? '' : suffix.slice(question);
    const headers = headersWithoutHop(req.headers);
    headers.host = upstream.host; headers['accept-encoding'] = 'identity';
    // Keep why the router could not be used (a system error code such as ECONNREFUSED, or a TLS reason) so the chat can
    // say it. Never echo the message itself: it can carry the router address.
    const fail = error => {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(error.code) ? error.code : 'unknown error';
      if (!res.headersSent) { res.writeHead(502, {'content-type': 'application/json'}); res.end(JSON.stringify({error: {message: `Configured provider transport failed (${code}).`}})); }
      else res.destroy();
    };
    const relay = response => {
      const outgoing = headersWithoutHop(response.headers);
      let body = response;
      const streamed = /^text\/event-stream\b/i.test(String(outgoing['content-type'] ?? ''));
      if (streamed) {
        const encoding = String(outgoing['content-encoding'] ?? '').toLowerCase();
        const decode = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
        if (decode) { response.pipe(decode); body = decode; decode.on('error', fail); delete outgoing['content-encoding']; }
        if (!encoding || encoding === 'identity' || decode) {
          delete outgoing['content-length']; delete outgoing.etag;
          const normalize = usageStream(); body.pipe(normalize); body = normalize; normalize.on('error', fail);
        }
      }
      response.on('error', fail);
      res.writeHead(response.statusCode ?? 502, outgoing);
      body.pipe(res);
    };
    const open = (onResponse, length) => {
      const request = (upstream.protocol === 'https:' ? https : http).request(target, {method: req.method, headers: length === undefined ? headers : {...headers, 'content-length': String(length)}});
      pending.add(request);
      request.once('close', () => pending.delete(request));
      request.on('error', fail);
      res.on('close', () => request.destroy());
      request.on('response', onResponse);
      return request;
    };
    req.on('error', () => res.destroy());
    const replayable = req.method === 'POST' && /\/responses$/.test(target.pathname) && ['', 'identity'].includes(String(req.headers['content-encoding'] ?? '').toLowerCase());
    if (!replayable) { req.pipe(open(relay)); return; }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { payload = undefined; }
      const original = Buffer.concat(chunks);
      const first = payload && Array.isArray(payload.input) ? toolHistoryAsText(payload, staleCalls) : undefined;
      const body = first ? Buffer.from(JSON.stringify(first)) : original;
      open(response => {
        if (response.statusCode !== 409 || !payload || !Array.isArray(payload.input)) return relay(response);
        // Read the refusal (small) to decide; anything else is passed on exactly as received.
        const parts = []; let size = 0;
        response.on('data', part => { size += part.length; parts.push(part); });
        response.on('error', fail);
        response.on('end', () => {
          const text = size <= 64 * 1024 ? Buffer.concat(parts).toString('utf8') : '';
          const ids = callIds(payload.input);
          const fresh = ids.filter(id => !staleCalls.has(id));
          if (!REPLAY_REFUSED.test(text) || !fresh.length) {
            res.writeHead(409, headersWithoutHop(response.headers)); res.end(Buffer.concat(parts)); return;
          }
          for (const id of fresh) remember(id);
          const retry = Buffer.from(JSON.stringify(toolHistoryAsText(payload, staleCalls) ?? payload));
          open(relay, retry.length).end(retry);
        });
      }, body.length).end(body);
    });
  });
  server.requestTimeout = 0; // Long coding turns are intentional; the client owns cancellation.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}${prefix}`,
    close() { for (const request of pending) request.destroy(); server.closeAllConnections(); server.close(); },
  };
}

module.exports = {startResponsesCompatibility};
