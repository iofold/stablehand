/**
 * Operator-facing names for tool calls. Harnesses report tools under their
 * transport names (`mcp__stablehand__a2ui-render`, `write_file`, `TodoWrite`);
 * the conversation shows a plain label and keeps the raw name for details.
 */

/** Placeholder the transcript stores when a harness reported no tool name. */
export const MISSING_TOOL_NAME = 'unknown';

const MCP_PREFIX = /^mcp__.+?__/;

const KNOWN_TOOL_LABELS: Readonly<Record<string, string>> = {
  'a2ui-render': 'Visual',
  'request-approval': 'Approval request',
  'emit-event': 'Emit event',
  'stablehand-guide': 'Stablehand guide',
  artifact_upload: 'Upload artifact',
  artifact_download: 'Download artifact',
  browse: 'Browse page',
  screenshot: 'Screenshot',
  edit_document: 'Document review',
  request_fields: 'Information request',
  // Claude Agent SDK natives that are not a plain word.
  TodoWrite: 'To-do list',
  WebFetch: 'Fetch page',
  WebSearch: 'Web search',
  NotebookEdit: 'Edit notebook',
  MultiEdit: 'Edit file',
  Task: 'Subagent',
  Agent: 'Subagent',
  // LangGraph deepagents built-ins.
  write_todos: 'To-do list',
  task: 'Subagent',
  ls: 'List files',
  execute: 'Run command',
};

const A2UI_COMPONENT_LABELS: Readonly<Record<string, string>> = {
  BarChart: 'Bar chart',
  LineChart: 'Line chart',
  AreaChart: 'Area chart',
  PieChart: 'Pie chart',
  ScatterChart: 'Scatter chart',
  RadarChart: 'Radar chart',
  TimeSeriesChart: 'Time series',
  Treemap: 'Treemap',
  CandlestickChart: 'Candlestick chart',
  FunnelChart: 'Funnel',
  SankeyDiagram: 'Sankey diagram',
  NetworkGraph: 'Network graph',
  KnowledgeGraphView: 'Knowledge graph',
  MetricCard: 'Metric',
  TableView: 'Table',
};

/** Strip harness transport prefixes: `mcp__stablehand__emit-event` → `emit-event`. */
export function baseToolName(rawName: string): string {
  return rawName.replace(MCP_PREFIX, '');
}

export function isMissingToolName(rawName: string | undefined): boolean {
  return !rawName || rawName.trim() === '' || rawName === MISSING_TOOL_NAME;
}

function sentenceCase(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return name;
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
      // Keep acronyms (URL, API) as written.
      return word === word.toUpperCase() && word.length > 1 ? word : lower;
    })
    .join(' ');
}

/** Human label for a tool, given its raw reported name. */
export function toolDisplayName(rawName: string | undefined): string {
  if (isMissingToolName(rawName)) return 'Tool call';
  const base = baseToolName(rawName!.trim());
  return KNOWN_TOOL_LABELS[base] ?? sentenceCase(base);
}

/** Label for an a2ui-render card, named after the component it drew. */
export function a2uiDisplayName(component: string): string {
  const bare = component.replace(/^(?:stablehand\.)?charts:/, '');
  return A2UI_COMPONENT_LABELS[bare] ?? sentenceCase(bare);
}

export function isA2UIRenderToolName(rawName: string): boolean {
  return baseToolName(rawName) === 'a2ui-render';
}

export function isApprovalToolName(rawName: string): boolean {
  return baseToolName(rawName) === 'request-approval';
}

const SUMMARY_KEYS = [
  'reason',
  'file_path',
  'path',
  'command',
  'query',
  'url',
  'pattern',
  'title',
  'name',
  'type',
  'description',
  'prompt',
  'subagent_type',
] as const;

/**
 * One-line summary of a call's arguments for the collapsed card: the most
 * telling string argument, else nothing (the raw JSON lives in details).
 */
export function summarizeToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim().replace(/\s+/g, ' ');
    }
  }
  if (Array.isArray(record.todos)) {
    const count = record.todos.length;
    return `${count} item${count === 1 ? '' : 's'}`;
  }
  return undefined;
}
