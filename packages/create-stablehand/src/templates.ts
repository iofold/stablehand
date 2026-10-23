/**
 * Project templates. Each one is a directory under `templates/` copied over
 * the shared `templates/_base`, plus the settings and next steps below.
 */
export interface TemplateDefinition {
  name: string;
  description: string;
  /** Extra .env lines, after the shared ones. */
  env: string[];
  /** Extra package.json scripts. */
  scripts: Record<string, string>;
  /** Steps printed after scaffolding and written to the README. */
  nextSteps: string[];
}

const ANALYST_DIR = '/app/packages/examples/overnight-analyst';
// The analyst's seed and run-once ship inside the orchestrator image; run them
// there against the API on its in-container port.
const inOrchestrator = (script: string, env: string[] = []) =>
  `docker compose exec -T ${['API_URL=http://localhost:3001', ...env].map((entry) => `-e ${entry} `).join('')}`
  + `-w ${ANALYST_DIR} orchestrator node --experimental-strip-types ${script}`;

export const TEMPLATES: readonly TemplateDefinition[] = [
  {
    name: 'assistant',
    description: 'One chat agent with file-reading tools (LangGraph, gpt-5.4-mini)',
    env: [],
    scripts: {
      chat: 'docker compose exec orchestrator npx stablehand chat',
    },
    nextSteps: [
      'docker compose up -d',
      'open http://localhost:3200 and paste STABLEHAND_API_TOKEN from .env',
    ],
  },
  {
    name: 'overnight-analyst',
    description: 'A scheduled agent that browses your sources and publishes a one-page brief to a gallery',
    env: [
      '',
      '# Artifact gallery: `npm run seed` prints GALLERY_API_KEY; paste it here.',
      'COMPOSE_PROFILES=gallery',
      'GALLERY_API_KEY=',
    ],
    scripts: {
      seed: inOrchestrator('seed.ts'),
      'run-once': inOrchestrator('run-once.ts', ['GALLERY_URL=http://gallery:8090']),
    },
    nextSteps: [
      'docker compose up -d',
      'npm run seed        (creates the daily schedule and prints GALLERY_API_KEY for .env)',
      'docker compose up -d gallery',
      'npm run run-once    (one run now; prints its receipt)',
      'open http://localhost:3200 (token: STABLEHAND_API_TOKEN in .env) and http://localhost:8090',
    ],
  },
];

export const DEFAULT_TEMPLATE = 'assistant';

export function findTemplate(name: string): TemplateDefinition | undefined {
  return TEMPLATES.find((template) => template.name === name);
}
