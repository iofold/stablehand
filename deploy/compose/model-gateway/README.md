# Optional LiteLLM model gateway

This overlay enables the deployment-scoped `default` gateway profile without
changing agent manifests or STABLEHAND budget policies. Direct-only deployments
do not use this file and have no LiteLLM dependency.

The image is LiteLLM 1.93.0, pinned by digest. The derived image replaces
`pyasn1` 0.6.3 with 0.6.4; the pinned base image and patch must be reviewed
together during upgrades.

The image also carries a source-hash-guarded backport of LiteLLM commits
[`8b965880`](https://github.com/BerriAI/litellm/commit/8b965880efd8e28321c1db74850fbb2b6f59242c)
and [`a39c3587`](https://github.com/BerriAI/litellm/commit/a39c35878569f74c50de3295320457dd7bd6adb2).
It prevents the in-memory cold-reseed path from adding an already populated
database balance twice and serializes signed spend deltas with that reseed.
Source drift fails the image build before either file is written. This does
not change spend rows, limits, TTL settings or settlement/reset policy.

The narrow fix is not a general hard-budget certification. An independently
reproduced expired-counter/late-settlement defect remains in the pinned release.

For the exact live-image base verified against dev2's full OCI configuration
and all 27 root filesystem layers,
`Dockerfile.budget-backport` builds only this correction; it neither rebuilds
the application stack nor runs the bootstrap/key-update script. The checked-in
base digest is a locally available image, not a promise of a public registry tag.
The local alias is created from the unchanged `ctxmill/litellm` image object:

```bash
docker image tag \
  ctxmill/litellm@sha256:5d7947208781a17105b056a86fc98316f78ccc9b1097e35241329beea77b0899 \
  ctxmill-litellm-live-base:20260928-5d794720
DOCKER_BUILDKIT=0 docker build --network=none --pull=false \
  -t ctxmill-litellm-budget-fix:20260928-live-base-review \
  -f deploy/compose/model-gateway/Dockerfile.budget-backport .
```

The legacy builder resolves this imported local OCI index by its pinned digest;
BuildKit attempted an unavailable registry lookup. Verify the resulting image's
full runtime Config and base-layer prefix before using it. The initial
`20260928-upstream-review` candidate used a nonidentical base and is superseded.

Run the offline regressions inside the candidate image with no network:

```bash
docker run --rm -i --network=none --read-only \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --cpus=2 --memory=1g --pids-limit=128 \
  --tmpfs /tmp:rw,nosuid,nodev,size=67108864 \
  --env LITELLM_LOCAL_MODEL_COST_MAP=True --env PYTHONDONTWRITEBYTECODE=1 \
  --entrypoint=/app/.venv/bin/python \
  ctxmill-litellm-budget-fix:20260928-live-base-review -I -B - SpendReseedTests \
  < deploy/compose/model-gateway/test_spend_reseed.py
```

`ExistingAccountingGap` selects the separate diagnostic. It intentionally
fails on both the baseline and this candidate; it is not silently skipped or
counted as a passing regression. Running the script without a class selector
includes that diagnostic and therefore returns a nonzero status.

## Credentials

Provide these through the deployment secret store:

- `LITELLM_MASTER_KEY`: LiteLLM administration key.
- `LITELLM_SALT_KEY`: stable LiteLLM encryption salt, at least 32 bytes.
- `LITELLM_DATABASE_PASSWORD`: password for the separate LiteLLM database.
- `STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY`: a LiteLLM virtual key restricted to the
  listed inference aliases. It enters sandboxes.
- `STABLEHAND_MODEL_GATEWAY_METERING_KEY`: a key allowed to read
  `/spend/logs/v2`. It stays in the orchestrator.
- `STABLEHAND_MODEL_GATEWAY_REVISION`: non-secret release/credential revision.
- Provider credentials for the configured inventory: `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, plus
  `CLOUDFLARE_ACCOUNT_ID` and a durable Workers AI API token in
  `CLOUDFLARE_API_KEY`. `OPENROUTER_API_KEY` is required only when using the
  optional `glm-5.2` alias.

Generate the runtime virtual key after LiteLLM is healthy:

```bash
curl -fsS http://127.0.0.1:4400/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "models": [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-opus-5",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "cf-gpt-oss-120b",
      "cf-kimi-k2.7-code",
      "cf-glm-5.2",
      "cf-glm-5.2-no-thinking",
      "cf-gemma-4-26b",
      "cf-qwen3-30b",
      "gpt-5.4-mini",
      "gpt-5.4",
      "claude-sonnet-4-6",
      "claude-opus-4-6"
    ],
    "key_alias": "stablehand-runtime"
  }'
```

Store the returned `key` as `STABLEHAND_MODEL_GATEWAY_RUNTIME_KEY`. The runtime
key must fail against spend and administration endpoints. Use a separate
read-only metering key when the selected LiteLLM edition supports that role;
otherwise the deployment admin key is the temporary metering credential.

## Start

```bash
docker compose \
  -f docker-compose.yml \
  -f deploy/compose/model-gateway/docker-compose.yml \
  up --build -d
```

The overlay exposes LiteLLM only on host loopback at port 4400 and on the
internal `stablehand-agents` network. Its admin UI is also published through
Traefik on the external `web` network, so that network must exist
(`docker network create web` on hosts without Traefik). Message/response logging is disabled.
STABLEHAND polls sanitized spend records asynchronously; gateway or metering
failure never causes a synchronous budget API dependency or silent direct
fallback.

## Operational trap: partial compose invocations

This overlay is only active when it is part of the compose file list. A plain
`docker compose up -d orchestrator` from the repo root recreates the
orchestrator **without** any `STABLEHAND_MODEL_GATEWAY_*` variables — spend
ingestion turns off silently while turns keep running (ctx-fpi1). On dev1 this
is prevented by pinning the full file list in `.env`:

```
COMPOSE_FILE=docker-compose.yml:deploy/compose/traefik/docker-compose.yml:docker-compose.override.yml:deploy/compose/model-gateway/docker-compose.yml
```

If ingestion is ever off with gateway turns waiting, `/api/model-gateway/status`
reports `state: degraded` with an `awaitingTurns` count, the orchestrator warns
at boot, and Analytics shows an under-counting banner.
