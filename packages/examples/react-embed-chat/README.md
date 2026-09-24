# Stablehand React Embed Chat Example

This example shows a product-style React integration using `@stablehand/react` on top of the external AG-UI route.

```bash
VITE_STABLEHAND_AGENT_ID=<agent-id> pnpm -C packages/examples/react-embed-chat dev
```

Defaults:

- `VITE_STABLEHAND_API_BASE=/api`
- Vite proxies `/api` to `http://localhost:3002`
- `STABLEHAND_EMBED_EXAMPLE_PORT=3300`

The app exercises the same surfaces a downstream product uses: run-scoped AG-UI streaming, HITL resolution, and A2UI component rendering through a registry.
