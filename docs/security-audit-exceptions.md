# Security Audit Exceptions

CI gates production dependencies with `pnpm audit:prod` (`pnpm audit --prod --audit-level high`).
Advisories that cannot be remediated by upgrade are ignored via `pnpm.auditConfig.ignoreGhsas`
in the root `package.json` and must be documented here with a rationale and a review trigger.

## Process

1. Prefer remediation: bump the direct dependency, or add a `pnpm.overrides` entry pinning the
   transitive to a patched version (use exact pins — open-ended ranges can re-resolve into other
   vulnerable releases).
2. If no patched release exists, add the GHSA ID to `ignoreGhsas`, document it below, and note
   what event should trigger re-evaluation.
3. Re-run `pnpm audit --prod` (without the ignore list, temporarily) during release prep to catch
   newly published advisories against pinned versions.

## Active exceptions

| GHSA | Severity | Package | Rationale | Re-evaluate when |
| --- | --- | --- | --- | --- |
| GHSA-jfgx-wxx8-mp94 | high | `@mariozechner/pi-coding-agent` | Predictable temp extension-install paths enable local privilege escalation on *shared multi-user hosts*. Pi runs only inside single-tenant sandbox containers (one agent per container); no shared-host exposure. No patched release exists (advisory covers ≤0.73.1, latest). | Pi releases > 0.73.1, or Pi extensions are enabled on shared infrastructure. |
| GHSA-7v5m-pr3q-6453 | low | `@mariozechner/pi-coding-agent` | XSS via Pi's HTML session-export feature. CTXMill never invokes Pi session exports; transcripts flow through the AgentEvent pipeline. No patched release exists. | Pi releases > 0.73.1, or session-export is adopted. |
| GHSA-r95r-rj6r-c39x | low | `@mariozechner/pi-coding-agent` | Race in Pi's own `auth.json` credential store. CTXMill injects provider keys via the secrets pipeline (env), not Pi's auth store. No patched release exists. | Pi releases > 0.73.1, or Pi auth store is adopted. |

## Override pins

`pnpm.overrides` in the root `package.json` pins vulnerable transitives to patched releases
(protobufjs, hono, undici, ws, shell-quote, brace-expansion, and others). When bumping a direct
dependency that owns one of these chains, re-check whether the corresponding override is still
needed and drop it if upstream now resolves clean.
