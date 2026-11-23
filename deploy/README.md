# Deploy

The game runs as one tiny Node process behind Caddy, on the same box as the
rest of stef000.dev.

## What goes where

Everything lives in **`/home/ubuntu/8ball`** and nothing outside it:

```
/home/ubuntu/8ball/
  dist/            built client, served by the Node process
  server.mjs       the whole server, one bundled file
  package.json     only needs ws
  node_modules/    ws
```

Two files live outside, because that is where the system wants them:
`/etc/systemd/system/8ball.service` and `/etc/caddy/Caddyfile`.

## Build and copy

One command produces all three artefacts, so the client and the server can never
be a build apart:

```bash
npm run build:release
```

It writes:

```
dist/                 built client
build/server.mjs      the whole server, one bundled file
build/package.json    its runtime dependency (ws), generated from this project
```

Then copy them:

```bash
scp -r dist sfu:/home/ubuntu/8ball/
scp build/server.mjs build/package.json sfu:/home/ubuntu/8ball/
ssh sfu 'cd /home/ubuntu/8ball && npm install --omit=dev'
ssh sfu 'sudo systemctl restart 8ball'
```

`ws` is deliberately **not** bundled: its CommonJS internals call `require`,
which cannot run inside an ESM bundle.

The server listens on `127.0.0.1:8787` only. Caddy terminates TLS and proxies
to it, so port 8787 is never exposed.

## Files in this folder

- `8ball.service` — the systemd unit.
- `Caddyfile.snippet` — the block appended to `/etc/caddy/Caddyfile`.

DNS is a single `A` record: `8ball` → the VPS address, **DNS only** in
Cloudflare, so Caddy can complete its own ACME challenge.
