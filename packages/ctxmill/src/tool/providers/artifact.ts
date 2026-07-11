import { z } from 'zod';
import type { ToolProvider } from '../provider.js';
import type { ToolDefinition } from '@ctxmill/sandbox-daemon';

/**
 * Provides artifact:upload and artifact:download tool definitions.
 *
 * These tools have location 'daemon' — they are intercepted and executed
 * by the sandbox daemon process, not by the harness SDK or orchestrator.
 * The handler stubs here are placeholders; actual execution happens in
 * the daemon's artifact-handler module.
 */
export class ArtifactToolProvider implements ToolProvider {
  readonly name = 'artifact';

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: 'artifact_upload',
        description: 'Upload a file from the workspace to persistent artifact storage. Returns an artifact ID that can be shared with other agents or external callers.',
        input: z.object({
          path: z.string().describe('File path relative to /workspace'),
          name: z.string().optional().describe('Display name for the artifact (defaults to filename)'),
          mimeType: z.string().optional().describe('MIME type (auto-detected from extension if omitted)'),
          metadata: z.record(z.string(), z.unknown()).optional().describe('Optional key-value metadata'),
        }),
        location: 'daemon' as const,
        handler: async () => {
          throw new Error('artifact_upload must be handled by the sandbox daemon');
        },
      },
      {
        name: 'artifact_download',
        description: 'Download an artifact from storage to the workspace by its artifact ID.',
        input: z.object({
          artifactId: z.string().describe('Artifact ID to download'),
          path: z.string().optional().describe('Workspace path to save to (defaults to original filename)'),
        }),
        location: 'daemon' as const,
        handler: async () => {
          throw new Error('artifact_download must be handled by the sandbox daemon');
        },
      },
    ];
  }
}
