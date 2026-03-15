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
  // Additional chart types
  'LineChart', 'AreaChart', 'ScatterChart', 'RadarChart', 'Treemap', 'NetworkGraph',
  'charts:LineChart', 'charts:AreaChart', 'charts:ScatterChart', 'charts:RadarChart',
  'charts:Treemap', 'charts:NetworkGraph',
  // HITL
  'ApprovalCard', 'EditableDocument', 'FieldRequestForm',
  'hitl:ApprovalCard', 'hitl:EditableDocument', 'hitl:FieldRequestForm',
]);

/** Maximum length for sanitized string prop values */
const MAX_STRING_PROP_LENGTH = 10_000;

/**
 * Per-component allowed prop keys. Components not listed here
 * will have ALL props stripped (only `component` survives).
 * Prefixed variants (e.g. "charts:BarChart") resolve to the
 * base component name for lookup.
 */
export const ALLOWED_PROPS: Record<string, string[]> = {
  BarChart:          ['data', 'xKey', 'yKey', 'title', 'color', 'width', 'height'],
  LineChart:         ['data', 'xKey', 'yKey', 'title', 'color', 'width', 'height'],
  PieChart:          ['data', 'nameKey', 'valueKey', 'title', 'colors', 'width', 'height'],
  AreaChart:         ['data', 'xKey', 'yKey', 'title', 'color', 'width', 'height'],
  ScatterChart:      ['data', 'xKey', 'yKey', 'title', 'color', 'width', 'height'],
  RadarChart:        ['data', 'dataKey', 'title', 'width', 'height'],
  Treemap:           ['data', 'dataKey', 'nameKey', 'title', 'colors', 'width', 'height'],
  SankeyDiagram:     ['data', 'title', 'width', 'height'],
  NetworkGraph:      ['data', 'title', 'width', 'height'],
  TimeSeriesChart:   ['data', 'xKey', 'yKey', 'title', 'color', 'width', 'height'],
  MetricCard:        ['title', 'value', 'change', 'trend', 'prefix', 'suffix', 'description'],
  TableView:         ['data', 'columns', 'title', 'pageSize'],
  CandlestickChart:  ['data', 'title', 'width', 'height'],
  FunnelChart:       ['data', 'title', 'width', 'height', 'colors'],
  KnowledgeGraphView:['data', 'title', 'width', 'height'],
  ApprovalCard:      ['title', 'description', 'toolName', 'args', 'approveLabel', 'rejectLabel'],
  EditableDocument:  ['content', 'title', 'format'],
  FieldRequestForm:  ['fields', 'title', 'submitLabel'],
};

/**
 * Resolve a potentially prefixed component name (e.g. "charts:BarChart")
 * to its base name for prop-whitelist lookup.
 */
function baseComponentName(name: string): string {
  const idx = name.indexOf(':');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * Sanitize a single string value:
 *  - Strip HTML tags
 *  - Remove null bytes
 *  - Trim to MAX_STRING_PROP_LENGTH
 */
export function sanitizeStringProp(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/\0/g, '')
    .slice(0, MAX_STRING_PROP_LENGTH);
}

/**
 * Recursively sanitize all string values inside an unknown structure
 * (objects, arrays, primitives).
 */
function deepSanitize(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeStringProp(value);
  }
  if (Array.isArray(value)) {
    return value.map(deepSanitize);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepSanitize(v);
    }
    return out;
  }
  return value;
}

/**
 * Filter and sanitize props for a given component.
 * Only keys present in ALLOWED_PROPS for the component are kept.
 * All string values (including nested) are sanitized.
 */
export function sanitizeProps(
  componentName: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const base = baseComponentName(componentName);
  const allowed = ALLOWED_PROPS[base];

  // If no whitelist defined for this component, strip all props
  if (!allowed) return {};

  const allowedSet = new Set(allowed);
  const filtered: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    if (allowedSet.has(key)) {
      filtered[key] = deepSanitize(value);
    }
  }

  return filtered;
}

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
        blocks.push({
          component: parsed.component,
          props: sanitizeProps(parsed.component, parsed.props),
        });
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
