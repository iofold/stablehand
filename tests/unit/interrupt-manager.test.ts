import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InterruptManager } from '../../packages/ctxmill/src/orchestrator/interrupt.js';

describe('InterruptManager', () => {
  let manager: InterruptManager;

  beforeEach(() => {
    manager = new InterruptManager();
  });

  afterEach(() => {
    manager.shutdown();
  });

  // ORC-17: waitForApproval returns a promise, resolve completes it
  describe('ORC-17: waitForApproval and resolve', () => {
    it('should return a promise from waitForApproval', () => {
      const promise = manager.waitForApproval('agent-1', 'tc-1', 'bash', { cmd: 'rm -rf /' });
      expect(promise).toBeInstanceOf(Promise);
    });

    it('should mark agent as having a pending interrupt', () => {
      manager.waitForApproval('agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      expect(manager.hasPending('agent-1')).toBe(true);
    });

    it('should not have pending for unknown agent', () => {
      expect(manager.hasPending('unknown')).toBe(false);
    });

    it('should resolve promise when approved', async () => {
      const promise = manager.waitForApproval('agent-1', 'tc-1', 'bash', { cmd: 'ls' });

      const resolved = manager.resolve('agent-1', 'approve');
      expect(resolved).toBe(true);

      const result = await promise;
      expect(result.action).toBe('approve');
    });

    it('should resolve promise when rejected', async () => {
      const promise = manager.waitForApproval('agent-1', 'tc-1', 'bash', { cmd: 'rm -rf /' });

      manager.resolve('agent-1', 'reject', 'Too dangerous');

      const result = await promise;
      expect(result.action).toBe('reject');
      expect(result.data).toBe('Too dangerous');
    });

    it('should return false when resolving non-existent interrupt', () => {
      const resolved = manager.resolve('no-agent', 'approve');
      expect(resolved).toBe(false);
    });

    it('should clear pending after resolve', () => {
      manager.waitForApproval('agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      expect(manager.hasPending('agent-1')).toBe(true);

      manager.resolve('agent-1', 'approve');
      expect(manager.hasPending('agent-1')).toBe(false);
    });

    it('should return pending interrupt info via getPending', () => {
      manager.waitForApproval('agent-1', 'tc-1', 'write_file', { path: '/tmp/test.txt' });

      const pending = manager.getPending('agent-1');
      expect(pending).toBeDefined();
      expect(pending!.toolCallId).toBe('tc-1');
      expect(pending!.toolName).toBe('write_file');
      expect(pending!.args).toEqual({ path: '/tmp/test.txt' });
      expect(pending!.createdAt).toBeTypeOf('number');
    });

    it('should return undefined from getPending for unknown agent', () => {
      expect(manager.getPending('unknown')).toBeUndefined();
    });
  });

  // Superseding behavior
  describe('superseding interrupts', () => {
    it('should reject previous interrupt when a new one is created for the same agent', async () => {
      const promise1 = manager.waitForApproval('agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      const promise2 = manager.waitForApproval('agent-1', 'tc-2', 'bash', { cmd: 'pwd' });

      // First promise should have been rejected with 'Superseded by new interrupt'
      const result1 = await promise1;
      expect(result1.action).toBe('reject');
      expect(result1.data).toBe('Superseded by new interrupt');

      // Second interrupt is the active one
      const pending = manager.getPending('agent-1');
      expect(pending!.toolCallId).toBe('tc-2');

      // Resolve the second one
      manager.resolve('agent-1', 'approve');
      const result2 = await promise2;
      expect(result2.action).toBe('approve');
    });
  });

  // Shutdown behavior
  describe('shutdown', () => {
    it('should reject all pending interrupts on shutdown', async () => {
      const promise1 = manager.waitForApproval('agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      const promise2 = manager.waitForApproval('agent-2', 'tc-2', 'read', { path: '/' });

      manager.shutdown();

      const result1 = await promise1;
      const result2 = await promise2;

      expect(result1.action).toBe('reject');
      expect(result1.data).toBe('Server shutting down');
      expect(result2.action).toBe('reject');
      expect(result2.data).toBe('Server shutting down');
    });

    it('should have no pending interrupts after shutdown', () => {
      manager.waitForApproval('agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      manager.shutdown();
      expect(manager.hasPending('agent-1')).toBe(false);
    });
  });

  // Multiple agents
  describe('multiple agents', () => {
    it('should handle concurrent interrupts for different agents independently', async () => {
      const p1 = manager.waitForApproval('agent-1', 'tc-1', 'bash', { cmd: 'ls' });
      const p2 = manager.waitForApproval('agent-2', 'tc-2', 'read', { path: '/etc' });

      expect(manager.hasPending('agent-1')).toBe(true);
      expect(manager.hasPending('agent-2')).toBe(true);

      manager.resolve('agent-1', 'approve');
      const r1 = await p1;
      expect(r1.action).toBe('approve');

      // agent-2 still pending
      expect(manager.hasPending('agent-2')).toBe(true);

      manager.resolve('agent-2', 'reject', 'No access');
      const r2 = await p2;
      expect(r2.action).toBe('reject');
      expect(r2.data).toBe('No access');
    });
  });
});
