import { z } from 'zod';
import type { ToolDefinition } from '@ctxmill/sandbox-daemon';

import { resolveToolLocation } from '../metadata.js';

export const TOPICS = ['ptc', 'a2ui', 'hitl', 'events', 'artifacts', 'capabilities'] as const;
export type GuideTopic = typeof TOPICS[number];

export const CTXMILL_GUIDE_TOOL_NAME = 'ctxmill-guide';

export interface CtxmillGuideDeps {
  listTools: () => ToolDefinition[];
}

export const GUIDE_CONTENT: Record<GuideTopic, string> = {
  ptc: `# Programmatic Tool Calling (PTC)

Some tools return large payloads that would exhaust your context window. These tools have pre-generated scripts in \`/workspace/.tools/\` that call the tool, process results in code scope, and print only concise summaries to stdout.

## Usage

### Run a pre-generated script
\`\`\`bash
bun /workspace/.tools/{tool-name}.ts key1=value1 key2=value2
\`\`\`

Arguments use \`key=value\` format. The script calls the tool via the local daemon API, processes the full JSON result in code, and prints a structured summary. Only the summary enters your context window.

### Write custom processing scripts
Import the shared runtime for ad-hoc data processing:

\`\`\`typescript
import { callTool } from "/workspace/.tools/_runtime.ts";

const data = await callTool("tool-name", { key: "value" });
// Full result is in \`data\` — stays in code scope, NOT in context
const filtered = data.items.filter((item: any) => item.score > 0.9);
console.log(\`Found \${filtered.length} high-scoring items\`);
\`\`\`

## Rules
1. **Always prefer PTC scripts** over direct tool calls for PTC-enabled tools
2. **Only stdout enters context** — process and summarize in code, then print
3. **Errors go to stderr** — scripts never dump raw payloads to stdout on error
4. **Write files for large outputs** — save to \`/workspace/\` and reference the file path

## Script API Reference

### \`callTool(name: string, args: unknown): Promise<unknown>\`
Calls the daemon HTTP API at \`localhost:8080\`. Returns parsed JSON. Throws on HTTP errors with descriptive messages.

### CLI argument parsing
- \`key=value\` pairs → \`{ key: value }\` object
- Single positional arg → parsed as scalar
- Auto-coercion: \`true\`/\`false\` → boolean, numeric strings → number, JSON → parsed object`,
  a2ui: `# A2UI — Structured Visual Rendering

Use the \`a2ui-render\` tool to display charts, tables, and metric cards in the UI. The tool description contains the full component catalog with props.

## Available Components
Charts: BarChart, LineChart, AreaChart, PieChart, ScatterChart, RadarChart, TimeSeriesChart, Treemap, CandlestickChart, FunnelChart, SankeyDiagram, NetworkGraph, KnowledgeGraphView
Data: MetricCard, TableView

## Quick Example
\`\`\`
a2ui-render({ component: "BarChart", props: { data: [{"month":"Jan","revenue":100}], xKey: "month", yKey: "revenue", title: "Revenue" } })
\`\`\``,
  hitl: `# Human-in-the-Loop (HITL) Approvals

Tools flagged with \`requiresApproval\` automatically pause the run and present an approval card to the user. The run resumes only after the human approves or rejects.

## Explicit Approval
Use the \`request-approval\` tool to pause and request human approval before a sensitive action:
\`\`\`
request-approval({ reason: "About to execute trade for $50,000", details: { symbol: "AAPL", amount: 50000 } })
\`\`\`

## Flow
1. Tool call triggers approval → run pauses
2. User sees approval card in UI with reason and details
3. User approves or rejects
4. Run resumes with approval result`,
  events: `# Event-Driven Agent Chaining

Use the \`emit-event\` tool to emit custom events that can trigger other agents via configured event triggers.

## Usage
\`\`\`
emit-event({ type: "analysis.complete", payload: { agentId: "analyst", reportPath: "/workspace/report.json" } })
\`\`\`

## Conventions
- Event types use \`domain.action\` format (e.g., \`email.classified\`, \`report.ready\`)
- Payload should contain enough context for the triggered agent to act
- Cascade protection limits trigger depth to 5 levels`,
  artifacts: `# Artifact Storage

Persistent file storage that survives across sessions. Upload workspace files to S3-backed storage and download them by artifact ID.

## Upload
\`\`\`
artifact_upload({ filePath: "/workspace/output/report.pdf", metadata: { type: "report" } })
\`\`\`
Returns an artifact ID for sharing.

## Download
\`\`\`
artifact_download({ artifactId: "art_abc123", destinationPath: "/workspace/downloads/report.pdf" })
\`\`\``,
  capabilities: `# Platform Capabilities

ctxmill provides built-in tools automatically available to all agents. Use \`ctxmill-guide\` with a specific topic for detailed documentation.

## Topics
- \`ptc\` — Programmatic Tool Calling for large-payload tools
- \`a2ui\` — Structured visual rendering (charts, tables, cards)
- \`hitl\` — Human-in-the-loop approval flows
- \`events\` — Event-driven agent chaining
- \`artifacts\` — Persistent file storage`,
};

function isGuideTopic(value: unknown): value is GuideTopic {
  return typeof value === 'string' && TOPICS.includes(value as GuideTopic);
}

function getTopicFromInput(rawInput: unknown): GuideTopic | null {
  if (typeof rawInput !== 'object' || rawInput === null || !('topic' in rawInput)) {
    return null;
  }

  const { topic } = rawInput;
  return isGuideTopic(topic) ? topic : null;
}

function formatToolList(tools: ToolDefinition[], getLine: (tool: ToolDefinition) => string): string {
  if (tools.length === 0) {
    return '- None registered';
  }

  return tools
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(getLine)
    .join('\n');
}

function enrichWithDynamic(topic: GuideTopic, staticContent: string, deps: CtxmillGuideDeps): string {
  const tools = deps.listTools();

  if (topic === 'ptc') {
    const programmaticTools = tools.filter((tool) => tool.programmatic);
    return `${staticContent}

## PTC-Enabled Tools
${formatToolList(programmaticTools, (tool) => `- \`${tool.name}\` — ${tool.description}`)}

Each PTC-enabled tool also has a generated script at \`/workspace/.tools/{name}.ts\` (for example, \`/workspace/.tools/${programmaticTools[0]?.name ?? 'tool-name'}.ts\`).`;
  }

  if (topic === 'hitl') {
    const approvalTools = tools.filter((tool) => tool.requiresApproval);
    return `${staticContent}

## Approval-Gated Tools
${formatToolList(approvalTools, (tool) => `- \`${tool.name}\` — ${tool.description}`)}`;
  }

  if (topic === 'capabilities') {
    return `${staticContent}

## Tool Inventory
${formatToolList(
      tools,
      (tool) => `- \`${tool.name}\` — ${tool.description} _(location: ${resolveToolLocation(tool)})_`,
    )}`;
  }

  return staticContent;
}

export function createCtxmillGuideTool(deps: CtxmillGuideDeps): ToolDefinition {
  return {
    name: CTXMILL_GUIDE_TOOL_NAME,
    description: 'Get documentation about ctxmill platform capabilities. Topics: ptc (programmatic tool calling), a2ui (structured UI rendering), hitl (human-in-the-loop approvals), events (event-driven agent chaining), artifacts (persistent file storage), capabilities (all available tools).',
    location: 'orchestrator' as const,
    input: z.object({
      topic: z.enum(TOPICS).describe('The capability area to learn about'),
    }),
    handler: async (rawInput: unknown, _ctx) => {
      const topic = getTopicFromInput(rawInput);
      if (!topic) {
        return `Error: Unknown ctxmill-guide topic. Available topics: ${TOPICS.join(', ')}`;
      }

      const staticContent = GUIDE_CONTENT[topic] ?? `Topic "${topic}" is not yet documented.`;
      return enrichWithDynamic(topic, staticContent, deps);
    },
  };
}
