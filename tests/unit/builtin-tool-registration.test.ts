import { describe, it, expect } from 'vitest';
import { LocalFunctionExecutor } from '../../packages/stablehand/src/tool/executor.js';
import { builtinTools, builtinToolNames } from '../../packages/stablehand/src/tool/builtin/index.js';
import { builtinNamesAllowedByPolicy } from '../../packages/stablehand/src/tool/builtin/policy.js';
import { createStablehandGuideTool } from '../../packages/stablehand/src/tool/builtin/stablehand-guide.js';

describe('Builtin tool registration', () => {
  it('resolveToolsForAgent includes emit-event even when agent does not declare it', () => {
    const toolExecutor = new LocalFunctionExecutor();

    for (const tool of builtinTools) {
      toolExecutor.register(tool);
    }

    const declaredTools = new Set(['search-web']);
    const resolved = new Map<string, { name: string }>();

    for (const tool of toolExecutor.list()) {
      if (declaredTools.has(tool.name) || builtinToolNames.has(tool.name)) {
        resolved.set(tool.name, tool);
      }
    }

    expect(resolved.has('emit-event')).toBe(true);
  });

  it('all builtinTools are listed after registration', () => {
    const toolExecutor = new LocalFunctionExecutor();

    for (const tool of builtinTools) {
      toolExecutor.register(tool);
    }
    toolExecutor.register(createStablehandGuideTool({ listTools: () => toolExecutor.list() }));

    const names = toolExecutor.list().map((t) => t.name);
    for (const name of builtinToolNames) {
      expect(names).toContain(name);
    }
  });

  it.each([
    [{ policy: 'all' } as const, [...builtinToolNames].sort()],
    [{ policy: 'none' } as const, []],
    [{ policy: 'allow', names: ['emit-event'] } as const, ['emit-event']],
    [
      { policy: 'deny', names: ['emit-event'] } as const,
      [...builtinToolNames].filter((name) => name !== 'emit-event').sort(),
    ],
  ])('enforces builtin policy %j', (policy, expected) => {
    expect([...builtinNamesAllowedByPolicy(builtinToolNames, policy)].sort()).toEqual(expected);
  });
});
