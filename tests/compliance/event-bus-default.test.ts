/**
 * Default TypedEventBus compliance test
 *
 * Runs the EventBus compliance suite against the real TypedEventBus class.
 */

import { describe } from 'vitest';
import { TypedEventBus } from '../../packages/ctxmill/src/events/bus.js';
import { eventBusComplianceSuite } from './event-bus.compliance.js';

describe('TypedEventBus compliance', () => {
  eventBusComplianceSuite({
    createBus: () => new TypedEventBus(),
  });
});
