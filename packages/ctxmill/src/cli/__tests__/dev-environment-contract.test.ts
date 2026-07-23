import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('ctxmill dev environment contract', () => {
  it('does not require a legacy global model or provider key at startup', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../dev.ts', import.meta.url)),
      'utf8',
    );

    expect(source).not.toContain('process.env.OPENAI_MODEL');
    expect(source).not.toContain('process.env.OPENAI_API_KEY');
    expect(source).not.toContain('process.env.ANTHROPIC_API_KEY');
    expect(source).not.toContain('process.env.GOOGLE_API_KEY');
    expect(source).not.toContain('Set OPENAI_MODEL');
    expect(source).toContain('Models:');
    expect(source).toContain('per-agent harness configuration');
  });
});
