# Working With Skills

> Current status as of 2026-07-06: Stablehand does not have an active first-class
> skill registry, `{{skills}}` prompt injection, or `spec.workspace.content.skills`
> manifest field. Older plan docs may describe those features, but they are not
> current runtime behavior.

## What Works Today

Skills are best treated as SDK-native workspace files:

- Claude Agents can use Claude-style skill directories when those files are
  present in the sandbox workspace and the relevant native tool allowlist allows
  skill access.
- LangGraph and PI Agent do not receive a Stablehand-generated `{{skills}}`
  prompt block.
- Workspace content is controlled by the manifest workspace fields that are
  actually supported by `manifest/validate.ts` and the workspace preparation
  code, such as file copies and setup symlinks.

## Recommended Pattern

Place skill-like instructions or assets in your project workspace and copy or
symlink them into the sandbox with supported workspace setup fields. For Claude
Agents, use the SDK's expected `.claude/skills/...` layout when you want the
Claude SDK to discover a skill.

Example project layout:

```text
agents/my-agent/agent.yaml
workspace/
  .claude/
    skills/
      code-review/
        SKILL.md
        references/
          checklist.md
```

Then configure the agent workspace setup to make those files available inside
the session workspace. Keep the instructions explicit in the agent manifest when
you need harness-agnostic behavior.

## What Not To Use

These are not current runtime features:

- `spec.workspace.content.skills`
- `{{skills}}` placeholder injection
- automatic seeding into `.stablehand/skills`
- a Stablehand-managed skill catalog exposed through the API/UI

## Related Code

- [manifest/validate.ts](../packages/manifest/src/validate.ts)
- [manifest/types.ts](../packages/manifest/src/types.ts)
- [workspace-preparation.ts](../packages/stablehand/src/sandbox/workspace-preparation.ts)
- [claude-agents.ts](../packages/sandbox-daemon/src/harness/claude-agents.ts)

## Gotchas

- `docs/plans/` and older proposals may still use "skill" to mean a planned
  Stablehand abstraction. Treat those as historical unless the code paths above
  implement the feature.
- The workspace tar upload API rejects `.stablehand/`; do not rely on
  `.stablehand/skills` as an upload target.
