# Extending CTXMill today

CTXMill extensions are deliberately not first-class database objects. Today an
extension is a Git-pinned codebase plus an independently deployed process, a
scoped CTXMill API key, and optional webhook, event, artifact, tool, or agent
integration. Git remains the source of truth for its definitions and deployment
configuration; CTXMill does not install, discover, or upgrade extension repos.

This boundary keeps extension release cadence, state, and UI ownership outside
the core control plane while giving each integration a reviewable API blast
radius.

## Current handshake

There is no OAuth or marketplace install handshake. Installation is an operator
workflow:

1. Pin and review the extension source from Git, including its requested
   capability list and external destinations.
2. Deploy its service and extension-owned datastore beside CTXMill.
3. In **Settings → Access keys**, create a named scoped key with only those
   capabilities. Copy the one-time value into the extension's secret store.
4. Configure the extension with the CTXMill API base URL and bearer token.
5. Let the extension register only the webhooks or schedules it owns, or have
   the operator provision them explicitly.
6. Probe a required endpoint and a deliberately forbidden endpoint. A scoped
   key receives typed `403` errors for missing capabilities and master-only
   routes.
7. On uninstall, stop the service, revoke the key, and explicitly remove or
   retain resources it created.

See [Scoped API keys](docs/scoped-api-keys.md) for the capability matrix,
examples, rotation, and verification contract.

## Where extension UI lives

An extension that needs a dashboard owns and hosts that dashboard. The CTXMill
UI remains an operator control plane and does not currently provide an
extension registry, launcher, iframe host, or arbitrary navigation injection.
The extension can be exposed on its own origin or through the deployment's
reverse proxy and linked from deployment documentation.

Use core surfaces when the output naturally belongs there:

- Use agent-driven A2UI blocks for structured visuals inside a conversation.
- Store durable files and reports as artifacts so they appear in the Artifacts
  page.
- Emit `custom.*` events for inspectable lifecycle/provenance in the Events
  page and for operator-defined trigger composition.
- Use HITL interrupts when an operator must approve or provide structured
  input before work continues.
- Use the extension's own application for cross-agent analytics, specialized
  workflows, or persistent dashboards.

This is a product boundary, not a missing handshake step: adding a generic
Extensions page without an install/runtime registry would create a directory of
links that core cannot validate, authorize, health-check, or lifecycle-manage.

## State ownership

Use four homes for four kinds of state:

1. Definitions, schemas, prompts, agent templates, and deployment manifests
   live in the extension's Git repository.
2. Operational projections and indexes live in the extension's own database
   and database role. Do not grant it SQL access to CTXMill's database.
3. Large durable payloads live in CTXMill's artifact store and are referenced by
   artifact ID and SHA-256 where integrity matters.
4. The extension service's scoped key and webhook verification secrets live in
   its own secret store. Secrets needed by CTXMill agents live in CTXMill's
   agent secret store.

An extension database should be rebuildable from Git definitions plus retained
core events and artifacts. If losing it destroys irreplaceable source data, the
state is in the wrong place.

## Minimal example

An artifact-gallery extension that renders existing artifacts and manages its
delivery subscription requests:

```text
artifacts:read
webhooks:manage
```

It does not need artifact write/delete, agent execution, workspace, secret,
settings, or key-administration access. If it later publishes derived
artifacts, review a new key or rotation adding `artifacts:write`; do not hand it
the master token for convenience.

The supported integration contracts are the strict schemas in
`@ctxmill/contracts`, the authenticated client in `@ctxmill/client`, the REST
and streaming API in [the API reference](docs/api-reference.md), and the
extension-owned Git revision. A future registry or marketplace can automate
this workflow, but it is not part of the shipped handshake today.
