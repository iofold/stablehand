import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ScaffoldOptions {
  projectDir: string;
  packageName: string;
  template?: string;
}

export function scaffold({ projectDir, packageName }: ScaffoldOptions): void {
  // Create project structure
  mkdirSync(join(projectDir, 'agents', 'assistant'), { recursive: true });
  mkdirSync(join(projectDir, 'tools'), { recursive: true });
  mkdirSync(join(projectDir, 'feedback'), { recursive: true });
  mkdirSync(join(projectDir, 'policies'), { recursive: true });
  mkdirSync(join(projectDir, 'tests'), { recursive: true });
  mkdirSync(join(projectDir, '.ctxmill'), { recursive: true });

  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version: '0.1.0',
        type: 'module',
        private: true,
        scripts: {
          dev: 'docker compose up --build',
          'dev:down': 'docker compose down',
          'dev:logs': 'docker compose logs -f',
          test: 'vitest run',
          chat: 'docker compose exec orchestrator npx ctxmill chat',
          eval: 'ctxmill eval',
        },
        dependencies: {
          ctxmill: '^0.1.0',
          zod: '^3.24.0',
        },
        devDependencies: {
          typescript: '^5.8.0',
          vitest: '^3.0.0',
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(projectDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          outDir: 'dist',
          rootDir: '.',
          erasableSyntaxOnly: true,
        },
        include: [
          'agents/**/*.ts',
          'tools/**/*.ts',
          'tests/**/*.ts',
          'ctxmill.config.ts',
        ],
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(projectDir, 'ctxmill.config.ts'),
    `import { defineConfig } from 'ctxmill';

export default defineConfig({
  preset: 'docker',
});
`,
  );

  writeFileSync(
    join(projectDir, 'agents', 'assistant', 'agent.ts'),
    `import { defineAgent } from 'ctxmill';

export default defineAgent({
  name: 'assistant',
  model: 'claude-sonnet-4-6',
  tools: ['read-file', 'list-directory', 'search-files'],
  systemPrompt: \`You are a helpful AI assistant powered by CTXMill.

## Instructions
- Use available tools to help the user
- Be concise and helpful
- When asked to show data visually, use A2UI components (charts, tables, etc.)
- For actions that could have consequences, ask for approval first
- Use list-directory and read-file to explore the project structure when asked
- Use search-files to find relevant information across project files

## A2UI Components Available
You can render rich UI by outputting JSON blocks:
- TimeSeriesChart: { component: "TimeSeriesChart", props: { title, data, xKey, yKey } }
- BarChart: { component: "BarChart", props: { title, data, xKey, yKey } }
- PieChart: { component: "PieChart", props: { title, data, nameKey, valueKey } }
- MetricCard: { component: "MetricCard", props: { title, value, change } }
- TableView: { component: "TableView", props: { title, columns, data } }
- ApprovalCard: { component: "ApprovalCard", props: { title, description, action } }
\`,
});
`,
  );

  writeFileSync(
    join(projectDir, 'tools', 'read-file.ts'),
    `import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineTool({
  name: 'read-file',
  description: 'Read the contents of a file',
  input: z.object({
    path: z.string().describe('Relative file path to read'),
  }),
  async handler({ path: filePath }) {
    const basePath = process.cwd();
    const resolved = resolve(basePath, filePath);
    if (!resolved.startsWith(basePath)) {
      return 'Error: Cannot read files outside the project directory';
    }
    try {
      const content = await readFile(resolved, 'utf-8');
      return content.length > 10000
        ? content.slice(0, 10000) + '\\n... (truncated)'
        : content;
    } catch (err) {
      return \`Error reading file: \${(err as Error).message}\`;
    }
  },
});
`,
  );

  writeFileSync(
    join(projectDir, 'tools', 'list-directory.ts'),
    `import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export default defineTool({
  name: 'list-directory',
  description: 'List files and directories in a path',
  input: z.object({
    path: z.string().default('.').describe('Directory path relative to project root'),
  }),
  async handler({ path: dirPath }) {
    const basePath = process.cwd();
    const resolved = resolve(basePath, dirPath);
    if (!resolved.startsWith(basePath)) {
      return 'Error: Cannot access directories outside the project';
    }
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const lines = await Promise.all(
        entries
          .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
          .slice(0, 100)
          .map(async (e) => {
            const fullPath = join(resolved, e.name);
            const s = await stat(fullPath).catch(() => null);
            const size = s ? (s.isDirectory() ? 'dir' : \`\${s.size}b\`) : '?';
            return \`\${e.isDirectory() ? 'DIR' : 'FILE'} \${e.name} (\${size})\`;
          })
      );
      return lines.join('\\n') || '(empty directory)';
    } catch (err) {
      return \`Error: \${(err as Error).message}\`;
    }
  },
});
`,
  );

  writeFileSync(
    join(projectDir, 'tools', 'search-files.ts'),
    `import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';

export default defineTool({
  name: 'search-files',
  description: 'Search for text patterns across project files',
  input: z.object({
    pattern: z.string().describe('Text or regex pattern to search for'),
    directory: z.string().default('.').describe('Directory to search in'),
    fileExtensions: z.array(z.string()).optional().describe('File extensions to include'),
  }),
  async handler({ pattern, directory, fileExtensions }) {
    const basePath = process.cwd();
    const searchDir = resolve(basePath, directory);
    if (!searchDir.startsWith(basePath)) {
      return 'Error: Cannot search outside the project';
    }
    const regex = new RegExp(pattern, 'gi');
    const results: string[] = [];

    async function walk(dir: string, depth = 0): Promise<void> {
      if (depth > 5 || results.length > 50) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else {
          if (fileExtensions && !fileExtensions.some(ext => entry.name.endsWith(ext))) continue;
          try {
            const content = await readFile(full, 'utf-8');
            const lines = content.split('\\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push(\`\${relative(basePath, full)}:\${i + 1}: \${lines[i].trim()}\`);
                if (results.length >= 50) return;
              }
              regex.lastIndex = 0;
            }
          } catch { /* skip binary files */ }
        }
      }
    }

    await walk(searchDir);
    return results.length > 0
      ? \`Found \${results.length} matches:\\n\${results.join('\\n')}\`
      : 'No matches found';
  },
});
`,
  );

  writeFileSync(
    join(projectDir, 'Dockerfile'),
    `FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3001

CMD ["npx", "ctxmill", "dev"]
`,
  );

  writeFileSync(
    join(projectDir, 'docker-compose.yml'),
    `services:
  orchestrator:
    build: .
    environment:
      DATABASE_URL: \${DATABASE_URL:-postgres://ctxmill:ctxmill@postgres:5432/ctxmill}
      CTXMILL_PORT: 3001
      CTXMILL_UI_MODE: disabled
      CTXMILL_API_URL: http://localhost:3001
      OPENAI_API_KEY: \${OPENAI_API_KEY:-}
      ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY:-}
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "3002:3001"
    volumes:
      - .:/app
      - node_modules:/app/node_modules
      - ctxmill_data:/app/.ctxmill

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ctxmill
      POSTGRES_USER: ctxmill
      POSTGRES_PASSWORD: ctxmill
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ctxmill -d ctxmill"]
      interval: 5s
      timeout: 5s
      retries: 20
    ports:
      - "5433:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
  node_modules:
  ctxmill_data:
`,
  );

  writeFileSync(
    join(projectDir, '.dockerignore'),
    `node_modules/
dist/
.ctxmill/
.git/
`,
  );

  writeFileSync(
    join(projectDir, 'feedback', 'examples.yaml'),
    `# Ground truth examples for evaluation
examples:
  - input: "Hello, what can you help me with?"
    expected_contains:
      - "help"
      - "assist"
`,
  );

  writeFileSync(
    join(projectDir, 'policies', 'tools.yaml'),
    `# Tool authorization policies
agents:
  assistant:
    allowed_tools:
      - read-file
      - list-directory
      - search-files
    denied_patterns: []
`,
  );

  writeFileSync(
    join(projectDir, 'tests', 'assistant.test.ts'),
    `import { describe, it, expect } from 'vitest';

describe('Assistant Agent', () => {
  it('agent definition is valid', async () => {
    const mod = await import('../agents/assistant/agent.js');
    const agent = mod.default;

    expect(agent.name).toBe('assistant');
    expect(agent.tools).toContain('read-file');
    expect(agent.systemPrompt).toContain('Use available tools');
  });
});
`,
  );

  writeFileSync(
    join(projectDir, '.gitignore'),
    `node_modules/
dist/
.env
.ctxmill/
*.tsbuildinfo
`,
  );

  writeFileSync(
    join(projectDir, '.env.example'),
    `# Database used by docker compose
DATABASE_URL=postgres://ctxmill:ctxmill@postgres:5432/ctxmill

# Recommended: provide the API keys your agents need
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=

# Optional: custom base URL (for proxies)
# ANTHROPIC_BASE_URL=https://api.anthropic.com
`,
  );

  writeFileSync(
    join(projectDir, 'README.md'),
    `# ${packageName}

Built with [CTXMill](https://github.com/ctxmill/ctxmill) -- the framework for vertical AI products.

## Quick Start

\`\`\`bash
cp .env.example .env
# add your API keys to .env
docker compose up --build
\`\`\`

The API will be available at http://localhost:3002.

To chat with your agent from the running container:

\`\`\`bash
docker compose exec orchestrator npx ctxmill chat
\`\`\`

## Project Structure

\`\`\`
${packageName}/
  agents/assistant/agent.ts    # Agent definition
  tools/read-file.ts           # Tool implementations
  feedback/examples.yaml       # Evaluation examples
  policies/tools.yaml          # Tool authorization
  tests/                       # Tests
  ctxmill.config.ts            # Configuration
\`\`\`

## Commands

- \`npm run dev\` -- Build and start the Docker stack
- \`npm run dev:down\` -- Stop the Docker stack
- \`npm run dev:logs\` -- Tail container logs
- \`npm run chat\` -- Open terminal chat inside the orchestrator container
- \`npx vitest\` -- Run tests
`,
  );
}
