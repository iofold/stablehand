# tools

Local tools for your agents. Each `.ts` file default-exports a `defineTool(...)` from `stablehand`; the orchestrator loads this directory at startup. The Overnight Analyst uses only built-in tools (`browse`, `screenshot`, `artifact_upload`), so this directory starts empty.

After adding or editing a tool, run `docker compose restart orchestrator`.
