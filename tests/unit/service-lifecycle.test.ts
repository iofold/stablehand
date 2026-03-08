import { describe, it, expect } from 'vitest';
import type { ServiceModule } from '@ctxmill/shared';

describe('ServiceModule interface', () => {
  it('should define required lifecycle methods', () => {
    const service: ServiceModule = {
      name: 'test-service',
      async healthy() { return true; },
      async shutdown() {},
    };
    expect(service.name).toBe('test-service');
    expect(typeof service.healthy).toBe('function');
    expect(typeof service.shutdown).toBe('function');
  });

  it('should allow optional initialize method', () => {
    const service: ServiceModule = {
      name: 'test-service',
      async initialize() {},
      async healthy() { return true; },
      async shutdown() {},
    };
    expect(typeof service.initialize).toBe('function');
  });
});
