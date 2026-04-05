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
  /** Event type to match (e.g. 'run.completed', 'custom.email.received'). */
  eventType: string;
  /** Optional field-level matching on the event payload. */
  selector?: Record<string, unknown>;
  /** Task/prompt template — supports {{payload.field}} placeholders. */
  taskTemplate: string;
  /** Whether this trigger is active. */
  enabled: boolean;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
}

/**
 * Interpolate `{{payload.field}}` and `{{payload}}` placeholders in a task template.
 *
 * Supports:
 *  - `{{payload.field}}` — single field lookup (one level of nesting)
 *  - `{{payload}}`       — JSON-stringified entire payload object
 *
 * Unmatched field placeholders are left as-is.
 */
export function interpolateTemplate(
  template: string,
  payload: Record<string, unknown>,
): string {
  let result = template.replace(/\{\{payload\}\}/g, () => JSON.stringify(payload));
  result = result.replace(/\{\{payload\.(\w+)\}\}/g, (_match, key: string) => {
    const value = payload[key];
    if (value === undefined || value === null) return `{{payload.${key}}}`;
    return String(value);
  });
  return result;
}
