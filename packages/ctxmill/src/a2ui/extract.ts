/**
 * Shared A2UI block extraction and validation utility.
 * Single source of truth for parsing A2UI JSON from LLM text output.
 */

export interface A2UIBlock {
  component: string;
  props: Record<string, unknown>;
}

// Whitelist of allowed component names
const ALLOWED_COMPONENTS = new Set([
  // Charts
  'TimeSeriesChart', 'BarChart', 'PieChart', 'MetricCard', 'TableView',
  'CandlestickChart', 'FunnelChart', 'SankeyDiagram', 'KnowledgeGraphView',
  // With prefix
  'charts:TimeSeriesChart', 'charts:BarChart', 'charts:PieChart', 'charts:MetricCard',
  'charts:TableView', 'charts:CandlestickChart', 'charts:FunnelChart',
  'charts:SankeyDiagram', 'charts:KnowledgeGraphView',
  // HITL
  'ApprovalCard', 'EditableDocument', 'FieldRequestForm',
  'hitl:ApprovalCard', 'hitl:EditableDocument', 'hitl:FieldRequestForm',
]);

const MAX_BLOCK_SIZE = 50 * 1024; // 50KB per block

const A2UI_PATTERN = /\{\s*"component"\s*:\s*"[^"]+"\s*,\s*"props"\s*:\s*\{[\s\S]*?\}\s*\}/g;

/**
 * Extract all valid A2UI blocks from LLM text output.
 * Returns an array of validated blocks with allowed component names.
 */
export function extractA2UIBlocks(text: string): A2UIBlock[] {
  const blocks: A2UIBlock[] = [];
  let match;
  while ((match = A2UI_PATTERN.exec(text)) !== null) {
    if (match[0].length > MAX_BLOCK_SIZE) continue;
    try {
      const parsed = JSON.parse(match[0]);
      if (
        typeof parsed.component === 'string' &&
        typeof parsed.props === 'object' &&
        parsed.props !== null &&
        ALLOWED_COMPONENTS.has(parsed.component)
      ) {
        blocks.push({ component: parsed.component, props: parsed.props });
      }
    } catch { /* skip invalid JSON */ }
  }
  // Reset lastIndex since we use /g flag
  A2UI_PATTERN.lastIndex = 0;
  return blocks;
}

/**
 * Check if a component name is in the allowed whitelist.
 */
export function isAllowedComponent(name: string): boolean {
  return ALLOWED_COMPONENTS.has(name);
}
