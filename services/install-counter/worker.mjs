// The digest is the only stored value. D1's primary key deduplicates concurrent requests.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/first-launch') {
      return new Response(null, {status: 404});
    }
    if (request.headers.has('Origin') || request.headers.get('Content-Length') !== '36') {
      return new Response(null, {status: 400});
    }
    const id = await request.text();
    if (!uuid.test(id)) return new Response(null, {status: 400});
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
    await env.DB.prepare('INSERT INTO installs (digest) VALUES (?) ON CONFLICT (digest) DO NOTHING')
      .bind(digest).run();
    return new Response(null, {status: 204});
  },
};
