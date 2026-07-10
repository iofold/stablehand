import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageShape,
} from '../../packages/proto/node_modules/@bufbuild/protobuf/dist/esm/index.js';
import { describe, expect, it } from 'vitest';

import {
  FreshBootstrapSchema,
  OpenSessionRequestSchema,
  ToolLocation,
  ToolMetadataSchema,
} from '../../packages/proto/gen/ctxmill/sandbox/v1/sandbox_pb.js';

function expectRoundTrip<Desc extends DescMessage>(schema: Desc, value: MessageShape<Desc>): MessageShape<Desc> {
  const bytes = toBinary(schema, value);
  const decoded = fromBinary(schema, bytes);
  expect(decoded).toStrictEqual(value);
  return decoded;
}

describe('proto v2 sandbox roundtrip', () => {
  it('preserves programmatic flag when tools are plain objects in OpenSessionRequest', () => {
    const message = create(OpenSessionRequestSchema, {
      bootstrap: {
        case: 'fresh',
        value: create(FreshBootstrapSchema, {
          agentId: 'agent-programmatic',
          conversationId: 'conversation-programmatic',
          harnessName: 'claude',
          harnessConfigJson: '{"model":"claude-sonnet-4-6"}',
          systemPrompt: 'Test programmatic flag',
          tools: [
            {
              name: 'async-tool',
              description: 'An async tool',
              inputSchemaJson: '{"type":"object"}',
              location: ToolLocation.ORCHESTRATOR,
              programmatic: true,
            },
            {
              name: 'manual-tool',
              description: 'A manual tool',
              inputSchemaJson: '{"type":"object"}',
              location: ToolLocation.ORCHESTRATOR,
              programmatic: false,
            },
          ],
          workspaceDir: '/workspace',
        }),
      },
    });

    const decoded = expectRoundTrip(OpenSessionRequestSchema, message);
    expect(decoded.bootstrap.case).toBe('fresh');
    if (decoded.bootstrap.case !== 'fresh') {
      throw new Error('Expected fresh bootstrap');
    }
    expect(decoded.bootstrap.value.tools).toHaveLength(2);
    expect(decoded.bootstrap.value.tools[0]?.name).toBe('async-tool');
    expect(decoded.bootstrap.value.tools[0]?.programmatic).toBe(true);
    expect(decoded.bootstrap.value.tools[1]?.name).toBe('manual-tool');
    expect(decoded.bootstrap.value.tools[1]?.programmatic).toBe(false);
  });

  it('preserves programmatic flag when tools are pre-created proto messages', () => {
    const message = create(OpenSessionRequestSchema, {
      bootstrap: {
        case: 'fresh',
        value: create(FreshBootstrapSchema, {
          agentId: 'agent-proto-created',
          conversationId: 'conversation-proto-created',
          harnessName: 'openai',
          harnessConfigJson: '{"model":"gpt-5.4-mini"}',
          systemPrompt: 'Test programmatic flag with proto messages',
          tools: [
            create(ToolMetadataSchema, {
              name: 'event-tool',
              description: 'An event emission tool',
              inputSchemaJson: '{"type":"object"}',
              location: ToolLocation.ORCHESTRATOR,
              programmatic: true,
            }),
            create(ToolMetadataSchema, {
              name: 'search-tool',
              description: 'A search tool',
              inputSchemaJson: '{"type":"object"}',
              location: ToolLocation.ORCHESTRATOR,
              programmatic: false,
            }),
          ],
          workspaceDir: '/workspace',
        }),
      },
    });

    const decoded = expectRoundTrip(OpenSessionRequestSchema, message);
    expect(decoded.bootstrap.case).toBe('fresh');
    if (decoded.bootstrap.case !== 'fresh') {
      throw new Error('Expected fresh bootstrap');
    }
    expect(decoded.bootstrap.value.tools).toHaveLength(2);
    expect(decoded.bootstrap.value.tools[0]?.name).toBe('event-tool');
    expect(decoded.bootstrap.value.tools[0]?.programmatic).toBe(true);
    expect(decoded.bootstrap.value.tools[1]?.name).toBe('search-tool');
    expect(decoded.bootstrap.value.tools[1]?.programmatic).toBe(false);
  });
});
