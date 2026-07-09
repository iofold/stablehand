# Subagents & Workspace Setup

You can extend your agents in two ways:

1.  **Subagents**: A ctxmill-level abstraction for delegating tasks to specialized models.
2.  **Workspace setup**: Generic symlink mappings for SDK-specific file discovery.

Skills, hooks, and settings files aren't managed by ctxmill. These are user content in the workspace tarball. Use `setup.symlinks` to bridge your directory layout to SDK expectations.

## Workspace Setup (setup.symlinks)

SDKs expect files in specific locations like `.claude/skills/` or `.claude/settings.json`. You define symlink mappings instead of having ctxmill copy files around.

```yaml
spec:
  harnessConfig:
    setup:
      symlinks:
        - src: skills           # Your skills directory
          dest: .claude/skills  # Where Claude SDK looks
        - src: settings.json
          dest: .claude/settings.json
```

Paths are relative to the workspace root. Symlinks are created after workspace preparation, before the harness starts.

For example, you upload a tarball with `skills/code-review/SKILL.md` and configure a symlink to `.claude/skills`. The Claude SDK then auto-discovers it.

For LangGraph, keep skill-like instructions explicit in workspace files or harness configuration. CTXMill does not currently auto-seed `.ctxmill/skills`.

## Skills (User-Managed)

Skills are user content. ctxmill doesn't manage them. You include skills in your workspace tarball under any directory you choose.

The `SKILL.md` format with YAML frontmatter is an SDK convention, not a ctxmill convention.
*   **Claude Agents**: Place in a directory and symlink to `.claude/skills/`.
*   **LangGraph**: Keep instructions in workspace files or harness-specific configuration; CTXMill does not manage a skill catalog for it.

See [Writing a Skill](writing-skills.md) for `SKILL.md` format reference.

## Subagents

Subagents allow a parent agent to delegate complex or specialized tasks to other agents. This is the one ctxmill-level abstraction. It handles model instantiation and API key resolution.

### Claude Agents Harness

In the Claude Agents harness, subagents are defined as a map (Record) in `harnessConfig.subagents`.

**Fields:**
*   `description`: (Required) Summary of the subagent's purpose.
*   `prompt`: (Required) System instructions for the subagent.
*   `tools`: List of tool names to allow.
*   `disallowedTools`: List of tool names to block.
*   `model`: Model ID override (e.g., `sonnet`, `opus`, `haiku`, or a full ID like `claude-sonnet-4-6`).
*   `maxTurns`: Maximum agentic turns before stopping.

**Example Manifest:**

```yaml
apiVersion: ctxmill.io/v1
kind: Agent
metadata:
  name: manager-claude
spec:
  harness: claude-agents
  harnessConfig:
    model: claude-sonnet-4-6
    subagents:
      researcher:
        description: "Performs deep research on technical topics"
        prompt: "You are a research specialist. Use search tools to find facts."
        model: claude-haiku-4-5
        tools: ["web_search"]
```

### LangGraph Harness

In the LangGraph harness, subagents are defined as an array of objects in `harnessConfig.subagents`.

**Fields:**
*   `name`: (Required) Unique identifier for the subagent.
*   `description`: (Required) Summary of the subagent's purpose.
*   `systemPrompt`: (Required) System instructions for the subagent.
*   `provider`: Provider override (`openai`, `anthropic`, `google`).
*   `model`: Model ID override.
*   `apiKeyRef`: Secret reference for a subagent-specific API key (e.g., `$secret:GOOGLE_API_KEY`).
*   `tools`: List of tool names to allow.
*   `temperature`: Temperature override.
*   `maxTokens`: Max tokens override.

**Example Manifest:**

```yaml
apiVersion: ctxmill.io/v1
kind: Agent
metadata:
  name: manager-langgraph
spec:
  harness: langgraph
  harnessConfig:
    provider: openai
    model: gpt-5.4
    subagents:
      - name: visualizer
        description: "Generates charts and diagrams"
        systemPrompt: "You are a data visualization expert."
        provider: google
        model: gemini-3-flash-preview
        apiKeyRef: "$secret:GOOGLE_API_KEY"
```

## Hooks (SDK-Managed)

- ctxmill does NOT manage hooks at the config level
- For Claude Agents: hooks are configured via `.claude/settings.json` in the workspace. Include the file in your tarball, use `setup.symlinks` if it lives elsewhere:
  ```yaml
  harnessConfig:
    setup:
      symlinks:
        - src: my-hooks.json
          dest: .claude/settings.json
  ```
  The Claude SDK auto-discovers hooks from `.claude/settings.json` when `settingSources: ["project"]` is active (always enabled).
  
  Example `.claude/settings.json`:
  ```json
  {
    "hooks": {
      "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./validate-bash.sh" }] }],
      "PostToolUse": [{ "matcher": ".*", "hooks": [{ "type": "command", "command": "./log-tool-use.sh" }] }]
    }
  }
  ```

- For LangGraph: hooks middleware is NOT supported by ctxmill. If you need custom hooks, build a custom harness image extending the ctxmill LangGraph base image (`ctxmill/harness-langgraph`) with your own middleware.

- For PI Agent: hooks are managed by the PI SDK's extension system. Include extensions in your workspace tarball.

## Workspace Tarball Structure

```text
workspace.tar.gz
├── skills/                    # Your skills (any directory name)
│   └── code-review/
│       └── SKILL.md
├── my-hooks.json              # Your hooks config
├── agents/                    # Your subagent definitions
│   └── reviewer.md
└── data/                      # Any other workspace content
```

## Harness Comparison

| Feature | Claude Agents | LangGraph | PI Agent |
| :--- | :--- | :--- | :--- |
| **Skills Discovery** | User-managed (via symlink) | User-managed workspace/config files | User-managed (via extensions) |
| **Subagent Config** | Record (Map) | Array | N/A |
| **Subagent Model** | Supported | Supported | N/A |
| **Multi-Provider** | No (Anthropic only) | Yes (OpenAI, Anthropic, Google) | No (PI only) |
| **Hooks System** | SDK-managed (via settings.json) | SDK-managed (via custom image) | SDK-managed (via extensions) |
