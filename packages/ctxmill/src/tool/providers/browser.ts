import { z } from 'zod';
import type { ToolProvider } from '../provider.js';
import type { ToolDefinition } from '@ctxmill/sandbox-daemon';

/**
 * Provides browse and screenshot tool definitions (ctx-lqas).
 *
 * Location 'daemon': executed inside the sandbox by the daemon's
 * browser-handler module against the Chromium baked into every harness
 * image. Screenshots land in the workspace so they flow through the
 * existing artifact_upload path; egress control remains the host/cluster
 * boundary documented in the architecture notes.
 */
export class BrowserToolProvider implements ToolProvider {
  readonly name = 'browser';

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: 'browse',
        description: 'Load a web page in a headless browser and return its title, readable text, and links. Use for pages that need JavaScript; prefer plain HTTP tools for static content.',
        input: z.object({
          url: z.string().url().describe('The http(s) URL to load'),
          waitForSelector: z.string().optional().describe('Optional CSS selector to wait for before reading the page'),
          includeLinks: z.boolean().optional().describe('Include up to 50 links from the page (default false)'),
        }),
        location: 'daemon' as const,
        handler: async () => {
          throw new Error('browse must be handled by the sandbox daemon');
        },
      },
      {
        name: 'screenshot',
        description: 'Load a web page in a headless browser and save a PNG screenshot into the workspace. Returns the saved path — use artifact_upload to publish it.',
        input: z.object({
          url: z.string().url().describe('The http(s) URL to load'),
          path: z.string().optional().describe('Workspace-relative output path (defaults to screenshots/<host>-<timestamp>.png)'),
          fullPage: z.boolean().optional().describe('Capture the full scrollable page (default true)'),
          waitForSelector: z.string().optional().describe('Optional CSS selector to wait for before capturing'),
        }),
        location: 'daemon' as const,
        handler: async () => {
          throw new Error('screenshot must be handled by the sandbox daemon');
        },
      },
    ];
  }
}
