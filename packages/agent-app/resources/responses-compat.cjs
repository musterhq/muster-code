'use strict';
const http = require('node:http');
const https = require('node:https');
const {randomBytes} = require('node:crypto');
const {Transform} = require('node:stream');
const {StringDecoder} = require('node:string_decoder');
const {createGunzip, createInflate, createBrotliDecompress} = require('node:zlib');

// A few Responses gateways emit usage detail objects without their required counters.
// Change only missing counters on an actual completion event. Never invent a completion,
// change model output, replace a reported counter, or retry a request.
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

/** A process-owned loopback bridge. Its upstream is fixed by the original provider
 * config; credentials still come from the coding client's existing auth mechanism.
 * Only streamed Responses completions are normalized. All other bodies pass through.
 */
async function startResponsesCompatibility(baseUrl) {
  const upstream = new URL(baseUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('The configured Responses provider needs a plain HTTP or HTTPS base URL.');
  }
  const prefix = '/' + randomBytes(24).toString('hex');
  const pending = new Set();
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith(prefix + '/')) { res.writeHead(404); res.end(); return; }
    const target = new URL(upstream.href);
    const suffix = req.url.slice(prefix.length), question = suffix.indexOf('?');
    target.pathname = upstream.pathname.replace(/\/$/, '') + (question < 0 ? suffix : suffix.slice(0, question));
    target.search = question < 0 ? '' : suffix.slice(question);
    const headers = headersWithoutHop(req.headers);
    headers.host = upstream.host; headers['accept-encoding'] = 'identity';
    const request = (upstream.protocol === 'https:' ? https : http).request(target, {method: req.method, headers});
    pending.add(request);
    request.once('close', () => pending.delete(request));
    const fail = () => {
      if (!res.headersSent) { res.writeHead(502, {'content-type': 'application/json'}); res.end('{"error":{"message":"Configured provider transport failed."}}'); }
      else res.destroy();
    };
    request.on('error', fail);
    req.on('error', () => request.destroy());
    res.on('close', () => request.destroy());
    request.on('response', response => {
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
    });
    req.pipe(request);
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
