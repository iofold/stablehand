# artifact-gallery

A self-hosted public gallery of the files your agents publish. The [Overnight Analyst](../../packages/examples/overnight-analyst) uses it as the page where each morning's brief appears.

It is also the reference extension. It runs as its own process beside Stablehand, holds a scoped key with two capabilities, learns about new files from webhooks and the read API, and keeps state you can delete and rebuild. [EXTENDING.md](../../EXTENDING.md) describes that contract.

## What it does

- Receives `artifact.created` webhooks and checks their HMAC signature. A periodic sweep of the read API backfills history and finds agents whose first artifact predates the webhook.
- Registers its own webhook for each agent it learns about from artifact payloads, so the key never needs to list agents.
- Caches images, HTML, SVG, text and JSON files up to 20 MB in a local directory and serves a dark gallery at `/`, with stable links at `/a/:artifactId`. HTML and SVG are served under a sandboxing Content-Security-Policy, and every response sets `nosniff`.
- Treats `data/` as a projection. Delete it and the next sweep rebuilds it from Stablehand.

## Capabilities

```text
artifacts:read
webhooks:manage
```

On startup the service calls one allowed endpoint and one master-only endpoint, and logs a warning if the key can reach the second.

## Run

### With the stack

The default stack runs it: [docker-compose.yml](docker-compose.yml) in this directory is a compose overlay, and `.env.example` lists it in `COMPOSE_FILE`. It serves http://localhost:8090 (`GALLERY_PORT`) from the `ghcr.io/iofold/stablehand-gallery` image, or builds it from this directory. Two settings in `.env` connect it:

- `GALLERY_API_KEY`: the scoped key. The [Overnight Analyst seed](../../packages/examples/overnight-analyst) creates one bound to that agent and prints it once; [install.sh](../../install.sh) saves it for you.
- `GALLERY_WEBHOOK_SECRET`: any random string, for example `openssl rand -hex 24`.

Until both are set, the page says which one is missing. After setting them, run `docker compose up -d gallery`. Webhooks reach it at `http://gallery:8090` on the compose network; the overlay adds `gallery` to `STABLEHAND_EGRESS_ALLOWLIST` so the orchestrator may deliver to that private address. If you set that variable yourself, include `gallery` in it.

### On its own

```bash
export STABLEHAND_BASE_URL=https://your-stablehand
export STABLEHAND_API_KEY=cmk_...            # scoped key from Settings, Access keys
export GALLERY_WEBHOOK_SECRET=$(openssl rand -hex 24)
export GALLERY_PUBLIC_URL=https://gallery.example.com   # must be reachable by Stablehand
export GALLERY_PORT=8090                  # optional
export GALLERY_DATA_DIR=./data            # optional

bun run src/server.ts
```

`GET /healthz` reports the index size and webhook coverage, or `503` with the missing settings while it is not connected.

## Uninstall

Stop the service, revoke the scoped key under Settings, Access keys, and delete the webhooks it registered (listed per agent at `GET /api/agents/:id/webhooks`). The `data/` directory holds nothing you cannot rebuild.
