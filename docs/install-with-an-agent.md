# Install Stablehand with a coding agent

Paste the prompt below into Claude Code, Codex, Cursor or any agent that can run shell commands on your machine. It does what `install.sh` does, one step at a time, and tells you what each step changed. You need Docker with Compose and an OpenAI API key.

```text
Install Stablehand (https://github.com/iofold/stablehand), a self-hosted runtime
for scheduled agents, on this machine and run its Overnight Analyst example once.
Explain each step in a sentence before you run it, and stop to ask me if anything
fails.

1. Check that `docker info` and `docker compose version` work (Compose v2) and
   that Docker has at least 6 GB of memory. If not, tell me what to fix and stop.
2. Clone https://github.com/iofold/stablehand.git into ./stablehand (or use it if
   it is already there) and cd into it.
3. Read install.sh in the repo root. It is the reference for every step below.
4. Create .env from .env.example if it does not exist. Fill every blank secret
   exactly as install.sh does (same formats: LiteLLM keys start with sk-), and
   never overwrite a value that is already set. Ask me for my OpenAI API key and
   write it as OPENAI_API_KEY without echoing it back. Do not print any secret
   from .env in your replies.
5. Start the stack the way install.sh does: try `docker compose pull
   --ignore-pull-failures`, then `docker compose up -d`. Wait until
   http://localhost:3002/health answers (the first start can take several
   minutes).
6. Run the seed and the first run exactly as install.sh does (`docker compose
   exec ... seed.ts`, save the GALLERY_API_KEY line it prints into .env without
   showing it to me, `docker compose up -d gallery`, then `run-once.ts`).
7. Show me the receipt run-once.ts printed (status, model, tokens, cost), then
   tell me the UI address (http://localhost:3200), where the API token is
   (STABLEHAND_API_TOKEN in .env), and the gallery address
   (http://localhost:8090).

Do not change any file in the repo other than .env, and do not push anything.
```

To undo it all: `cd stablehand && docker compose down -v`, then delete the directory.
