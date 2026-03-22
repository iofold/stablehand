import { describe, expect, it } from 'vitest';
import {
  extractA2UIBlocks,
  isAllowedComponent,
  normalizeComponentName,
  sanitizeProps,
} from './extract.js';

describe('A2UI extraction', () => {
  it('normalizes supported component aliases', () => {
    expect(normalizeComponentName('ctxmill.charts:MetricCard')).toBe('MetricCard');
    expect(normalizeComponentName('charts:MetricCard')).toBe('MetricCard');
    expect(normalizeComponentName('ctxmill.hitl:ApprovalCard')).toBe('ApprovalCard');
    expect(isAllowedComponent('ctxmill.charts:MetricCard')).toBe(true);
  });

  it('canonicalizes aliases and preserves supported MetricCard props', () => {
    const blocks = extractA2UIBlocks(
      '{"component":"ctxmill.charts:MetricCard","props":{"title":"Users","value":42,"changeLabel":"vs last week"}}',
    );

    expect(blocks).toEqual([
      {
        component: 'MetricCard',
        props: {
          title: 'Users',
          value: 42,
          changeLabel: 'vs last week',
        },
      },
    ]);
  });

  it('maps legacy chart and HITL payload shapes into supported props', () => {
    expect(
      sanitizeProps('FunnelChart', {
        data: [{ label: 'Leads', value: 10 }],
      }),
    ).toEqual({
      data: [{ label: 'Leads', value: 10 }],
      stages: [{ label: 'Leads', value: 10 }],
    });

    expect(
      sanitizeProps('SankeyDiagram', {
        data: {
          nodes: [{ id: 'a', name: 'A' }],
          links: [{ source: 'a', target: 'b', value: 1 }],
        },
      }),
    ).toEqual({
      data: {
        nodes: [{ id: 'a', name: 'A' }],
        links: [{ source: 'a', target: 'b', value: 1 }],
      },
      nodes: [{ id: 'a', name: 'A' }],
      links: [{ source: 'a', target: 'b', value: 1 }],
    });

    expect(
      sanitizeProps('KnowledgeGraphView', {
        data: {
          nodes: [{ id: 'n1', label: 'Node' }],
          edges: [{ source: 'n1', target: 'n2' }],
        },
      }),
    ).toEqual({
      data: {
        nodes: [{ id: 'n1', label: 'Node' }],
        edges: [{ source: 'n1', target: 'n2' }],
      },
      nodes: [{ id: 'n1', label: 'Node' }],
      edges: [{ source: 'n1', target: 'n2' }],
    });

    expect(
      sanitizeProps('ApprovalCard', {
        toolName: 'deploy',
        args: { env: 'prod' },
      }),
    ).toEqual({
      action: 'deploy',
      details: { env: 'prod' },
      toolName: 'deploy',
      args: { env: 'prod' },
    });
  });
});
