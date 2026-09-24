import { z } from 'zod';
import { defineTool } from 'stablehand';
import fs from 'fs';
import path from 'path';

export default defineTool({
  name: 'process-image',
  description: 'Read image file metadata (size, format, dimensions estimate) from the workspace. Useful for multimodal file handling.',
  input: z.object({
    url: z.string().describe('URL or path to the image file'),
    operations: z.array(z.string()).describe('Image operations to perform'),
    output_format: z.string().optional().describe('Output format for processed image'),
  }),
  handler: async (rawInput, ctx) => {
    const input = rawInput as {
      url: string;
      operations: string[];
      output_format?: string;
    };
    const cwd = ctx.workspaceDir || process.cwd();
    const resolved = path.resolve(cwd, input.url);
    if (!resolved.startsWith(cwd)) {
      return JSON.stringify({ error: 'Path traversal blocked' });
    }
    if (!fs.existsSync(resolved)) {
      return JSON.stringify({ error: `File not found: ${input.url}` });
    }
    const stat = fs.statSync(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const supportedFormats = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff'];
    const isImage = supportedFormats.includes(ext);
    const buffer = fs.readFileSync(resolved);
    const base64Preview = buffer.subarray(0, 256).toString('base64');
    return JSON.stringify({
      url: input.url,
      size: stat.size,
      format: ext.replace('.', ''),
      isImage,
      operations: input.operations,
      outputFormat: input.output_format || ext.replace('.', ''),
      modifiedAt: stat.mtime.toISOString(),
      base64Header: base64Preview,
    });
  },
});
