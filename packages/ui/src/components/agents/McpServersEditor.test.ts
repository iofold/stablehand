import { describe, expect, it } from 'vitest';

import { draftToMcpServer, emptyMcpServerDraft, mcpServerToDraft } from './McpServersEditor';

describe('MCP server drafts', () => {
  it('round-trips a bearer server with an approval list', () => {
    const server = {
      name: 'apify',
      url: 'https://mcp.apify.com/?tools=apidojo/tweet-scraper',
      auth: { type: 'bearer' as const, token: '$secret:APIFY_TOKEN' },
      tools: ['apidojo--*', 'get-dataset-items'],
      requireApproval: ['call-actor'],
    };
    const draft = mcpServerToDraft(server);
    expect(draft).toMatchObject({ auth: 'bearer', secretName: 'APIFY_TOKEN', approval: 'listed', approvalList: 'call-actor' });
    expect(draftToMcpServer(draft)).toEqual({ server });
  });

  it('builds an OAuth server with no secret', () => {
    const draft = { ...emptyMcpServerDraft(), name: 'granola', url: 'https://mcp.granola.ai/mcp', auth: 'oauth' as const };
    expect(draftToMcpServer(draft).server).toEqual({
      name: 'granola',
      url: 'https://mcp.granola.ai/mcp',
      auth: { type: 'oauth' },
    });
  });

  it('explains what is wrong in plain words', () => {
    const missingSecret = { ...emptyMcpServerDraft(), name: 'apify', url: 'https://mcp.apify.com', auth: 'bearer' as const };
    expect(draftToMcpServer(missingSecret).error).toMatch(/^apify: auth\.token/);
    const badName = { ...emptyMcpServerDraft(), name: 'Granola Notes', url: 'https://mcp.granola.ai/mcp' };
    expect(draftToMcpServer(badName).error).toMatch(/lowercase/);
  });
});
