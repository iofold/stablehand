/**
 * Event trigger types for the pub/sub trigger system.
 *
 * An EventTrigger defines a rule: when a matching event fires on the bus,
 * automatically start a background run on the target agent.
 */
export interface EventTrigger {
  /** Unique trigger identifier. */
  id: string;
  /** Agent to invoke when the trigger fires. */
  agentId: string;
  /** Event type to match (e.g. 'turn.completed', 'custom.email.received'). */
  eventType: string;
  /** Optional field-level matching on the event payload. */
  selector?: Record<string, unknown>;
  /** Task/prompt template — supports {{payload}} and {{payload.path}} placeholders. */
  taskTemplate: string;
  /**
   * Optional thread key template, e.g. `{{payload.threadId}}`. Firings that
   * render the same key for this agent continue one conversation instead of
   * starting a new one each time.
   */
  conversationKey?: string;
  /** Whether this trigger is active. */
  enabled: boolean;
  /** Creation time, epoch milliseconds (ctx-iqzy T5). */
  createdAt: number;
}

const PAYLOAD_PLACEHOLDER = /\{\{\s*payload((?:\.[\w-]+)*)\s*\}\}/g;

function lookupPath(root: unknown, segments: readonly string[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    // Own properties only: `{{payload.constructor}}` must not reach prototypes.
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function renderValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Interpolate payload placeholders in a trigger task template.
 *
 *  - `{{payload}}` renders the whole event payload as compact JSON.
 *  - `{{payload.field}}` renders one field, and dotted paths reach nested
 *    fields and array items: `{{payload.summary.title}}`,
 *    `{{payload.items.0.name}}`.
 *
 * Strings render as-is, numbers and booleans as text, and objects and arrays
 * as compact JSON (ctx-et0w: they used to render as `[object Object]`).
 * A missing or null field leaves its placeholder unchanged, so the gap stays
 * visible in the task. Whitespace inside the braces is allowed.
 */
export function interpolateTemplate(
  template: string,
  payload: Record<string, unknown>,
): string {
  return template.replace(PAYLOAD_PLACEHOLDER, (placeholder, path: string) => {
    const segments = path ? path.slice(1).split('.') : [];
    return renderValue(segments.length === 0 ? payload : lookupPath(payload, segments)) ?? placeholder;
  });
}

/**
 * Render a trigger's conversation key for one event. Returns undefined when
 * the template is unset, renders empty, or names a field the event lacks, so
 * that firing starts a new conversation instead of folding every keyless
 * event into one thread.
 */
export function renderConversationKey(
  template: string | undefined,
  payload: Record<string, unknown>,
): string | undefined {
  if (!template || template.trim() === '') return undefined;
  let missing = false;
  const rendered = template.replace(PAYLOAD_PLACEHOLDER, (_placeholder, path: string) => {
    const segments = path ? path.slice(1).split('.') : [];
    const value = renderValue(segments.length === 0 ? payload : lookupPath(payload, segments));
    if (value === undefined) missing = true;
    return value ?? '';
  }).trim();
  return missing || rendered === '' ? undefined : rendered;
}
