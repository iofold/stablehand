# Contributing to CTXMill

## Prerequisites

- Node.js 22+
- pnpm (latest)

## Getting Started

```bash
git clone <repo-url>
cd ctxmill
pnpm install
pnpm -r build
```

## Development Workflow

Start the UI dev server:

```bash
pnpm dev
```

Run tests:

```bash
npx vitest run
```

Verify the full build:

```bash
pnpm -r build
```

## Project Structure

```
packages/
  ctxmill/           # Core orchestrator (Fastify, Node.js/TS)
  ui/                # Frontend (React, AG-UI, CopilotKit)
  create-ctxmill/    # Project scaffolding CLI
  examples/*/        # Example projects and templates
```

## Testing

- Framework: Vitest
- Unit tests: `tests/unit/`
- Integration tests: `tests/integration/`
- Use dry-run mode for tests that interact with external services
- Run the full suite before submitting a PR:

```bash
npx vitest run
```

## Pull Request Guidelines

- One feature or fix per PR.
- Include tests for new functionality.
- TypeScript strict mode must pass -- no `any` escape hatches without justification.
- Run `pnpm -r build` and `npx vitest run` locally before opening a PR.
- Keep commit messages clear and concise.
