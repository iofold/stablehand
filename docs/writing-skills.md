# Writing a Skill

Skills are the primary way to extend agent capabilities in ctxmill. They provide a structured format for bundling instructions, scripts, and reference materials that agents can use during a run.

## What is a Skill?

A skill is a directory containing a `SKILL.md` file and optional subdirectories for scripts, references, and assets. When you enable a skill for an agent, the orchestrator seeds these files into the agent's workspace and injects the skill's instructions into its system prompt.

This system allows you to give agents specialized knowledge or tools without bloating the main agent manifest.

## Skill File Format

The core of every skill is the `SKILL.md` file. It uses YAML frontmatter for metadata and Markdown for the instruction body.

### Required Frontmatter Fields

- `name`: A unique identifier for the skill. Use lowercase letters, numbers, and hyphens. Max 64 characters.
- `description`: A short summary of what the skill does. This helps you identify the skill in the UI. Max 1024 characters.

### Optional Frontmatter Fields

- `license`: The license for the skill (e.g., MIT).
- `compatibility`: Version requirements or harness compatibility notes.
- `metadata`: A key-value map for any custom data you want to attach.
- `allowed-tools`: A comma-separated list of tools this skill expects to use.

### Markdown Body

The body of the `SKILL.md` file contains the actual instructions for the agent. These instructions are injected into the agent's system prompt wherever you place the `{{skills}}` placeholder.

Keep instructions concise and focused. Use standard Markdown headers, lists, and code blocks.

## Directory Structure

Organize your skill files in a dedicated directory. The standard location is a `skills/` folder at the root of your project.

```text
skills/<skill-name>/
├── SKILL.md          # Required: Metadata and instructions
├── scripts/           # Optional: Helper scripts (bash, python, etc.)
├── references/        # Optional: Documentation or reference files
└── assets/            # Optional: Static assets like images or templates
```

When seeded, these files appear in the agent's workspace at `.ctxmill/skills/<skill-name>/`.

## Agent Manifest Configuration

You enable skills in the `spec.workspace.content.skills` field of your agent manifest (`agent.yaml`).

### Load All Skills

To load every skill found in your project's `skills/` directory:

```yaml
spec:
  workspace:
    content:
      skills: true
```

### Load Specific Skills

Use a list to load only a subset of skills:

```yaml
spec:
  workspace:
    content:
      skills:
        - code-review
        - security-audit
```

### The {{skills}} Placeholder

For the instructions to reach the agent, you must include the `{{skills}}` placeholder in your agent's `spec.instructions`:

```yaml
spec:
  instructions: |
    You are a senior developer.
    
    {{skills}}
    
    Always follow the provided skill instructions when performing specialized tasks.
```

## Per-Harness Behavior

Different harnesses handle skills in specific ways.

### LangGraph Harness

This is the most mature implementation. Skills are loaded from the project root, seeded into `.ctxmill/skills/` in the container, and passed to the agent via the system prompt injection.

### Claude Agents Harness (Planned)

Support for auto-discovering skills via Claude's `settingSources` is planned. Currently, it uses the same system prompt injection as LangGraph.

### PI Agent Harness (Planned)

Support for loading skills via a `skillsOverride()` callback is planned. Currently, it uses the same system prompt injection as LangGraph.

## Step-by-Step Tutorial: Creating a Code Review Skill

Let's build a skill that helps an agent perform high-quality code reviews.

### 1. Create the Directory

Start by creating the folder structure in your project root:

```bash
mkdir -p skills/code-review/scripts
```

### 2. Write the SKILL.md

Create `skills/code-review/SKILL.md` with the following content:

```markdown
---
name: code-review
description: Guidelines for performing thorough code reviews with a focus on security and performance.
---

# Code Review Guidelines

When reviewing code, always check for these common issues:

1. **Security**: Look for unsanitized inputs, hardcoded secrets, and insecure dependencies.
2. **Performance**: Identify O(n^2) loops, unnecessary database queries, and memory leaks.
3. **Readability**: Ensure variable names are descriptive and functions are small.

Use the provided `check-complexity.sh` script to analyze function length.
```

### 3. Add a Helper Script

Create a simple script at `skills/code-review/scripts/check-complexity.sh`:

```bash
#!/bin/bash
# Simple script to find long functions
find . -name "*.ts" | xargs wc -l | sort -nr | head -n 10
```

### 4. Enable the Skill

Update your `agent.yaml` to include the skill:

```yaml
apiVersion: ctxmill.io/v1
kind: Agent
metadata:
  name: reviewer
spec:
  harness: langgraph
  workspace:
    content:
      skills:
        - code-review
  instructions: |
    You are a helpful code review assistant.
    
    {{skills}}
```

## Validation Rules

The ctxmill loader validates skills before seeding them. If a skill fails validation, it will be skipped, and a warning will appear in the orchestrator logs.

- **Name**: Must be lowercase, numbers, and hyphens only. No spaces or special characters. Max 64 chars.
- **Description**: Required. Max 1024 chars.
- **Body**: The Markdown body cannot be empty.
- **File Presence**: Every skill directory must contain a `SKILL.md` file.

## Testing Your Skill

To verify your skill loaded correctly:

1. Start your agent session.
2. Check the agent's system prompt in the UI (Agent Detail -> Overview tab). You should see your skill instructions rendered there.
3. Use a tool like `ls` or `find` to verify the files exist in the workspace at `.ctxmill/skills/<skill-name>/`.

## Troubleshooting

### Skill instructions not appearing
Ensure you included the `{{skills}}` placeholder in your agent's `spec.instructions`. Check the orchestrator logs for validation errors if the placeholder is empty.

### Scripts not executable
The sandbox seeds files with standard permissions. If your script needs to be executable, ensure your agent knows to run `chmod +x` on it before execution, or call it via its interpreter (e.g., `bash script.sh`).

### Missing files in workspace
Verify that `workspace.content.skills` is set to `true` or includes your skill name in the agent manifest.
