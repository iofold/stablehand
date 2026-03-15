# Email Triage — CTXMill Example

Event-driven multi-agent workflow that classifies incoming emails and routes them to specialized handler agents.

## Agents

| Agent | Role |
|-------|------|
| **triage** | Classifies emails by priority (urgent/normal/low) and category (meeting_request/action_required/info/spam), then routes to the appropriate handler |
| **urgent-responder** | Drafts immediate replies to urgent emails and sends notifications |
| **meeting-scheduler** | Extracts scheduling details from meeting requests and proposes calendar entries |
| **digest-writer** | Summarizes batches of classified emails into a structured daily digest |

## Routing

```
incoming email
    │
    ▼
  triage ──classify──┬── urgent + action_required ──► urgent-responder
                     │
                     ├── meeting_request ──────────► meeting-scheduler
                     │
                     └── everything else ──────────► digest-writer
```

## Quick Start

```bash
cp .env.example .env
# Add your API key to .env

npx ctxmill dev
```

## Tools

- **classify-email** — Classify and persist an email's priority/category
- **draft-response** — Draft an urgent email reply (requires approval)
- **send-notification** — Simulate sending a Slack/SMS/push notification
- **extract-meeting-details** — Parse meeting info from an email body
- **propose-calendar-entry** — Create a calendar entry proposal (requires approval)
- **get-recent-classifications** — Fetch recent classifications for digest generation
- **write-digest** — Write a Markdown digest to the workspace (requires approval)
