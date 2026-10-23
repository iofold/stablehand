# Security Policy

Stablehand runs untrusted, model-driven code inside sandbox containers and holds
credentials for model providers, object storage, and the tools your agents call.
We take reports about it seriously and appreciate the time it takes to write one.

## Reporting a Vulnerability

**Do not open a public issue, discussion, or pull request for a suspected
vulnerability.**

Report it privately through either channel:

- **GitHub private vulnerability reporting** — on
  [github.com/iofold/stablehand](https://github.com/iofold/stablehand), open the
  **Security** tab and choose **Report a vulnerability**.
- **Email** — [security@iofold.com](mailto:security@iofold.com).

Please include:

- the affected commit or version
- steps to reproduce, or a proof of concept
- the impact you expect: what an attacker can read, change, or run, and from
  where (another tenant, an agent inside a sandbox, an unauthenticated network
  client, and so on)
- whether credentials, user data, or infrastructure could be exposed
- a suggested fix or mitigation, if you have one

Do not include real secrets, production data, or another person's data in a
report. Redact anything you captured while reproducing the issue.

## What to Expect

- **Acknowledgement** within 3 business days.
- **Initial assessment** (whether we can reproduce it and how severe we think it
  is) within 10 business days.
- **Progress updates** at least every 14 days until the issue is resolved.
- **Coordinated disclosure.** We will agree a disclosure date with you, publish a
  GitHub security advisory when a fix is available, and credit you unless you ask
  us not to.

These are targets, not guarantees: Stablehand is maintained by a small team.

## Supported Versions

Stablehand is pre-1.0. Only the latest commit on the default branch (`master`)
receives security fixes. There are no backports to older commits or tags. Once 1.0 ships,
this section will list the supported release lines.

## Scope

In scope: the code in this repository — the orchestrator, sandbox daemon and
harness images, egress proxy, UI, client packages, Docker Compose and Kubernetes
manifests, and the `create-stablehand` scaffold.

Out of scope: vulnerabilities in third-party model providers, agent SDKs, or
container runtimes (report those upstream), and findings that require an
operator to disable a documented safeguard (for example
`STABLEHAND_AUTH_DISABLED=true`).

## Known Limitations

These are known gaps in the current security model. You do not need to report
them, but reports that show a practical way to exploit them are welcome.

- **Sandboxes receive provider API keys and object-store credentials.** Each
  sandbox container gets the model-provider API keys and the S3 access key and
  secret it needs in its environment. Code running inside a sandbox — including
  shell commands an agent runs — can read them. This lasts until the planned
  credential broker ships, at which point the egress proxy will add credentials
  to outbound requests and sandboxes will hold none by default.
- **The egress allowlist is enforced by an in-stack proxy.** Sandboxes sit on an
  internal Docker network whose only route out is the `egress` service (a
  mitmproxy-based proxy in `packages/egress-proxy`). The allowlist is only as
  strong as that proxy and the network isolation around it; it is not enforced
  by the host firewall or the kernel. Per-agent egress settings are tied to each
  sandbox's session credentials; while `STABLEHAND_EGRESS_UNLEASED=global` (the
  default, for upgrades), a sandbox that drops its credentials gets the server
  allowlist instead of its agent's setting. Kubernetes sandboxes are not routed
  through the proxy yet.
- **Approval for write actions is opt-in.** Human-in-the-loop approval applies to
  a tool only when you configure it. Out of the box, an agent can call write or
  side-effecting tools without asking anyone.
- **The Claude harness runs with permission checks bypassed.** The Claude Agents
  harness runs Claude Code with `permissionMode: 'bypassPermissions'` inside the
  sandbox, so it does not ask before running commands or editing files. The
  sandbox container is the boundary.
- **The orchestrator controls the Docker daemon.** In the Docker Compose stack
  the orchestrator mounts `/var/run/docker.sock` to start sandbox containers.
  Anyone who compromises the orchestrator can control the host's Docker daemon.
  Do not expose the orchestrator to untrusted networks, and always set
  `STABLEHAND_API_TOKEN`.
