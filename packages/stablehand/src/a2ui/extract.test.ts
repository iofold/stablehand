import { describe, expect, it } from 'vitest';
import {
  isAllowedComponent,
  normalizeComponentName,
  sanitizeProps,
} from './extract.js';

describe('A2UI extraction', () => {
  it('normalizes supported component aliases', () => {
    expect(normalizeComponentName('stablehand.charts:MetricCard')).toBe('MetricCard');
    expect(normalizeComponentName('charts:MetricCard')).toBe('MetricCard');
    expect(normalizeComponentName('stablehand.hitl:ApprovalCard')).toBe('stablehand.hitl:ApprovalCard');
    expect(isAllowedComponent('stablehand.charts:MetricCard')).toBe(true);
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

  });
});
