import { expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, getEvents } from '../support';

/**
 * Stress event determinism contract per ADR 012.
 *
 * Required-matrix tests assert that:
 *   1. Exactly one event of `eventType` exists for `turnId`.
 *   2. The event payload carries `schemaVersion >= 1`.
 *   3. The payload identifies the harness via `agent` or `harness` field.
 *
 * The helper is intentionally strict: missing or duplicate events are hard
 * failures, not warnings. Harnesses that cannot emit `schemaVersion` today
 * must be tracked under a follow-up sub-issue.
 *
 * `STABLEHAND_STRESS_SCHEMA_VERSION_OPTIONAL=1` relaxes the schemaVersion check
 * for environments that haven't deployed the harness payload upgrade yet.
 * The flag is intended for short-term migration only and MUST NOT be set in
 * the required release-gate runner.
 */

interface StressEventRecord {
  id: string;
  type: string;
  payload: string;
  agentId?: string;
  createdAt: string;
}

interface ParsedStressPayload {
  schemaVersion?: number | string | null;
  agent?: string;
  harness?: string;
  turnId?: string;
  status?: string;
  [key: string]: unknown;
}

function parsePayload(raw: string): ParsedStressPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ParsedStressPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function isSchemaVersionOptional(): boolean {
  return process.env.STABLEHAND_STRESS_SCHEMA_VERSION_OPTIONAL === '1';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export interface StressAssertionOptions {
  /**
   * Optional explicit agentId scope when filtering /api/events. Defaults to
   * unscoped, which matches the existing stress-smoke behaviour.
   */
  agentId?: string;
  /**
   * Maximum events to fetch. Defaults to 50 — large enough to expose
   * duplicate emits per turn.
   */
  limit?: number;
}

/**
 * Fetch events of `eventType` and return the subset whose payload references
 * `turnId`. Used to assert exactly-once observation per (turnId, type).
 */
export async function fetchStressEventsForTurn(
  request: APIRequestContext,
  eventType: string,
  turnId: string,
  options: StressAssertionOptions = {},
): Promise<StressEventRecord[]> {
  const events = await getEvents(request, {
    type: eventType,
    agentId: options.agentId,
    limit: options.limit ?? 50,
  });
  return events.filter((event) => (event.payload ?? '').includes(turnId));
}

/**
 * Assert ADR 012 contract for a required-matrix stress event.
 *
 * @throws expect failure if event is missing, duplicated, or payload is
 *   missing required fields.
 */
export async function assertStressComplete(
  request: APIRequestContext,
  turnId: string,
  eventType: string,
  expectedHarness: string,
  options: StressAssertionOptions = {},
): Promise<ParsedStressPayload> {
  const matches = await fetchStressEventsForTurn(
    request,
    eventType,
    turnId,
    options,
  );

  expect(
    matches.length,
    `[ADR-012] expected exactly one ${eventType} event for turn ${turnId}, got ${matches.length}`,
  ).toBe(1);

  const [match] = matches;
  const payload = parsePayload(match.payload);
  expect(
    payload,
    `[ADR-012] ${eventType} payload for turn ${turnId} must be a JSON object, got: ${match.payload}`,
  ).not.toBeNull();

  const harnessLabel = payload!.harness ?? payload!.agent;
  expect(
    String(harnessLabel ?? ''),
    `[ADR-012] ${eventType} payload missing harness/agent field for turn ${turnId}`,
  ).toContain(expectedHarness);

  if (!isSchemaVersionOptional()) {
    const schemaVersion = asNumber(payload!.schemaVersion);
    expect(
      schemaVersion,
      `[ADR-012] ${eventType} payload.schemaVersion must be a number >= 1 for turn ${turnId}, got: ${JSON.stringify(payload!.schemaVersion)}`,
    ).not.toBeNull();
    expect(
      schemaVersion!,
      `[ADR-012] ${eventType} payload.schemaVersion must be >= 1 for turn ${turnId}`,
    ).toBeGreaterThanOrEqual(1);
  }

  return payload!;
}

/**
 * Convenience wrapper that uses `getEvents` + `API_BASE` for callers that
 * want raw access without the contract assertions (extended tests).
 */
export const STRESS_EVENT_API_BASE = API_BASE;
