# Muster Server

Muster Server runs the Muster Agent runtime on a machine your team shares. People sign in from a browser and get the same interface as
the desktop app: chats, projects, the Roster, the Inbox and the Ledger. Owners and admins manage people, invites, project access,
usage and cost, and chat connectors (Slack, Telegram, Mattermost, several of each).

It is one Node process with an SQLite database. In our end-to-end run it idled at about 120 MB RSS.

- [Quickstart](#quickstart)
- [Deploy](#deploy): [release tarball + systemd](#release-tarball-and-systemd), [Docker](#docker), [TLS with Caddy or nginx](#tls-behind-caddy-or-nginx)
- [People, roles and access](#people-roles-and-access)
- [Connectors](#connectors)
- [Usage, cost and audit](#usage-cost-and-audit)
- [The web UI](#the-web-ui) and [connecting the desktop app](#connecting-the-desktop-app)
- [Backup and restore](#backup-and-restore)
- [Security notes](#security-notes)
- [CLI reference](#cli-reference)

## Quickstart

Download `muster-server-<version>-<platform>.tar.gz` for your platform from the
[releases page](https://github.com/musterhq/muster-code/releases). Check it against `SHA256SUMS`, then:

```sh
tar -xzf muster-server-<version>-linux-x64.tar.gz
cd muster-server-<version>-linux-x64
bin/muster-server init --username admin      # creates ~/.muster-server, the secret key and the owner (asks for a password)
bin/muster-server start                      # http://127.0.0.1:7470
```

Open `http://127.0.0.1:7470`, sign in, and add a model provider under **Settings › Providers**, the same way you would in the desktop
app. Then invite your team:

```sh
bin/muster-server invite --role member --expires 7d
```

The tarball includes its own Node 24 runtime (`bin/node`), so there is nothing else to install. On a machine that already has Node 24
you can also build it from source: run `npm ci && npm run build` in `packages/agent-app`, then the same in `packages/server`.

The **data directory** defaults to `~/.muster-server`. Set it with `--data-dir` or `MUSTER_SERVER_DATA_DIR`:

| Path | What |
| --- | --- |
| `server.json` | Non-secret settings: host, port, allowed hosts, TLS paths, public URL |
| `server.sqlite` | Accounts, sessions, invites, project access, the audit chain, connectors and their encrypted secrets |
| `keys/secret.key` | The 32-byte key that encrypts every stored secret (mode 0600). `MUSTER_SERVER_SECRET_KEY` can supply it instead |
| `keys/cli.token` | The owner's local CLI token (mode 0600), so `muster-server` commands reach the running server |
| `runtime/` | The agent runtime's own data: chats, projects, tasks, the turn Ledger, provider connections |
| `logs/server.log` | Output of `start --detach` |

## Deploy

### Release tarball and systemd

```ini
# /etc/systemd/system/muster-server.service
[Unit]
Description=Muster Server
After=network-online.target

[Service]
User=muster
Environment=MUSTER_SERVER_DATA_DIR=/var/lib/muster-server
ExecStart=/opt/muster-server/bin/muster-server start
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/muster-server /srv/repos

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --create-home muster
sudo -u muster MUSTER_SERVER_DATA_DIR=/var/lib/muster-server /opt/muster-server/bin/muster-server init --username admin --trust-proxy --public-url https://muster.example.com
sudo systemctl enable --now muster-server
```

`SIGHUP` (`systemctl reload`) restarts the connectors and re-checks every open browser session against the database.

### Docker

```sh
docker build -f packages/server/Dockerfile -t muster-server .      # from the repository root
cp packages/server/docker-compose.example.yml docker-compose.yml   # set your domain
echo 'a-long-owner-password' > owner-password.txt
docker compose up -d && rm owner-password.txt
```

The example puts Caddy in front for automatic HTTPS. The container keeps everything in the `/data` volume and initializes itself on the
first start from `MUSTER_SERVER_OWNER_PASSWORD_FILE`. Inside the container the server binds `0.0.0.0` and answers only to
`MUSTER_SERVER_ALLOWED_HOSTS`.

### TLS behind Caddy or nginx

The recommended setup is to keep the default `127.0.0.1` bind and terminate TLS in a reverse proxy on the same machine:

```sh
muster-server start --public-url https://muster.example.com --trust-proxy --allowed-host muster.example.com
```

`--trust-proxy` makes the server honour `X-Forwarded-Proto` and `X-Forwarded-For`, but only from a loopback peer. It needs that to set
`Secure` cookies and log real client addresses.

```caddy
muster.example.com {
  reverse_proxy 127.0.0.1:7470
}
```

```nginx
server {
  listen 443 ssl;
  server_name muster.example.com;
  ssl_certificate     /etc/letsencrypt/live/muster.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/muster.example.com/privkey.pem;
  client_max_body_size 50m;                       # chat attachments
  location / {
    proxy_pass http://127.0.0.1:7470;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;       # the /events WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 1h;
  }
}
```

To serve TLS directly, use `--tls-cert fullchain.pem --tls-key privkey.pem`.

Binding beyond loopback (`--host 0.0.0.0`) requires `--allowed-host` for every name people use. The server refuses other `Host`
headers, which blocks DNS rebinding. Without TLS it warns at start.

## People, roles and access

SSO is not part of this release. Accounts are local: `init` creates the owner, everyone else joins through a **single-use invite link**
that expires. Passwords are hashed with scrypt.

| Role | Can |
| --- | --- |
| **owner** | Everything, including managing other owners. A server always keeps at least one active owner |
| **admin** | People, invites, project access, connectors, providers, folders, server-wide settings, cost, audit |
| **member** | Chats and tasks in the projects shared with them, their own private chats, their own API tokens |
| **viewer** | Reads the projects shared with them |

**Project access.** Owners and admins see every project. Members and viewers see the projects shared with them, either by an admin or
by the project's owner. Sharing uses the project roles the desktop app already has (owner, editor, viewer) and adds the person to the
project's **Roster**. A member who creates a project owns it. Chats started outside a project are private to the person who started
them.

```sh
muster-server users grant mel --project <project-id> --role editor
muster-server users ungrant mel --project <project-id>
```

**Revoke.** `muster-server users revoke <user>`, or **Revoke** in **Settings › Server**. The account is disabled and every session and
API token ends at once. Open browser tabs are disconnected immediately and sent back to sign-in. `users restore` reverses it.

**Sessions.** The session cookie is `HttpOnly` and `SameSite=Lax`, and `Secure` under TLS. It lasts 7 days. Every state-changing
browser request needs a CSRF token and a same-origin `Origin` header. Sign-in is rate limited per account and per address: after 5
failures the account is locked out, starting at 1 minute and doubling up to an hour.

**API tokens** (`mst_…`) are for scripts, the CLI and the desktop app: `muster-server token create --name ci --ttl 90d`. Only a hash
is stored. A token is shown once.

**Project owners invite to their own project.** In **Settings › Server › People on your projects** a project's owner can create a single-use
invite link for that project only, as someone who can work on it or can only look. Whoever accepts the link gets an account (member or
viewer) and that one project, and appears on its Roster. Owners can change roles on their project and take people off it. Admins can do all of this for every project.

## Remote agents

An agent that runs on another machine can join one project by invite (**Settings › Server › Remote agents**, or `muster-server agents invite`).
The invite is single use, expires (24 hours by default, at most 7 days) and is stored as a hash. On the agent's machine:

```sh
muster-server agent join https://muster.example.com --invite mai_…     # saves a 0600 credentials file, never printed
muster-server agent tasks                                               # what is assigned to it
muster-server agent comment OSS-12 "Reproduced the bug."
muster-server agent state OSS-12 implemented --comment "Fixed in #41"
muster-server agent wait --timeout 25                                   # returns when something changes in the project
```

The credential (`msa_…`) is scoped to that project and that one Roster member, is accepted only by the agent API (`/agent/v1/…`, never by
`/rpc`), and can read and report on the tasks assigned to it: comment, move to implemented, blocked or review, and save documents. Nothing
runs for a remote agent on the server. Revoke it any time (`muster-server agents revoke`): it stops at once and leaves the Roster.
Claims are rate limited and every step is in the audit chain.

## Connectors

A connector is one bot on one platform. You can run several per type, for example two Slack workspaces and three Telegram bots. Each
has a name, an owner, a scope (`org`, `project` or `user`), health, and routing rules.

| Type | Modes | Secrets |
| --- | --- | --- |
| Slack | `socket` (Socket Mode, works behind NAT) or `events` (signed HTTPS webhook) | `botToken` + `appToken` (socket) or `signingSecret` (events) |
| Telegram | `poll` (long polling) or `webhook` | `botToken` (+ `webhookSecret` for webhooks) |
| Mattermost | `websocket` (bot account, REST + WebSocket) | `botToken`; set `--config url=https://chat.example.com` |
| WhatsApp, Discord, Teams, Google Chat, email | Coming soon. They can be registered (and imported) but never start or report success | |

```sh
export SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-…
muster-server connectors add slack --name acme --secret botToken=env:SLACK_BOT_TOKEN --secret appToken=env:SLACK_APP_TOKEN
muster-server connectors route acme --project <project-id> --match "channel=#support" --mode task
muster-server connectors route acme --project <other-project> --mode reply          # everything else
muster-server connectors test acme
```

Secret values are never taken from the command line. Pass `env:VAR`, `file:PATH` or `stdin`. They are encrypted with the server key,
and the connector row only holds a reference.

**Routing.** Rules match on `channel`, `dm`, `mention`, `keyword`, `thread` and `sender` (`internal`, `guest` or `any`). The first
match by priority wins. A rule's mode is `reply`, which starts a chat in the project, or `task`, which creates a project task and starts
it. Replies are posted back to the same thread, and follow-ups in that thread continue the same Muster chat. In channels, the bot
answers only when it is mentioned or when the thread is already its own.

**Behaviour built in from running a team chat bot:**
- **Refusals are visible.** Guests, unrouted channels, unlinked senders (with `--config requireLink=true`), revoked users and read-only
  users get a reply that says why. A refused message never runs silently and never runs anyway.
- **Liveness.** Slack and Mattermost sockets send WebSocket pings and reconnect with backoff when a pong is missed. Slack `disconnect`
  envelopes are honoured. Health is `connecting`, `ok`, `degraded`, `down`, `unauth`, `disabled` or `unsupported`, shown in
  `muster-server status`, `connectors list` and **Settings › Server**.
- **Audience.** The agent is told who asked and that everyone in the channel reads the reply, with member and guest counts, so it does
  not put something meant only for the sender into a channel.
- **Guests are not internal.** Slack restricted users and Mattermost `system_guest` users are guests. Default routes never accept them;
  admitting them needs an explicit `sender=guest` or `sender=any` rule and `--config guestPolicy=allow`.

**Identity links.** `muster-server connectors link acme U024BE7LH mel` ties a platform user to a Muster account. Their turns are then
attributed to them and checked against their project access. Unlinked senders are attributed to the connector.

**Import from the Muster CLI gateway.**
`muster-server connectors import-gateway ~/.muster/gateway.json [--dry-run]` turns each configured channel into a connector named
`default-<type>` and moves its tokens into the encrypted store. Run it while the server is stopped.

### One-way notifications

A connector can also post, one way, what needs you in a project: new questions, approvals and status updates go to a channel. Set a channel and a
project (**Settings › Server › Chat channels › Routes and notices**, or `muster-server connectors config <name> --config notifyChannel=C123 --config
notifyProject=<project-id>`). The first run records what already exists instead of flooding the channel. Text is redacted for secrets, and nothing
said in the channel is read as a command by this path.

## Usage, cost and audit

Every agent turn is in the runtime's hash-chained **Ledger**: tokens, cost, tools and files changed. The server records who started
each turn (a person in the web UI, or a connector and the linked person), so cost can be reported per person:

```sh
muster-server cost report --since 30d --by user        # or --by project, --by model
muster-server audit verify                             # the server's audit chain and the turn Ledger chain
```

Turns on models without a price show as *unpriced*. Prices set under **Settings › Models** are applied. The server's own **audit chain**
records every sign-in (successful, failed or throttled), invite, role change, revoke, token, project-access change, connector change,
refusal, and who started each turn. Editing or deleting any past entry breaks the chain, and `audit verify` reports where.

## The web UI

The browser gets the desktop app's interface with a small bridge in place of Electron. Admins also get **Settings › Server**: people
and roles, invites, project access, usage and cost per person, active sessions, connector health and audit verification.

Some features run on the user's own computer, so the web UI shows them as **Desktop only** rather than as broken buttons: the built-in
browser, terminals and host commands, screen capture and computer use, Quick Look, opening files in other apps, and app updates. Native
menus become in-page menus. Exports download in the browser. **Add folder** asks admins for a path on the server, because a folder there
is a directory on the server, not on your computer. For members and viewers, appearance settings are kept per browser; server-wide
settings belong to admins.

## Connecting the desktop app

In the desktop app, open **Settings › Integrations › Muster Server**. It is optional and stays off until you connect. Enter the server
URL and either your username and password, or an API token. A password is exchanged once for a token and is not stored. The token is
kept in the macOS Keychain (or the Linux keyring) and is only ever sent to that server's address. Once connected, **Show projects**
lists the projects your account can open, and **Open** takes you to that project in the server's web UI.

## Backup and restore

```sh
muster-server backup --to /backups/muster-$(date +%F)
```

This writes `server.sqlite`, `server.json` and a `runtime/` folder with every runtime database and settings file. Databases are copied
with SQLite `VACUUM INTO`, which is safe while the server runs. **The secret key is not included.** Back up `keys/secret.key` separately, or keep `MUSTER_SERVER_SECRET_KEY`
in your secret manager. Without the key, stored provider and connector secrets cannot be read.

To restore: stop the server, then copy `server.sqlite`, `server.json` and the `runtime/` folder from the backup, and `keys/secret.key`,
into the data directory. Start the server and run `muster-server doctor`.

### Scheduled backups of the app databases

The runtime also backs up its own databases on a schedule (daily, keep 7, **Settings › Storage › Backups**; `muster-server backups list|run|restore|settings`).
Copies are consistent (`VACUUM INTO`), the folder is `0700` and the files `0600`, and secrets and their key are not included. A restore is checked
(hashes and SQLite's integrity check) and staged: it is applied when the server starts next, and the data it replaces is kept under `backups/before-restore`.

## Security notes

- Defaults: binds `127.0.0.1`, enforces the `Host` allow-list, and refuses unknown commands. Every runtime command passes a role check
  and a per-project check, and results are filtered to what the caller may see.
- Host-level actions are admin-only: providers and keys, extensions, MCP servers, registering folders and server-wide settings.
- The agent runtime runs as the server's OS user. Run it as a dedicated user with access only to the repositories it should work in.
- Secrets at rest: AES-256-GCM with the server key. Passwords use scrypt. Session and API tokens are stored as SHA-256 hashes.
- Data never leaves the server except to the model providers and chat platforms you configure.

**Not in this release:** SSO and OIDC (planned as an optional Settings feature), Postgres (the store sits behind an interface so it can
be added), multiple organisations per server, running agent jobs in per-run sandboxes, and the connector types marked coming soon.

## CLI reference

`muster-server <command> --help` prints this list. Every command accepts `--json` and `--data-dir`. Exit codes: `0` ok, `1` error,
`2` usage, `3` not running (`status`, `stop`).

| Command | What |
| --- | --- |
| `init [--username --name --password-stdin --host --port --allowed-host --public-url --tls-cert --tls-key --trust-proxy]` | Data dir, key, owner, local CLI token |
| `start [--host --port --allowed-host --tls-cert --tls-key --public-url --trust-proxy --detach]` | Run the server (flags are saved to `server.json`) |
| `stop`, `status`, `doctor`, `backup [--to]` | Lifecycle and checks |
| `invite [--role --expires --note]` | Single-use invite link |
| `users list \| role <u> <role> \| revoke <u> \| restore <u> \| grant <u> --project <id> [--role] \| ungrant <u> --project <id> \| reset-password <u>` | People and access |
| `token create [--user --name --ttl] \| list \| revoke <id>` | API tokens |
| `connectors list \| types \| add \| test \| enable \| disable \| remove \| route \| unroute \| link \| events \| import-gateway` | Connectors |
| `cost report [--since --by user\|project\|model]` | Usage and cost |
| `projects list \| show`, `tasks list \| show \| create \| state \| assign \| start \| comment`, `roster list \| add \| pause \| resume \| remove`, `approvals …`, `ledger` | The work layer on the running server (your token's role and project grants apply) |
| `org teams \| export \| import \| preview \| pending \| activate`, `backups list \| run \| restore \| settings` | Org packages and backups |
| `agents invite \| list \| revoke`, `agent join \| me \| tasks \| task \| comment \| state \| doc \| wait` | Remote agents |
| `audit verify \| list [--limit]` | Audit chain and Ledger chain |

The Muster CLI has the same commands as `muster server …`, which runs `muster-server` when it is installed.
