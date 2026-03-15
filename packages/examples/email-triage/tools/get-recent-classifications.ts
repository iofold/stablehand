import { defineTool } from 'ctxmill';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export default defineTool({
  name: 'get-recent-classifications',
  description: 'Retrieve recent email classifications from the local store for digest generation',
  input: z.object({
    limit: z.number().default(50).describe('Maximum number of classifications to return'),
    since: z.string().optional().describe('Only return classifications after this ISO 8601 timestamp'),
  }),
  handler: async (input, ctx) => {
    const storePath = resolve(ctx.workspaceDir, '.data', 'classifications.json');

    let classifications: Array<{ classifiedAt: string; [key: string]: unknown }>;
    try {
      const raw = await readFile(storePath, 'utf-8');
      classifications = JSON.parse(raw) as Array<{ classifiedAt: string; [key: string]: unknown }>;
    } catch {
      return JSON.stringify({
        classifications: [],
        total: 0,
        message: 'No classifications found — no emails have been triaged yet',
      });
    }

    // Filter by timestamp if provided
    if (input.since) {
      const sinceDate = new Date(input.since).getTime();
      classifications = classifications.filter(
        (c) => new Date(c.classifiedAt).getTime() >= sinceDate
      );
    }

    // Apply limit
    const limited = classifications.slice(-input.limit);

    // Compute summary stats
    const byPriority: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const c of limited) {
      const p = c.priority as string;
      const cat = c.category as string;
      byPriority[p] = (byPriority[p] ?? 0) + 1;
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    }

    return JSON.stringify({
      classifications: limited,
      total: limited.length,
      summary: { byPriority, byCategory },
      message: `Retrieved ${limited.length} classifications`,
    });
  },
});
