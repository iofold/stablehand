# CTXMill

**A self-hosted framework for building vertical AI products with ambient agents.**

CTXMill gives you an agent runtime, streaming UI protocol, and declarative components out of the box -- so you can ship domain-specific AI applications (finance, supply chain, marketing) without stitching together dozens of libraries. Start local with SQLite, scale up when you need to.

## Features

- **Agent Runtime** -- Anthropic streaming with automatic tool loop execution
- **AG-UI Protocol** -- Server-Sent Events (SSE) for real-time agent-to-frontend streaming
- **A2UI Components** -- Declarative, agent-driven UI: charts, tables, forms, Sankey diagrams, candlestick charts, and more
- **Human-in-the-Loop (HITL)** -- Approval flows, editable documents, and field-request forms before agents act
- **Knowledge Store** -- Context injection and knowledge YAML files per agent
- **Learning Pipeline** -- Trace collection, reflection, and continuous improvement loop
- **SQLite Persistence** -- Zero-config local storage (Level 1); Postgres path available at Level 2+
- **React UI** -- Dark-themed dashboard with chat, agent status, and live A2UI rendering
- **CLI Tooling** -- `npx create-ctxmill` scaffolding and `npx ctxmill dev` dev server

## Quick Start

```bash
# 1. Scaffold a new project
npx create-ctxmill my-app

# 2. Enter the project directory
cd my-app

# 3. Set your Anthropic API key
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 4. Start the dev server
npx ctxmill dev

# 5. Open the UI
open http://localhost:3000
```

## Project Structure

```
packages/
  ctxmill/              Core framework
    src/
      agent/            Agent runtime and discovery
      orchestrator/     Fastify server, SSE streaming, HITL interrupts
      tool/             Tool executor and type definitions
      knowledge/        Knowledge store and context injection
      learning/         Trace collection, reflector, learning pipeline
      database/         SQLite schema, migrations, repository
      config/           Configuration resolution, presets, container
      events/           Internal event bus
      cli/              CLI entry point and chat command
  ui/                   React frontend (Vite + Tailwind)
    src/
      components/
        a2ui/           A2UI block renderer and catalog registry
        charts/         TimeSeriesChart, BarChart, PieChart, CandlestickChart,
                        FunnelChart, SankeyDiagram, TableView, MetricCard,
                        KnowledgeGraphView
        chat/           ChatThread, MessageBubble, ChatInput, ToolCallCard
        hitl/           ApprovalCard, EditableDocument, FieldRequestForm
        dashboard/      AgentCard, AgentStatusBadge, Dashboard
      pages/            DashboardPage, ChatPage, AgentDetailPage
      stores/           Zustand stores (agents, conversation, interrupt)
      lib/              SSE hook, API client, utilities
  create-ctxmill/       Scaffolding CLI (npx create-ctxmill)
  examples/
    finance-dashboard/  Portfolio tracker with trade execution
    supply-chain/       Inventory, routing, order funnel, Sankey flows
    marketing/          Campaign analytics and funnel optimization
```

## Domain Examples

### Finance Dashboard

Portfolio assistant with tools for stock prices, positions, asset allocation, and trade execution. Demonstrates candlestick charts, metric cards, and HITL approval before executing trades.

### Supply Chain

Inventory management agent with route optimization, order funnel visualization, Sankey supply-chain flow diagrams, and draft report generation.

### Marketing

Campaign analytics agent with funnel charts, conversion metrics, and audience segmentation.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js, TypeScript |
| Agent LLM | Anthropic Claude (streaming) |
| Server | Fastify |
| Protocol | AG-UI (SSE) |
| Database | SQLite (better-sqlite3) |
| Frontend | React, Vite, Tailwind CSS |
| Charts | Recharts, d3-sankey, @react-sigma/core |
| State | Zustand |
| Testing | Vitest |
| Monorepo | pnpm workspaces |

## License

MIT
