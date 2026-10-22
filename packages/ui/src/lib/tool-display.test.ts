import { describe, expect, it } from 'vitest';
import {
  a2uiDisplayName,
  baseToolName,
  isApprovalToolName,
  summarizeToolArgs,
  toolDisplayName,
} from './tool-display';

describe('tool display names', () => {
  it('strips MCP transport prefixes', () => {
    expect(baseToolName('mcp__stablehand__a2ui-render')).toBe('a2ui-render');
    expect(baseToolName('mcp__my_server__lookup')).toBe('lookup');
    expect(baseToolName('Read')).toBe('Read');
  });

  it('maps intrinsic and harness-native tools to plain labels', () => {
    expect(toolDisplayName('mcp__stablehand__request-approval')).toBe('Approval request');
    expect(toolDisplayName('mcp__stablehand__emit-event')).toBe('Emit event');
    expect(toolDisplayName('mcp__stablehand__artifact_upload')).toBe('Upload artifact');
    expect(toolDisplayName('request-approval')).toBe('Approval request');
    expect(toolDisplayName('TodoWrite')).toBe('To-do list');
    expect(toolDisplayName('write_todos')).toBe('To-do list');
    expect(toolDisplayName('Read')).toBe('Read');
  });

  it('sentence-cases unknown tool names', () => {
    expect(toolDisplayName('read_file')).toBe('Read file');
    expect(toolDisplayName('get-weather')).toBe('Get weather');
    expect(toolDisplayName('fetchURLContents')).toBe('Fetch URL contents');
  });

  it('labels calls whose name was never recorded', () => {
    expect(toolDisplayName('unknown')).toBe('Tool call');
    expect(toolDisplayName('')).toBe('Tool call');
    expect(toolDisplayName(undefined)).toBe('Tool call');
  });

  it('names A2UI cards after the component', () => {
    expect(a2uiDisplayName('BarChart')).toBe('Bar chart');
    expect(a2uiDisplayName('stablehand.charts:MetricCard')).toBe('Metric');
    expect(a2uiDisplayName('CustomWidget')).toBe('Custom widget');
  });

  it('recognises the approval tool behind a prefix', () => {
    expect(isApprovalToolName('mcp__stablehand__request-approval')).toBe(true);
    expect(isApprovalToolName('emit-event')).toBe(false);
  });

  it('summarises the most telling argument', () => {
    expect(summarizeToolArgs({ file_path: '/workspace/a.md', content: 'x' })).toBe('/workspace/a.md');
    expect(summarizeToolArgs({ reason: 'Write  the\nsummary', details: {} })).toBe('Write the summary');
    expect(summarizeToolArgs({ todos: [{}, {}] })).toBe('2 items');
    expect(summarizeToolArgs({ count: 3 })).toBeUndefined();
    expect(summarizeToolArgs('raw')).toBeUndefined();
  });
});
