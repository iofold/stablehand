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

```bash
export STABLEHAND_BASE_URL=https://your-stablehand
export STABLEHAND_API_KEY=cmk_...            # scoped key from Settings, Access keys
export GALLERY_WEBHOOK_SECRET=$(openssl rand -hex 24)
export GALLERY_PUBLIC_URL=https://gallery.example.com   # must be reachable by Stablehand
export GALLERY_PORT=8090                  # optional
export GALLERY_DATA_DIR=./data            # optional

bun run src/server.ts    # or: node --experimental-strip-types src/server.ts
```

`GET /healthz` reports the index size and webhook coverage.

## Uninstall

Stop the service, revoke the scoped key under Settings, Access keys, and delete the webhooks it registered (listed per agent at `GET /api/agents/:id/webhooks`). The `data/` directory holds nothing you cannot rebuild.
