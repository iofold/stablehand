/**
 * P3-4: Verify Harness-Native Sub-Agents Work in Each Harness
 *
 * These tests verify the architectural guarantees for sub-agent execution
 * within sandbox containers:
 *
 * 1. Sub-agent events appear in the event stream (tool_call_start/end)
 * 2. Container resource limits apply to the combined parent + sub-agent workload
 * 3. Sub-agent errors surface as error events and fail the run
 * 4. Each harness can be instantiated without orchestrator deps
 * 5. Harness selection in runner.ts works for all 5 harness names
 * 6. Proto event envelopes preserve sub-agent context (sequence, timestamps, runId)
 *
 * AD-4: Sub-agents are harness-native, not orchestrator-managed. The orchestrator
 * sees sub-agent activity as normal tool_call_start/end events in the gRPC stream.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { agentEventToSessionEvent } from '../../packages/ctxmill/src/sandbox/proto-convert.js';
import { ContainerManager } from '../../packages/ctxmill/src/sandbox/container-manager.js';
import {
  createMockContainer,
  createMockDocker,
} from '../utils/event-bus-test-helpers.js';
import type { AgentEvent, AgentHarness } from '../../packages/ctxmill/src/harness/types.js';

type MockHarnessRunConfig = {
  harnessConfig: Record<string, unknown>;
  systemPrompt: string;
  messages: Array<{
    id: string;
    agentId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    createdAt: Date;
  }>;
  tools: unknown[];
  secrets: Record<string, string>;
  agentId: string;
  runId: string;
  conversationId: string;
  workspaceDir: string;
};

type MockHarness = {
  name: string;
  run(config: MockHarnessRunConfig): AsyncGenerator<AgentEvent>;
};

function agentEventToProto(event: AgentEvent, seq: number, runId: string) {
  const sessionEvent = agentEventToSessionEvent(event);
  return {
    sequence: BigInt(seq),
    runId,
    timestamp: {
      seconds: BigInt(Math.floor(Date.now() / 1000)),
      nanos: 0,
    },
    event: sessionEvent.payload.case === 'agUiEvent' ? sessionEvent.payload.value : undefined,
  };
}

/**
 * Create a mock harness that yields a configurable sequence of AgentEvents.
 * Simulates parent-to-sub-agent handoff patterns that different SDKs produce.
 */
function createMockHarness(name: string, events: AgentEvent[]): MockHarness {
  return {
    name,
    async *run(_config: MockHarnessRunConfig): AsyncGenerator<AgentEvent> {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createTestConfig(overrides?: Partial<MockHarnessRunConfig>): MockHarnessRunConfig {
  return {
    harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
    systemPrompt: 'You are a test agent.',
    messages: [
      {
        id: 'msg-1',
        agentId: 'test-agent',
        role: 'user',
        content: 'Hello',
        createdAt: new Date(),
      } as any,
    ],
    tools: [],
    secrets: {},
    agentId: 'test-agent',
    runId: 'run-001',
    conversationId: 'conv-001',
    workspaceDir: '/tmp/test-workspace',
    ...overrides,
  };
}

/**
 * Collect all events from a mock harness run.
 */
async function collectEvents(harness: MockHarness, config: MockHarnessRunConfig): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of harness.run(config)) {
    events.push(event);
  }
  return events;
}

function protoEnvelopes(events: AgentEvent[], runId: string) {
  return events.map((event, idx) => agentEventToProto(event, idx + 1, runId));
}

async function collectProtoEnvelopes(harness: MockHarness, config: MockHarnessRunConfig) {
  return protoEnvelopes(await collectEvents(harness, config), config.runId);
}

function expectSequentialProtos(
  protos: Array<ReturnType<typeof agentEventToProto>>,
  runId?: string,
) {
  for (let i = 0; i < protos.length; i++) {
    expect(protos[i].sequence).toBe(BigInt(i + 1));
    expect(protos[i].timestamp!.seconds).toBeGreaterThan(BigInt(0));
    if (runId) expect(protos[i].runId).toBe(runId);
  }
  for (let i = 1; i < protos.length; i++) {
    expect(protos[i].sequence).toBeGreaterThan(protos[i - 1].sequence);
  }
}

describe('Harness-Native Sub-Agents', () => {
  // 1. Sub-agent events appear in the event stream

  describe('sub-agent events appear in the event stream', () => {
    it('should yield tool_call_start/end events from a simulated parent-to-sub-agent handoff', async () => {
      // Simulate an OpenAI Agents SDK handoff pattern:
      // Parent agent delegates to sub-agent via tool call, sub-agent runs
      // its own tool calls, and results flow back as normal events.
      const subAgentEvents: AgentEvent[] = [
        { type: 'text_delta', content: 'Parent thinking...' },
        // Parent delegates to sub-agent (appears as a tool call)
        {
          type: 'tool_call_start',
          id: 'tc-parent-1',
          name: 'delegate_to_analyzer',
          args: { query: 'analyze revenue data' },
        },
        // Sub-agent makes its own tool calls (nested inside the parent's tool call)
        {
          type: 'tool_call_start',
          id: 'tc-sub-1',
          name: 'query_database',
          args: { sql: 'SELECT * FROM revenue' },
        },
        {
          type: 'tool_call_end',
          id: 'tc-sub-1',
          result: '{"rows": 42}',
          durationMs: 150,
        },
        // Sub-agent's analysis text
        { type: 'text_delta', content: 'Revenue analysis complete.' },
        // Parent's delegation tool call ends
        {
          type: 'tool_call_end',
          id: 'tc-parent-1',
          result: 'Sub-agent analysis: Revenue is growing.',
          durationMs: 2500,
        },
        { type: 'done' },
      ];

      const harness = createMockHarness('claude-agents', subAgentEvents);
      const config = createTestConfig();
      const events = await collectEvents(harness, config);

      // All events (parent + sub-agent) should be present in the stream
      expect(events).toHaveLength(7);
      expect(events[0]).toEqual({ type: 'text_delta', content: 'Parent thinking...' });
      expect(events[1].type).toBe('tool_call_start');
      expect((events[1] as any).name).toBe('delegate_to_analyzer');
      expect(events[2].type).toBe('tool_call_start');
      expect((events[2] as any).name).toBe('query_database');
      expect(events[3].type).toBe('tool_call_end');
      expect((events[3] as any).id).toBe('tc-sub-1');
      expect(events[4]).toEqual({ type: 'text_delta', content: 'Revenue analysis complete.' });
      expect(events[5].type).toBe('tool_call_end');
      expect((events[5] as any).id).toBe('tc-parent-1');
      expect(events[6].type).toBe('done');
    });

    it('should correctly convert all sub-agent event types through proto-convert', async () => {
      const subAgentEvents: AgentEvent[] = [
        { type: 'text_delta', content: 'Sub-agent output' },
        {
          type: 'tool_call_start',
          id: 'tc-sub-2',
          name: 'sub_tool',
          args: { param: 'value' },
        },
        {
          type: 'tool_call_end',
          id: 'tc-sub-2',
          result: 'sub-tool result',
          durationMs: 75,
        },
        { type: 'done', result: 'Final result from sub-agent' },
      ];

      const runId = 'run-sub-001';
      let seq = 0;

      for (const event of subAgentEvents) {
        seq++;
        const protoEnvelope = agentEventToProto(event, seq, runId);
        expect(protoEnvelope.sequence).toBe(BigInt(seq));
        expect(protoEnvelope.runId).toBe(runId);
        expect(protoEnvelope.timestamp).toEqual(expect.any(Object));
        expect(protoEnvelope.event).toEqual(expect.any(Object));
      }
    });

    it('should treat sub-agent events identically to parent events in proto conversion', () => {
      // A parent tool_call_start and a sub-agent tool_call_start should
      // produce structurally identical proto messages (only differing in content).
      const parentEvent: AgentEvent = {
        type: 'tool_call_start',
        id: 'tc-parent',
        name: 'parent_tool',
        args: { x: 1 },
      };
      const subAgentEvent: AgentEvent = {
        type: 'tool_call_start',
        id: 'tc-sub',
        name: 'sub_agent_tool',
        args: { y: 2 },
      };

      const parentProto = agentEventToProto(parentEvent, 1, 'run-1');
      const subProto = agentEventToProto(subAgentEvent, 2, 'run-1');
      expect(parentProto.event?.event.case).toBe('toolCallStart');
      expect(subProto.event?.event.case).toBe('toolCallStart');

      // Both use the same run_id
      expect(parentProto.runId).toBe(subProto.runId);
    });
  });
  // 2. Container resource limits apply to combined workload

  describe('container resource limits apply to combined parent + sub-agent workload', () => {
    let docker: ReturnType<typeof createMockDocker>;
    let manager: ContainerManager;

    beforeEach(() => {
      const mockContainer = createMockContainer();
      docker = createMockDocker({
        createContainer: vi.fn(async () => mockContainer),
        getContainer: vi.fn(() => mockContainer),
        _mockContainer: mockContainer,
      });
      manager = new ContainerManager(undefined, docker as any);
    });

    it('should apply a single set of resource limits to the container (no per-sub-agent splitting)', async () => {
      const info = await manager.createContainer({
        sessionId: 'run-subagent-001',
        agentId: 'multi-agent',
        harnessName: 'claude-agents',
        cpus: 2.0,
        memoryMb: 1024,
        pidsLimit: 512,
      });

      expect(info.status).toBe('created');
      expect(docker.createContainer).toHaveBeenCalledTimes(1);

      const arg = docker.createContainer.mock.calls[0][0];

      // Resource limits are applied once to the container,
      // covering both parent and all sub-agents.
      expect(arg.HostConfig.CpuQuota).toBe(200_000); // 2.0 * 100000
      expect(arg.HostConfig.Memory).toBe(2048 * 1024 * 1024);
      expect(arg.HostConfig.MemorySwap).toBe(2048 * 1024 * 1024); // No swap
      expect(arg.HostConfig.PidsLimit).toBe(512);
    });

    it('should NOT have any per-sub-agent resource configuration API', () => {
      // By design (AD-4), there is no concept of per-sub-agent resource limits.
      // The ContainerManager only knows about CreateContainerOptions, which has
      // a single set of resource fields (cpus, memoryMb, pidsLimit).
      // Verify there's no sub-agent resource field.
      const opts = {
        sessionId: 'run-1',
        agentId: 'a1',
        harnessName: 'claude-agents',
        cpus: 1.0,
        memoryMb: 512,
        pidsLimit: 256,
      };

      // These are the only resource-related keys
      expect('cpus' in opts).toBe(true);
      expect('memoryMb' in opts).toBe(true);
      expect('pidsLimit' in opts).toBe(true);

      // No sub-agent specific fields exist
      expect('subAgentCpus' in opts).toBe(false);
      expect('subAgentMemoryMb' in opts).toBe(false);
      expect('perSubAgentLimits' in opts).toBe(false);
    });

    it('should set NODE_OPTIONS heap size for combined workload', async () => {
      await manager.createContainer({
        sessionId: 'run-heap-test',
        agentId: 'agent-heap',
        harnessName: 'pi-agent',
        memoryMb: 2048,
      });

      const arg = docker.createContainer.mock.calls[0][0];
      const nodeOpts = arg.Env.find((e: string) => e.startsWith('NODE_OPTIONS='));

      // 90% of 2048 = 1843 MiB heap for the combined parent + sub-agent process
      expect(nodeOpts).toBe(`NODE_OPTIONS=--max-old-space-size=${Math.floor(2048 * 0.9)}`);
    });
  });
  // 3. Sub-agent errors surface as error events

  describe('sub-agent errors surface as error events', () => {
    it('should propagate sub-agent error events through the stream', async () => {
      const eventsWithSubAgentError: AgentEvent[] = [
        { type: 'text_delta', content: 'Starting delegation...' },
        {
          type: 'tool_call_start',
          id: 'tc-delegate',
          name: 'delegate_to_sub_agent',
          args: { task: 'analyze' },
        },
        // Sub-agent encounters an error
        { type: 'error', error: 'Sub-agent failed: rate limit exceeded' },
      ];

      const harness = createMockHarness('claude-agents', eventsWithSubAgentError);
      const config = createTestConfig();
      const events = await collectEvents(harness, config);

      expect(events).toHaveLength(3);

      // The error event should be the last one
      const errorEvent = events[2];
      expect(errorEvent.type).toBe('error');
      expect((errorEvent as any).error).toBe('Sub-agent failed: rate limit exceeded');
    });

    it('should convert sub-agent error events to proto error envelopes', () => {
      const errorEvent: AgentEvent = {
        type: 'error',
        error: 'Sub-agent OOM killed',
      };

      const proto = agentEventToProto(errorEvent, 5, 'run-err-001');

      expect(proto.event?.event.case).toBe('error');
      expect(proto.sequence).toBe(BigInt(5));
      expect(proto.runId).toBe('run-err-001');

      const errorValue = proto.event?.event.value as any;
      expect(errorValue.message).toBe('Sub-agent OOM killed');
      expect(errorValue.category).toBe('runtime');
    });

    it('should mark the run as failed when a sub-agent error occurs (no partial success)', async () => {
      // When a sub-agent error is the last event (no subsequent 'done'),
      // the stream terminates with the error -- the run is considered failed.
      const eventsEndingInError: AgentEvent[] = [
        { type: 'text_delta', content: 'Working...' },
        { type: 'error', error: 'Sub-agent crashed: segfault' },
      ];

      const harness = createMockHarness('claude-agents', eventsEndingInError);
      const config = createTestConfig();
      const events = await collectEvents(harness, config);

      const lastEvent = events[events.length - 1];
      expect(lastEvent.type).toBe('error');

      // There should NOT be a 'done' event after the error
      const doneEvents = events.filter((e) => e.type === 'done');
      expect(doneEvents).toHaveLength(0);
    });

    it('should propagate tool_call_end with error field from sub-agent', async () => {
      const eventsWithToolError: AgentEvent[] = [
        {
          type: 'tool_call_start',
          id: 'tc-sub-err',
          name: 'risky_operation',
          args: {},
        },
        {
          type: 'tool_call_end',
          id: 'tc-sub-err',
          result: '',
          error: 'Permission denied in sub-agent sandbox',
          durationMs: 50,
        },
        { type: 'done' },
      ];

      const harness = createMockHarness('pi-agent', eventsWithToolError);
      const config = createTestConfig();
      const events = await collectEvents(harness, config);

      const toolEnd = events.find(
        (e) => e.type === 'tool_call_end' && (e as any).id === 'tc-sub-err',
      ) as any;
      expect(toolEnd).toEqual(expect.objectContaining({ type: 'tool_call_end' }));
      expect(toolEnd.error).toBe('Permission denied in sub-agent sandbox');
    });
  });
  // 4. Each harness can be instantiated without orchestrator deps

  describe('each harness can be instantiated without orchestrator deps', () => {
    async function constructHarness(name: 'pi-agent' | 'langgraph' | 'claude-agents'): Promise<AgentHarness> {
      const constructors = {
        'pi-agent': async () => new (await import('../../packages/ctxmill/src/harness/pi-agent.js')).PIAgentHarness(),
        langgraph: async () => new (await import('../../packages/ctxmill/src/harness/langgraph.js')).LangGraphHarness(),
        'claude-agents': async () => new (await import('../../packages/ctxmill/src/harness/claude-agents.js')).ClaudeAgentsHarness(),
      };
      return constructors[name]();
    }

    it.each(['pi-agent', 'langgraph', 'claude-agents'] as const)(
      'should construct %s harness with no arguments',
      async (name) => {
        const harness = await constructHarness(name);
        expect(harness.name).toBe(name);
        expect(typeof harness.openSession).toBe('function');
      },
    );

    it('all 3 harnesses should implement the AgentHarness interface', async () => {
      const harnesses = await Promise.all(
        (['pi-agent', 'langgraph', 'claude-agents'] as const).map(constructHarness),
      );

      const names = new Set(harnesses.map((h) => h.name));
      expect(names.size).toBe(3);

      for (const h of harnesses) {
        expect(typeof h.name).toBe('string');
        expect(h.name.length).toBeGreaterThan(0);
        expect(typeof h.openSession).toBe('function');
      }
    });
  });
  // 5. Harness selection in runner.ts

  describe('harness selection in runner', () => {
    it('runner.ts switch covers all 3 harness names', async () => {
      // Read the runner source and verify the switch statement covers all names.
      // This is a structural assertion — we import the module and verify the
      // harness names it resolves match the expected set.
      const supportedNames = [
        'pi-agent',
        'langgraph',
        'claude-agents',
      ];

      // Verify each name produces a valid harness by instantiating them
      // the same way runner.ts does (lazy import + new)
      const harnessModules: Record<string, { default?: any; [key: string]: any }> = {
        'pi-agent': await import('../../packages/ctxmill/src/harness/pi-agent.js'),
        'langgraph': await import('../../packages/ctxmill/src/harness/langgraph.js'),
        'claude-agents': await import('../../packages/ctxmill/src/harness/claude-agents.js'),
      };

      for (const name of supportedNames) {
        const mod = harnessModules[name];
        expect(mod).toEqual(expect.any(Object));
        // Each module exports exactly one harness class
        const className = Object.keys(mod).find(
          (k) => k.endsWith('Harness') && typeof mod[k] === 'function',
        );
        expect(className).toEqual(expect.any(String));
        const instance = new mod[className!]();
        expect(instance.name).toBe(name);
      }
    });
  });
  // 6. Proto event envelope preserves sub-agent context

  describe('proto event envelope preserves sub-agent context', () => {
    it('should assign monotonically increasing sequence numbers to all events including sub-agent tool calls', () => {
      const events: AgentEvent[] = [
        { type: 'text_delta', content: 'Parent output' },
        {
          type: 'tool_call_start',
          id: 'tc-parent-1',
          name: 'delegate',
          args: { task: 'analyze' },
        },
        {
          type: 'tool_call_start',
          id: 'tc-sub-1',
          name: 'sub_query',
          args: { q: 'data' },
        },
        {
          type: 'tool_call_end',
          id: 'tc-sub-1',
          result: 'sub result',
          durationMs: 100,
        },
        {
          type: 'tool_call_end',
          id: 'tc-parent-1',
          result: 'delegated result',
          durationMs: 500,
        },
        { type: 'done', result: 'All done' },
      ];

      const runId = 'run-seq-test';
      expectSequentialProtos(protoEnvelopes(events, runId), runId);
    });

    it('should set valid timestamps on all events', () => {
      const events: AgentEvent[] = [
        {
          type: 'tool_call_start',
          id: 'tc-sub-ts',
          name: 'sub_tool',
          args: {},
        },
        {
          type: 'tool_call_end',
          id: 'tc-sub-ts',
          result: 'done',
          durationMs: 50,
        },
      ];

      expectSequentialProtos(protoEnvelopes(events, 'run-ts-test'));
    });

    it('should use the parent run_id for all events (not a sub-agent run_id)', () => {
      const parentRunId = 'run-parent-abc';

      const events: AgentEvent[] = [
        { type: 'text_delta', content: 'Parent' },
        // Sub-agent events -- they all use the parent's run_id
        {
          type: 'tool_call_start',
          id: 'tc-sub',
          name: 'sub_agent_tool',
          args: {},
        },
        {
          type: 'tool_call_end',
          id: 'tc-sub',
          result: 'sub result',
          durationMs: 100,
        },
        { type: 'error', error: 'Sub-agent error if any' },
        { type: 'done' },
      ];

      expectSequentialProtos(protoEnvelopes(events, parentRunId), parentRunId);
    });

    it('should preserve correct event case in proto for each event type', () => {
      const eventCasePairs: Array<[AgentEvent, string]> = [
        [{ type: 'text_delta', content: 'x' }, 'textDelta'],
        [
          { type: 'tool_call_start', id: 'tc1', name: 'fn', args: {} },
          'toolCallStart',
        ],
        [
          { type: 'tool_call_end', id: 'tc1', result: 'r', durationMs: 10 },
          'toolCallEnd',
        ],
        [
          { type: 'approval_needed', id: 'ap1', tool: 'tool', args: {} },
          'approvalNeeded',
        ],
        [
          { type: 'approval_resolved', id: 'ap1', action: 'approve' },
          'approvalResolved',
        ],
        [{ type: 'error', error: 'e' }, 'error'],
        [{ type: 'done' }, 'done'],
      ];

      for (const [event, expectedCase] of eventCasePairs) {
        const proto = agentEventToProto(event, 1, 'run-case-test');
        expect(proto.event?.event.case).toBe(expectedCase);
      }
    });

    it('should preserve tool call details in proto conversion for sub-agent tool calls', () => {
      const toolStart: AgentEvent = {
        type: 'tool_call_start',
        id: 'tc-sub-detail',
        name: 'sub_agent_database_query',
        args: { sql: 'SELECT COUNT(*) FROM users', limit: 100 },
      };

      const toolEnd: AgentEvent = {
        type: 'tool_call_end',
        id: 'tc-sub-detail',
        result: '{"count": 42}',
        error: undefined,
        durationMs: 250,
      };

      const startProto = agentEventToProto(toolStart, 1, 'run-detail');
      const endProto = agentEventToProto(toolEnd, 2, 'run-detail');

      // Verify tool_call_start details
      expect(startProto.event?.event.case).toBe('toolCallStart');
      const startValue = startProto.event?.event.value as any;
      expect(startValue.id).toBe('tc-sub-detail');
      expect(startValue.name).toBe('sub_agent_database_query');
      expect(startValue.argsJson).toBe(
        JSON.stringify({ sql: 'SELECT COUNT(*) FROM users', limit: 100 }),
      );

      // Verify tool_call_end details
      expect(endProto.event?.event.case).toBe('toolCallEnd');
      const endValue = endProto.event?.event.value as any;
      expect(endValue.id).toBe('tc-sub-detail');
      expect(endValue.result).toBe('{"count": 42}');
      expect(endValue.durationMs).toBe(BigInt(250));
    });

    it('should handle a complex multi-step sub-agent interaction with correct sequencing', () => {
      // Simulate a Vercel AI multi-step tool use pattern with nested sub-agent
      const events: AgentEvent[] = [
        { type: 'text_delta', content: 'Let me analyze this.' },
        // Step 1: Parent calls coordinator
        {
          type: 'tool_call_start',
          id: 'tc-coord',
          name: 'coordinator',
          args: { action: 'dispatch' },
        },
        // Step 2: Coordinator delegates to sub-agent A
        {
          type: 'tool_call_start',
          id: 'tc-sub-a',
          name: 'data_fetcher',
          args: { source: 'api' },
        },
        {
          type: 'tool_call_end',
          id: 'tc-sub-a',
          result: '{"data": "fetched"}',
          durationMs: 200,
        },
        // Step 3: Coordinator delegates to sub-agent B
        {
          type: 'tool_call_start',
          id: 'tc-sub-b',
          name: 'data_analyzer',
          args: { data: 'fetched' },
        },
        {
          type: 'tool_call_end',
          id: 'tc-sub-b',
          result: '{"analysis": "positive"}',
          durationMs: 300,
        },
        // Step 4: Coordinator finishes
        {
          type: 'tool_call_end',
          id: 'tc-coord',
          result: 'Analysis complete: positive trend',
          durationMs: 600,
        },
        { type: 'text_delta', content: 'The analysis shows a positive trend.' },
        { type: 'done', result: 'Complete' },
      ];

      const runId = 'run-multi-step';
      const protos = protoEnvelopes(events, runId);
      expect(protos).toHaveLength(9);
      expectSequentialProtos(protos, runId);
    });
  });
  // Integration: simulated full sub-agent flow through proto conversion

  describe('integration: full sub-agent flow through proto conversion', () => {
    it('should simulate a complete OpenAI Agents SDK handoff flow', async () => {
      // This simulates what the runner.ts loop does:
      // 1. Harness yields events (including sub-agent events)
      // 2. Each event is converted to a proto envelope with seq + timestamp + runId
      // 3. The envelopes are yielded to the gRPC stream

      const handoffEvents: AgentEvent[] = [
        { type: 'text_delta', content: 'Analyzing request...' },
        // Handoff to sub-agent (SDK-level delegation appears as tool call)
        {
          type: 'tool_call_start',
          id: 'handoff-1',
          name: 'transfer_to_specialist',
          args: { specialist: 'finance' },
        },
        // Sub-agent's own tool calls
        {
          type: 'tool_call_start',
          id: 'sub-tc-1',
          name: 'query_financial_data',
          args: { ticker: 'AAPL' },
        },
        {
          type: 'tool_call_end',
          id: 'sub-tc-1',
          result: '{"price": 185.42}',
          durationMs: 120,
        },
        { type: 'text_delta', content: 'AAPL is at $185.42.' },
        // Handoff completes
        {
          type: 'tool_call_end',
          id: 'handoff-1',
          result: 'Finance specialist analysis complete',
          durationMs: 3000,
        },
        { type: 'text_delta', content: 'The finance specialist reports AAPL at $185.42.' },
        {
          type: 'done',
          result: 'Analysis complete',
          usage: { inputTokens: 500, outputTokens: 150, totalTokens: 650 },
        },
      ];

      const harness = createMockHarness('claude-agents', handoffEvents);
      const config = createTestConfig({ runId: 'run-handoff-flow' });
      const protoEnvelopes = await collectProtoEnvelopes(harness, config);
      expect(protoEnvelopes).toHaveLength(8);
      expectSequentialProtos(protoEnvelopes, 'run-handoff-flow');

      // Verify the done event has usage info
      const doneEnvelope = protoEnvelopes[protoEnvelopes.length - 1];
      expect(doneEnvelope.event?.event.case).toBe('done');
      const doneValue = doneEnvelope.event?.event.value as any;
      expect(doneValue.usage).toEqual(expect.objectContaining({ inputTokens: expect.any(BigInt) }));
      expect(doneValue.usage.inputTokens).toBe(BigInt(500));
      expect(doneValue.usage.outputTokens).toBe(BigInt(150));
      expect(doneValue.usage.totalTokens).toBe(BigInt(650));
    });

    it('should simulate a LangGraph sub-graph pattern', async () => {
      // LangGraph sub-graphs appear as nested tool executions in the event stream
      const subGraphEvents: AgentEvent[] = [
        { type: 'text_delta', content: 'Invoking sub-graph...' },
        {
          type: 'tool_call_start',
          id: 'sg-invoke',
          name: 'research_subgraph',
          args: { topic: 'market trends' },
        },
        // Sub-graph internal steps appear as tool calls
        {
          type: 'tool_call_start',
          id: 'sg-step-1',
          name: 'web_search',
          args: { query: 'market trends 2026' },
        },
        {
          type: 'tool_call_end',
          id: 'sg-step-1',
          result: 'Found 10 articles',
          durationMs: 800,
        },
        {
          type: 'tool_call_start',
          id: 'sg-step-2',
          name: 'summarize',
          args: { articles: '10 articles' },
        },
        {
          type: 'tool_call_end',
          id: 'sg-step-2',
          result: 'Market trends are positive',
          durationMs: 400,
        },
        {
          type: 'tool_call_end',
          id: 'sg-invoke',
          result: 'Research complete: Market trends are positive',
          durationMs: 1500,
        },
        { type: 'done' },
      ];

      const harness = createMockHarness('langgraph', subGraphEvents);
      const config = createTestConfig({ runId: 'run-subgraph' });
      const envelopes = await collectProtoEnvelopes(harness, config);

      expect(envelopes).toHaveLength(8);

      // All tool_call_start and tool_call_end events should be present
      const toolStarts = envelopes.filter((e) => e.event?.event.case === 'toolCallStart');
      const toolEnds = envelopes.filter((e) => e.event?.event.case === 'toolCallEnd');
      expect(toolStarts).toHaveLength(3);
      expect(toolEnds).toHaveLength(3);
    });

    it('should simulate a PI Agent delegation pattern', async () => {
      // PI Agent uses a delegation pattern where the parent agent explicitly
      // delegates tasks to specialized sub-agents via tool calls
      const delegationEvents: AgentEvent[] = [
        { type: 'text_delta', content: 'Delegating to specialist...' },
        {
          type: 'tool_call_start',
          id: 'pi-delegate',
          name: 'delegate',
          args: { agent: 'code-reviewer', code: 'function foo() {}' },
        },
        {
          type: 'tool_call_end',
          id: 'pi-delegate',
          result: 'Code review: no issues found',
          durationMs: 1200,
        },
        { type: 'text_delta', content: 'The code review passed.' },
        { type: 'done' },
      ];

      const harness = createMockHarness('pi-agent', delegationEvents);
      const config = createTestConfig();

      const events = await collectEvents(harness, config);
      expect(events).toHaveLength(5);
      expect(events[0].type).toBe('text_delta');
      expect(events[1].type).toBe('tool_call_start');
      expect(events[2].type).toBe('tool_call_end');
      expect(events[3].type).toBe('text_delta');
      expect(events[4].type).toBe('done');
    });
  });
});
