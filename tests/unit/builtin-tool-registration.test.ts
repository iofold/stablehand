import { describe, it, expect } from 'vitest';
import { LocalFunctionExecutor } from '../../packages/ctxmill/src/tool/executor.js';
import { builtinTools, builtinToolNames } from '../../packages/ctxmill/src/tool/builtin/index.js';

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

    const names = toolExecutor.list().map((t) => t.name);
    for (const name of builtinToolNames) {
      expect(names).toContain(name);
    }
  });
});
