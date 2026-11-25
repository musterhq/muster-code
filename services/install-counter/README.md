# Desktop first launches

Official releases use the repository variable `MUSTER_INSTALL_COUNT_URL` at build time. Enable it after the collector at `https://installs.themuster.dev/v1/first-launch` is ready. The desktop sends a random UUID once per new default app profile and retains it for retries until the collector acknowledges it. D1 stores only its SHA-256 digest. Repeat downloads without a launch produce no events. A fresh OS profile or a complete app-data reset counts again.

From this directory, deploy with Wrangler 4, apply the schema, and query the private aggregate:

```sh
npx wrangler@4 deploy
npx wrangler@4 d1 execute DB --remote --file schema.sql
npx wrangler@4 d1 execute DB --remote --command 'SELECT COUNT(*) AS installs FROM installs'
```

For a local smoke test, apply the schema with `--local` and start `npx wrangler@4 dev --local`. Send a POST containing the same v4 UUID twice. Both responses should be 204, and the local count should increase by one.
