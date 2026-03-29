/**
 * Shared A2UI block extraction and validation utility.
 * Single source of truth for parsing A2UI JSON from LLM text output.
 */

export interface A2UIBlock {
  component: string;
  props: Record<string, unknown>;
}

const ALLOWED_COMPONENTS = new Set([
  'TimeSeriesChart', 'BarChart', 'PieChart', 'MetricCard', 'TableView',
  'CandlestickChart', 'FunnelChart', 'SankeyDiagram', 'KnowledgeGraphView',
  'LineChart', 'AreaChart', 'ScatterChart', 'RadarChart', 'Treemap', 'NetworkGraph',
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
  SankeyDiagram:     ['data', 'nodes', 'links', 'title', 'width', 'height'],
  NetworkGraph:      ['data', 'title', 'width', 'height'],
  TimeSeriesChart:   ['data', 'xKey', 'yKey', 'title', 'color', 'width', 'height'],
  MetricCard:        ['title', 'value', 'change', 'changeLabel', 'trend', 'prefix', 'suffix', 'description'],
  TableView:         ['data', 'columns', 'title', 'pageSize'],
  CandlestickChart:  ['data', 'title', 'width', 'height'],
  FunnelChart:       ['data', 'stages', 'title', 'width', 'height', 'colors'],
  KnowledgeGraphView:['data', 'nodes', 'edges', 'title', 'width', 'height'],
};

/**
 * Resolve a potentially prefixed component name (e.g. "charts:BarChart")
 * to its base name for prop-whitelist lookup.
 */
export function normalizeComponentName(name: string): string {
  if (name.startsWith('ctxmill.charts:')) return name.slice('ctxmill.charts:'.length);
  if (name.startsWith('charts:')) return name.slice('charts:'.length);
  return name;
}

function baseComponentName(name: string): string {
  return normalizeComponentName(name);
}

function normalizeProps(
  componentName: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const base = baseComponentName(componentName);
  const normalized = { ...props };

  if (base === 'FunnelChart' && !Array.isArray(normalized.stages) && Array.isArray(normalized.data)) {
    normalized.stages = normalized.data;
  }

  if (base === 'SankeyDiagram' && normalized.data && typeof normalized.data === 'object') {
    const data = normalized.data as Record<string, unknown>;
    if (!Array.isArray(normalized.nodes) && Array.isArray(data.nodes)) {
      normalized.nodes = data.nodes;
    }
    if (!Array.isArray(normalized.links) && Array.isArray(data.links)) {
      normalized.links = data.links;
    }
  }

  if (base === 'KnowledgeGraphView' && normalized.data && typeof normalized.data === 'object') {
    const data = normalized.data as Record<string, unknown>;
    if (!Array.isArray(normalized.nodes) && Array.isArray(data.nodes)) {
      normalized.nodes = data.nodes;
    }
    if (!Array.isArray(normalized.edges) && Array.isArray(data.edges)) {
      normalized.edges = data.edges;
    }
  }

  return normalized;
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

  for (const [key, value] of Object.entries(normalizeProps(componentName, props))) {
    if (allowedSet.has(key)) {
      filtered[key] = deepSanitize(value);
    }
  }

  return filtered;
}

/**
 * Check if a component name is in the allowed whitelist.
 */
export function isAllowedComponent(name: string): boolean {
  return ALLOWED_COMPONENTS.has(baseComponentName(name));
}
