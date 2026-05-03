import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REQUIRED_MATRIX_FIXTURES = [
  {
    dir: 'stress-lg-openai',
    eventType: 'stress.tools.complete',
    model: 'gpt-5.4',
  },
  {
    dir: 'stress-pi-openai',
    eventType: 'stress.pi.complete',
    model: 'gpt-5.4',
  },
  {
    dir: 'stress-claude-sonnet',
    eventType: 'stress.claude.complete',
    model: 'claude-sonnet-4-6',
  },
] as const;

function fixturePath(dir: string): string {
  return join(process.cwd(), 'tests', 'stress', 'agents', dir, 'agent.yaml');
}

describe('required stress fixture ADR 012 contracts', () => {
  for (const fixture of REQUIRED_MATRIX_FIXTURES) {
    it(`${fixture.dir} instructs the harness to emit schemaVersion and harness identity`, async () => {
      const content = await readFile(fixturePath(fixture.dir), 'utf8');
      const manifest = parse(content) as {
        spec?: {
          instructions?: string;
        };
      };
      const instructions = manifest.spec?.instructions ?? '';

      expect(instructions).toContain(fixture.eventType);
      expect(instructions).toContain('schemaVersion');
      expect(instructions).toContain('harness');
      expect(instructions).toContain(fixture.dir);
      expect(instructions).toContain(fixture.model);
      expect(instructions).toContain('status');
      expect(instructions).toContain('ok');
    });
  }
});
