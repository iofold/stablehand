import { describe, expect, it } from 'vitest';

import * as manifestPackage from '../index.js';
import {
  manifestToAgentCreateInput,
  manifestToAgentPatchInput,
} from '../convert.js';
import { parseManifestString, serializeManifestJSON, serializeManifestYAML } from '../parser.js';
import type { AgentManifest } from '../types.js';
import { safeValidateManifest, validateManifest } from '../validate.js';

function minimalManifest(
  harness: 'langgraph' | 'claude-agents' | 'pi-agent' = 'langgraph',
): Record<string, unknown> {
  const harnessConfig = harness === 'claude-agents'
    ? { model: 'claude-sonnet-4-6' }
    : { provider: 'openai', model: 'gpt-5.4-mini' };

  return {
    apiVersion: 'ctxmill.io/v1',
    kind: 'Agent',
    metadata: { name: `${harness}-test` },
    spec: {
      harness,
      harnessConfig,
      instructions: 'Act precisely.',
    },
  };
}

describe('strict manifest validation', () => {
  it.each([
    ['langgraph'],
    ['claude-agents'],
    ['pi-agent'],
  ] as const)('validates the exact %s harness config', (harness) => {
    const parsed = validateManifest(minimalManifest(harness));
    expect(parsed.spec.harness).toBe(harness);
  });

  it('rejects harnesses outside the shipped registry', () => {
    const candidate = minimalManifest();
    const spec = candidate.spec as Record<string, unknown>;
    spec.harness = 'custom-harness';
    expect(safeValidateManifest(candidate).success).toBe(false);
  });

  it('rejects unknown envelope, metadata, spec, and harness config fields', () => {
    const envelope = { ...minimalManifest(), unexpected: true };
    const metadata = structuredClone(minimalManifest());
    (metadata.metadata as Record<string, unknown>).unexpected = true;
    const spec = structuredClone(minimalManifest());
    (spec.spec as Record<string, unknown>).unexpected = true;
    const harnessConfig = structuredClone(minimalManifest());
    ((harnessConfig.spec as Record<string, unknown>).harnessConfig as Record<string, unknown>).unexpected = true;

    for (const candidate of [envelope, metadata, spec, harnessConfig]) {
      expect(safeValidateManifest(candidate).success).toBe(false);
    }
  });

  it('rejects retired model and harness-level nativeToolPolicy fields', () => {
    const model = structuredClone(minimalManifest());
    (model.spec as Record<string, unknown>).model = { provider: 'openai', id: 'gpt-5.4-mini' };
    const nativeToolPolicy = structuredClone(minimalManifest('claude-agents'));
    ((nativeToolPolicy.spec as Record<string, unknown>).harnessConfig as Record<string, unknown>).nativeToolPolicy = {
      policy: 'allow',
      names: ['Read'],
    };

    expect(safeValidateManifest(model).success).toBe(false);
    expect(safeValidateManifest(nativeToolPolicy).success).toBe(false);
  });

  it('keeps the explicit nativeToolPolicy at agent level', () => {
    const candidate = structuredClone(minimalManifest());
    (candidate.spec as Record<string, unknown>).nativeToolPolicy = {
      policy: 'allow',
      names: ['Read', 'Write'],
    };

    const parsed = validateManifest(candidate);
    expect(parsed.spec.nativeToolPolicy).toEqual({
      policy: 'allow',
      names: ['Read', 'Write'],
    });
  });

  it('rejects ambiguous native tool policy shapes', () => {
    const duplicate = structuredClone(minimalManifest());
    (duplicate.spec as Record<string, unknown>).nativeToolPolicy = {
      policy: 'allow',
      names: ['Read', 'Read'],
    };
    const emptySelection = structuredClone(minimalManifest());
    (emptySelection.spec as Record<string, unknown>).nativeToolPolicy = {
      policy: 'deny',
      names: [],
    };
    const namesOnAll = structuredClone(minimalManifest());
    (namesOnAll.spec as Record<string, unknown>).nativeToolPolicy = {
      policy: 'all',
      names: ['Read'],
    };
    const retired = structuredClone(minimalManifest());
    (retired.spec as Record<string, unknown>).nativeTools = { allowlist: ['Read'] };

    expect(safeValidateManifest(duplicate).success).toBe(false);
    expect(safeValidateManifest(emptySelection).success).toBe(false);
    expect(safeValidateManifest(namesOnAll).success).toBe(false);
    expect(safeValidateManifest(retired).success).toBe(false);
  });

  it('accepts only enforced sandbox resources', () => {
    const supported = structuredClone(minimalManifest());
    (supported.spec as Record<string, unknown>).resources = {
      sandbox: { cpus: 1.5, memoryMb: 1024, pidsLimit: 128, timeoutSec: 300 },
    };
    const retired = structuredClone(minimalManifest());
    (retired.spec as Record<string, unknown>).resources = {
      maxTokensPerSession: 4_000,
    };

    expect(validateManifest(supported).spec.resources).toEqual({
      sandbox: { cpus: 1.5, memoryMb: 1024, pidsLimit: 128, timeoutSec: 300 },
    });
    expect(safeValidateManifest(retired).success).toBe(false);
  });

  it('rejects absolute, traversal, backslash, control, and dot workspace paths', () => {
    const invalidPaths = [
      '/etc/passwd',
      '../outside',
      'nested/../../outside',
      'windows\\path',
      'nul\u0000byte',
      '.',
      '',
    ];

    for (const invalidPath of invalidPaths) {
      const candidate = structuredClone(minimalManifest());
      (candidate.spec as Record<string, unknown>).workspace = {
        content: {
          files: [{ src: invalidPath, dest: 'safe.txt' }],
        },
      };
      expect(safeValidateManifest(candidate).success).toBe(false);
    }
  });

  it('strictly validates declared tools, triggers, emits, and HITL policies', () => {
    const candidate = structuredClone(minimalManifest());
    Object.assign(candidate.spec as Record<string, unknown>, {
      tools: [{ ref: 'calculator' }],
      triggers: [{ event: 'invoice.ready', input: { invoiceId: '$.id' } }],
      emits: [{ event: 'invoice.reviewed', schema: { type: 'object' } }],
      hitl: { approvals: [{ tool: 'send-payment', fallback: 'reject' }] },
    });

    expect(validateManifest(candidate).spec).toMatchObject({
      tools: [{ ref: 'calculator' }],
      triggers: [{ event: 'invoice.ready' }],
      emits: [{ event: 'invoice.reviewed' }],
      hitl: { approvals: [{ tool: 'send-payment' }] },
    });
  });
});

describe('parser and serializers', () => {
  it('parses YAML and JSON without performing implicit validation', () => {
    const yaml = `
apiVersion: ctxmill.io/v1
kind: Agent
metadata:
  name: yaml-agent
spec:
  harness: langgraph
  harnessConfig:
    provider: openai
    model: gpt-5.4-mini
  instructions: Act precisely.
`;
    expect((parseManifestString(yaml) as AgentManifest).metadata.name).toBe('yaml-agent');
    expect(parseManifestString(JSON.stringify(minimalManifest()))).toEqual(minimalManifest());
  });

  it('round-trips a validated manifest through YAML and JSON', () => {
    const manifest = validateManifest(minimalManifest());
    expect(parseManifestString(serializeManifestYAML(manifest))).toEqual(manifest);
    expect(parseManifestString(serializeManifestJSON(manifest))).toEqual(manifest);
  });

  it('rejects duplicate YAML mapping keys', () => {
    expect(() => parseManifestString(`
apiVersion: ctxmill.io/v1
apiVersion: ctxmill.io/v1
`)).toThrow();
  });
});

describe('canonical agent API conversion', () => {
  it('exports exact create and patch conversion functions instead of definition adapters', () => {
    const exports = manifestPackage as Record<string, unknown>;
    expect(exports.manifestToAgentCreateInput).toBeTypeOf('function');
    expect(exports.manifestToAgentPatchInput).toBeTypeOf('function');
    expect(exports.manifestToAgentUpdateInput).toBeUndefined();
    expect(exports.manifestToDefinition).toBeUndefined();
    expect(exports.definitionToManifest).toBeUndefined();
  });

  it('produces the exact create input without losing supported manifest fields', () => {
    const candidate = structuredClone(minimalManifest());
    candidate.metadata = {
      name: 'canonical-agent',
      displayName: 'Canonical Agent',
      description: 'Does canonical work',
      labels: { domain: 'close' },
    };
    Object.assign(candidate.spec as Record<string, unknown>, {
      tools: [{ ref: 'calculator' }, { ref: 'artifact_upload' }],
      builtinToolPolicy: { policy: 'deny', names: ['emit-event'] },
      nativeToolPolicy: { policy: 'deny', names: ['Bash'] },
      workspace: {
        content: {
          files: [{ src: 'assets/policy.txt', dest: 'policy.txt' }],
        },
      },
      resources: {
        sandbox: { cpus: 2, memoryMb: 2048, pidsLimit: 128, timeoutSec: 600 },
      },
      mode: 'background',
    });
    const manifest = validateManifest(candidate);

    expect(manifestToAgentCreateInput(manifest)).toEqual({
      name: 'canonical-agent',
      harness: 'langgraph',
      harnessConfig: {
        provider: 'openai',
        model: 'gpt-5.4-mini',
      },
      systemPrompt: 'Act precisely.',
      tools: ['calculator', 'artifact_upload'],
      description: 'Does canonical work',
      metadata: {
        displayName: 'Canonical Agent',
        labels: { domain: 'close' },
      },
      builtinToolPolicy: { policy: 'deny', names: ['emit-event'] },
      nativeToolPolicy: { policy: 'deny', names: ['Bash'] },
      workspaceContent: {
        files: [{ src: 'assets/policy.txt', dest: 'policy.txt' }],
      },
      resourceLimits: { cpus: 2, memoryMb: 2048, pidsLimit: 128, timeoutSec: 600 },
      mode: 'background',
      manifest,
    });
  });

  it('produces an exact patch input including the canonical manifest', () => {
    const manifest = validateManifest(minimalManifest('pi-agent'));
    expect(manifestToAgentPatchInput(manifest)).toEqual({
      name: 'pi-agent-test',
      harness: 'pi-agent',
      harnessConfig: {
        provider: 'openai',
        model: 'gpt-5.4-mini',
      },
      systemPrompt: 'Act precisely.',
      tools: [],
      manifest,
    });
  });

  it('requires Node resolution for file-backed instructions', () => {
    const candidate = structuredClone(minimalManifest());
    (candidate.spec as Record<string, unknown>).instructions = 'file:prompts/system.md';
    const manifest = validateManifest(candidate);

    expect(() => manifestToAgentCreateInput(manifest)).toThrow(
      'loadManifestProject',
    );
    expect(manifestToAgentCreateInput(manifest, {
      resolvedInstructions: 'Resolved prompt.',
    })).toMatchObject({
      systemPrompt: 'Resolved prompt.',
      manifest: {
        spec: { instructions: 'file:prompts/system.md' },
      },
    });
  });

  it.each([
    ['MCP tools', { tools: [{ mcp: { name: 'drive', url: 'https://mcp.example.test' } }] }, 'MCP tool'],
    ['inline tools', { tools: [{ inline: { name: 'inline', description: 'Inline', input: {} } }] }, 'inline tool'],
    ['triggers', { triggers: [{ event: 'invoice.ready' }] }, 'triggers'],
    ['emits', { emits: [{ event: 'invoice.reviewed' }] }, 'emit declarations'],
    ['HITL', { hitl: { approvals: [{ tool: 'send-payment' }] } }, 'HITL policies'],
  ])('rejects %s that the agent create contract cannot register', (_label, additions, message) => {
    const candidate = structuredClone(minimalManifest());
    Object.assign(candidate.spec as Record<string, unknown>, additions);
    const manifest = validateManifest(candidate);

    expect(() => manifestToAgentCreateInput(manifest)).toThrow(message);
  });

  it('uses a safely expanded workspace plan when supplied by the Node loader', () => {
    const candidate = structuredClone(minimalManifest());
    (candidate.spec as Record<string, unknown>).workspace = {
      content: { files: [{ src: 'assets', dest: 'assets' }] },
    };
    const manifest = validateManifest(candidate);

    expect(manifestToAgentCreateInput(manifest, {
      workspaceContent: {
        files: [
          { src: 'assets/a.txt', dest: 'assets/a.txt' },
          { src: 'assets/nested/b.txt', dest: 'assets/nested/b.txt' },
        ],
      },
    }).workspaceContent).toEqual({
      files: [
        { src: 'assets/a.txt', dest: 'assets/a.txt' },
        { src: 'assets/nested/b.txt', dest: 'assets/nested/b.txt' },
      ],
    });
  });
});
