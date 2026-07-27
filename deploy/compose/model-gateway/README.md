# Optional LiteLLM model gateway

This overlay enables the deployment-scoped `default` gateway profile without
changing agent manifests or CTXMILL budget policies. Direct-only deployments
do not use this file and have no LiteLLM dependency.

The image is LiteLLM 1.93.0, pinned by digest. The derived image replaces
`pyasn1` 0.6.3 with 0.6.4; the pinned base image and patch must be reviewed
together during upgrades.

## Credentials

Provide these through the deployment secret store:

- `LITELLM_MASTER_KEY`: LiteLLM administration key.
- `LITELLM_SALT_KEY`: stable LiteLLM encryption salt, at least 32 bytes.
- `LITELLM_DATABASE_PASSWORD`: password for the separate LiteLLM database.
- `CTXMILL_MODEL_GATEWAY_RUNTIME_KEY`: a LiteLLM virtual key restricted to the
  listed inference aliases. It enters sandboxes.
- `CTXMILL_MODEL_GATEWAY_METERING_KEY`: a key allowed to read
  `/spend/logs/v2`. It stays in the orchestrator.
- `CTXMILL_MODEL_GATEWAY_REVISION`: non-secret release/credential revision.
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
    "key_alias": "ctxmill-runtime"
  }'
```

Store the returned `key` as `CTXMILL_MODEL_GATEWAY_RUNTIME_KEY`. The runtime
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
internal `ctxmill-agents` network. Message/response logging is disabled.
CTXMILL polls sanitized spend records asynchronously; gateway or metering
failure never causes a synchronous budget API dependency or silent direct
fallback.
