import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactDetailPanel } from './ArtifactDetailPanel';
import { ArtifactRow } from './ArtifactRow';
import { downloadArtifact, type Artifact } from '@/lib/api';
import { useArtifactsStore } from '@/stores/artifacts';
import { useAgentsStore } from '@/stores/agents';
import { ArtifactSchema } from '@stablehand/contracts';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, downloadArtifact: vi.fn() };
});

const downloadArtifactMock = vi.mocked(downloadArtifact);

const ARTIFACT: Artifact = ArtifactSchema.parse({
  id: 'artifact-1',
  agentId: 'agent-1',
  turnId: null,
  conversationId: null,
  name: 'report.csv',
  mimeType: 'text/csv',
  sizeBytes: 128,
  storageKey: 'artifacts/report.csv',
  bucket: 'test',
  kind: null,
  metadata: null,
  status: 'active',
  expiresAt: null,
  createdAt: 1,
  updatedAt: 1,
});

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('artifact action errors', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    downloadArtifactMock.mockReset().mockResolvedValue(undefined);
    useAgentsStore.setState((state) => ({ ...state, agents: [] }));
    useArtifactsStore.setState((state) => ({
      ...state,
      selectedArtifact: null,
      selectArtifact: vi.fn(),
      clearSelection: vi.fn(),
      deleteArtifact: vi.fn().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('shows the authenticated download API detail in an artifact row', async () => {
    downloadArtifactMock.mockRejectedValueOnce(new Error('Invalid API token for artifact download'));
    act(() => {
      root.render(<table><tbody><ArtifactRow artifact={ARTIFACT} isSelected={false} /></tbody></table>);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Download"]')!.click();
    });
    await flushEffects();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Invalid API token for artifact download');
  });

  it('shows the authenticated download API detail in the detail panel', async () => {
    downloadArtifactMock.mockRejectedValueOnce(new Error('Artifact download URL expired'));
    useArtifactsStore.setState({ selectedArtifact: ARTIFACT });
    act(() => {
      root.render(<ArtifactDetailPanel />);
    });

    const download = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Download File'),
    );
    await act(async () => {
      download!.click();
    });
    await flushEffects();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Artifact download URL expired');
  });

  it('shows the delete API detail and keeps the artifact row interactive', async () => {
    useArtifactsStore.setState({
      deleteArtifact: vi.fn().mockRejectedValue(new Error('Artifact is locked')),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    act(() => {
      root.render(<table><tbody><ArtifactRow artifact={ARTIFACT} isSelected={false} /></tbody></table>);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Delete"]')!.click();
    });
    await flushEffects();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Artifact is locked');
    expect(container.querySelector<HTMLButtonElement>('button[title="Delete"]')?.disabled).toBe(false);
    vi.mocked(window.confirm).mockRestore();
  });
});
