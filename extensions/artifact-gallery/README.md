# artifact-gallery

Reference Stablehand extension: a public, self-hosted gallery of agent-published
artifacts. It exists to prove the extension contract by consumption — an
out-of-process service, a least-privilege scoped key, webhook + read-API
integration, and its own rebuildable state — while giving every demo run a
visible destination.

## What it does

- Ingests `artifact.created` webhook deliveries (HMAC-verified) and runs a
  periodic read-API sweep that both backfills history and discovers agents
  whose first artifact predates their webhook registration.
- Registers its own webhook per known agent — agents are learned from
  artifact payloads, so the key never needs agent enumeration.
- Caches visual artifact blobs (images, HTML, SVG, text, JSON ≤ 20 MB) in a
  local directory and serves a dark-themed gallery at `/` with stable public
  links at `/a/:artifactId`. HTML/SVG artifacts are served behind a
  sandboxing CSP; everything is `nosniff`.
- The local store (`data/`) is a projection: delete it and the next sweep
  rebuilds it from Stablehand.

## Capabilities

```text
artifacts:read
webhooks:manage
```

Nothing else. On startup the service probes one allowed endpoint and one
master-only endpoint and warns loudly if the key turns out to be
over-privileged.

## Run

```bash
export STABLEHAND_BASE_URL=https://your-stablehand
export STABLEHAND_API_KEY=cmk_...            # scoped key from Settings → Access keys
export GALLERY_WEBHOOK_SECRET=$(openssl rand -hex 24)
export GALLERY_PUBLIC_URL=https://gallery.example.com   # must be reachable by Stablehand
export GALLERY_PORT=8090                  # optional
export GALLERY_DATA_DIR=./data            # optional

bun run src/server.ts    # or: node --experimental-strip-types src/server.ts
```

`GET /healthz` reports the index size and webhook coverage.

## Uninstall

Per the EXTENDING.md handshake: stop the service, revoke the scoped key in
Settings → Access keys, and delete the webhooks it registered (visible per
agent under `GET /api/agents/:id/webhooks`). The `data/` directory holds no
irreplaceable state.
