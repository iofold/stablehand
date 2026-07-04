import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CanonicalProjector } from '../projector.js';
import { formatNativeLegacy } from '../format-native-legacy.js';

/**
 * ?wire=legacy guarantee (ADR-015): projector→formatNativeLegacy must keep
 * reproducing the legacy native wire that pilot's pinned frontend parses.
 * The golden fixture was captured from the deleted SSEBroadcaster against the
 * scripted bus sequence; messageId is excluded — the canonical spine
 * deliberately mints stable `${turnId}-m${n}` ids (ctx-4fs) and nothing on
 * this wire reads that field (verified against ui + pilot).
 */

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'legacy-wire-golden.json');
const golden = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  sequence: Array<[string, Record<string, unknown>]>;
  wire: Array<Record<string, unknown>>;
};

function normalize(event: Record<string, unknown>): Record<string, unknown> {
  const { messageId: _messageId, ...rest } = event;
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
}

describe('legacy native wire parity (?wire=legacy guarantee)', () => {
  it('projector + formatNativeLegacy reproduces the golden legacy wire', () => {
    const projector = new CanonicalProjector();
    const rendered: Array<Record<string, unknown>> = [];
    for (const [name, payload] of golden.sequence) {
      for (const frame of projector.project(name, payload)) {
        const wireEvent = formatNativeLegacy(frame);
        if (wireEvent) {
          rendered.push(wireEvent);
        }
      }
    }

    expect(rendered.map((event) => event.type)).toEqual(golden.wire.map((event) => event.type));
    for (let i = 0; i < golden.wire.length; i++) {
      expect(normalize(rendered[i]!), `frame ${i} (${golden.wire[i]!.type})`).toEqual(normalize(golden.wire[i]!));
    }
  });
});
