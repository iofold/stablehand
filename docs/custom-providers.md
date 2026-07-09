# Custom API Providers

CTXMill agents can route through OpenRouter, Cloudflare AI Gateway, or any OpenAI-compatible endpoint, no code changes required. Just configure `baseUrl` and `apiKeyRef` in your agent manifest.

## How It Works

The `baseUrl` field in agent manifests overrides the default API endpoint. The provider SDK (ChatOpenAI, Anthropic SDK, etc.) sends requests to that URL instead. All three harnesses (LangGraph, Claude Agents, PI Agent) support this.

The `provider` field controls which SDK class is used, not which company. Set `provider: openai` to use the OpenAI SDK pointed at any OpenAI-compatible endpoint.

Canonical provider values are `openai`, `anthropic`, and `google`. Manifests and API requests also accept `gemini` as a compatibility alias, but CTXMill normalizes it to `google` before storage or execution. Unknown provider values are rejected during manifest/API validation.

## OpenRouter

### LangGraph Harness (OpenAI-compatible endpoint)

```yaml
apiVersion: ctxmill.io/v1
kind: Agent
metadata:
  name: openrouter-analyst
  displayName: OpenRouter Analyst
spec:
  harness: langgraph
  harnessConfig:
    provider: openai
    model: google/gemini-2.5-flash    # OpenRouter model format: provider/model
    baseUrl: https://openrouter.ai/api/v1
    apiKeyRef: "$secret:OPENAI_API_KEY"   # Set OPENAI_API_KEY to your OpenRouter key
  instructions: |
    You are an analyst powered by Gemini via OpenRouter.
  tools: []
```

Set the `OPENAI_API_KEY` env var to your OpenRouter API key (format: `sk-or-v1-...`). Model names use the `provider/model` format. Any model on OpenRouter works, `openai/gpt-5.4`, `anthropic/claude-sonnet-4-6`, `google/gemini-2.5-flash`, `meta-llama/llama-4-maverick`, etc.

### Claude Agents Harness (Anthropic-compatible endpoint)

```yaml
apiVersion: ctxmill.io/v1
kind: Agent
metadata:
  name: openrouter-writer
  displayName: OpenRouter Writer
spec:
  harness: claude-agents
  harnessConfig:
    provider: anthropic
    model: anthropic/claude-sonnet-4-6
    baseUrl: https://openrouter.ai/api
    apiKeyRef: "$secret:ANTHROPIC_API_KEY"   # Set ANTHROPIC_API_KEY to your OpenRouter key
  instructions: |
    You are a writer powered by Claude via OpenRouter.
  tools: []
```

OpenRouter has a native Anthropic Messages API endpoint at `/api/v1/messages`. The Claude Agents harness sets `ANTHROPIC_BASE_URL` from the `baseUrl` config. The Anthropic SDK appends `/v1/messages` to the base URL, so set `baseUrl` to `https://openrouter.ai/api`. This supports extended thinking, tool use, and all Anthropic features.

### PI Agent Harness

```yaml
spec:
  harness: pi-agent
  harnessConfig:
    provider: openai
    model: google/gemini-2.5-flash
    baseUrl: https://openrouter.ai/api/v1
    apiKeyRef: "$secret:OPENAI_API_KEY"
```

When `baseUrl` is set, PI Agent uses the OpenAI-completions API format regardless of the `provider` field.

### OpenRouter Multimodal Support

OpenRouter supports images (`image_url`), audio (`input_audio`), video (`video_url`), and PDFs (`file` content type) through the same `/chat/completions` endpoint. Vision and audio use standard OpenAI content types. PDF and video use OpenRouter-specific types (`file`, `video_url`) which may require raw message passthrough rather than SDK-level serialization.

## Cloudflare AI Gateway

Cloudflare AI Gateway is a transparent proxy that adds caching, rate limiting, and analytics. It supports two modes.

### Provider-Native Proxy (transparent, no format changes)

URL pattern: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{provider}`

For LangGraph + OpenAI:

```yaml
harnessConfig:
  provider: openai
  model: gpt-5.4-mini
  baseUrl: https://gateway.ai.cloudflare.com/v1/YOUR_ACCOUNT_ID/YOUR_GATEWAY_ID/openai
  apiKeyRef: "$secret:OPENAI_API_KEY"    # Your actual OpenAI key, gateway passes it through
```

For Claude Agents + Anthropic:

```yaml
harnessConfig:
  provider: anthropic
  model: claude-sonnet-4-6
  baseUrl: https://gateway.ai.cloudflare.com/v1/YOUR_ACCOUNT_ID/YOUR_GATEWAY_ID/anthropic
  apiKeyRef: "$secret:ANTHROPIC_API_KEY"
```

Requests are forwarded unchanged to the real provider API. Your actual provider API key is used. The gateway proxies transparently.

### Unified API (OpenAI-compatible, multi-provider)

```yaml
harnessConfig:
  provider: openai
  model: anthropic/claude-sonnet-4-5    # provider/model format
  baseUrl: https://gateway.ai.cloudflare.com/v1/YOUR_ACCOUNT_ID/YOUR_GATEWAY_ID/compat
  apiKeyRef: "$secret:ANTHROPIC_API_KEY"   # The actual provider key for the model
```

This is a single endpoint that accepts OpenAI format and routes to any provider. Model format is `provider/model`. The provider key is passed in the standard auth header.

### Authenticated Gateways caveat

If your Cloudflare gateway has authentication enabled, it requires a `cf-aig-authorization` header. CTXMill agent manifests don't currently support custom headers, so either:

- Disable gateway authentication in the Cloudflare dashboard, or
- Use BYOK (Bring Your Own Keys) stored in Cloudflare. The gateway token goes in `apiKeyRef` and Cloudflare injects the provider key server-side.

## Any OpenAI-Compatible Provider

Generic pattern for vLLM, Ollama, LiteLLM, Together AI, Fireworks, etc.:

```yaml
harnessConfig:
  provider: openai
  model: your-model-name
  baseUrl: https://your-provider.com/v1
  apiKeyRef: "$secret:OPENAI_API_KEY"
```

Any endpoint that accepts the OpenAI `/v1/chat/completions` format works. Set `provider: openai`, point `baseUrl` at the provider, and set `OPENAI_API_KEY` to whatever auth token the provider expects.

## Environment Setup

Add these to your `.env` file.

```bash
# OpenRouter
OPENAI_API_KEY=sk-or-v1-your-openrouter-key

# Or for Claude Agents harness via OpenRouter Anthropic endpoint
ANTHROPIC_API_KEY=sk-or-v1-your-openrouter-key

# Cloudflare AI Gateway (use your actual provider keys, gateway is transparent)
OPENAI_API_KEY=sk-your-openai-key
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key
```

The following **host environment variables** are forwarded to sandbox containers via the orchestrator allowlist.

| Env Var | Forwarded to Sandbox | Notes |
|---------|---------------------|-------|
| `OPENAI_API_KEY` | ✅ Yes | In secret allowlist |
| `ANTHROPIC_API_KEY` | ✅ Yes | In secret allowlist |
| `GOOGLE_API_KEY` | ✅ Yes | In secret allowlist |
| `OPENAI_BASE_URL` | ✅ Yes | In secret allowlist |

There is no `OPENROUTER_API_KEY` env var. Reuse `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` with your OpenRouter key.

### Current behavior for custom secret keys

Two different secret paths exist today:

1. **Host env passthrough** — only keys in the orchestrator's hardcoded sandbox allowlist are forwarded.
2. **Per-agent Secret Store** — all keys stored for a specific agent are currently injected into that agent's sandbox as environment variables.

So if you need a custom key such as `OPENROUTER_API_KEY`, `MY_INTERNAL_TOKEN`, or `CUSTOM_BASE_URL`, the supported behavior today is:

- store it under **Agent → Secrets**
- reference it from your harness/tooling by that exact env-var name inside the sandbox

That is different from host env passthrough: adding `OPENROUTER_API_KEY` to the orchestrator shell or compose env alone does **not** forward it unless the codebase adds it to `SANDBOX_SECRET_ALLOWLIST`.

### Caveat: HTTP tool provider fallback

The HTTP tool provider has a separate fallback path on the orchestrator side: if a required secret is not found in the pre-resolved agent secret map, it still falls back to `process.env[secretName]`.

That means:

- **sandbox secret injection** is constrained by the host allowlist + agent secret store merge
- **HTTP tool auth resolution** is currently broader because it can still read arbitrary orchestrator env names directly

## Quick Reference Table

| Provider | Harness | `provider` | `baseUrl` | `model` format | API Key |
|----------|---------|------------|-----------|----------------|---------|
| OpenRouter (OpenAI compat) | LangGraph / PI Agent | `openai` | `https://openrouter.ai/api/v1` | `provider/model` | OpenRouter key as `OPENAI_API_KEY` |
| OpenRouter (Anthropic compat) | Claude Agents | `anthropic` | `https://openrouter.ai/api` | `anthropic/model` or just `model` | OpenRouter key as `ANTHROPIC_API_KEY` |
| CF AI Gateway (native) | Any | Match provider | `https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/{provider}` | Provider's native format | Actual provider key |
| CF AI Gateway (unified) | LangGraph / PI Agent | `openai` | `https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/compat` | `provider/model` | Actual provider key |
| vLLM / Ollama / LiteLLM | LangGraph / PI Agent | `openai` | Your endpoint URL | Model name | Your auth token as `OPENAI_API_KEY` |

Use only canonical provider values in persisted examples: `openai`, `anthropic`, or `google`. `gemini` remains accepted as an input alias for `google`.
