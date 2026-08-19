import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentFilesTab } from './AgentFilesTab';
import { uploadWorkspaceTarball, fetchSettings } from '@/lib/api';

vi.mock('@/components/explorer/FileExplorer', () => ({
  FileExplorer: () => <div data-testid="file-explorer" />,
}));

vi.mock('@/components/explorer/FileViewer', () => ({
  FileViewer: () => <div data-testid="file-viewer" />,
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    uploadWorkspaceTarball: vi.fn(),
    fetchSettings: vi.fn(),
  };
});

const uploadWorkspaceTarballMock = vi.mocked(uploadWorkspaceTarball);
const fetchSettingsMock = vi.mocked(fetchSettings);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AgentFilesTab workspace upload', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    uploadWorkspaceTarballMock.mockResolvedValue({
      revision: 1,
      sha256: 'abc123',
      fileCount: 1,
      totalBytes: 12,
      appliedAt: 1234,
    });
    fetchSettingsMock.mockResolvedValue({
      maxWorkspaceTarBytes: 100 * 1024 * 1024,
      maxTarUploadBytes: 100 * 1024 * 1024,
      idleTimeoutMs: 60_000,
      turnTimeoutMs: 120_000,
      reconciliationIntervalMs: 30_000,
      maxGlobalContainers: 10,
      maxQueuedTurnsGlobal: 1000,
      maxQueuedTurnsPerAgent: 100,
      maxIngestQueueDepth: 10_000,
      queuedTurnTimeoutMs: 1_800_000,
      queueTimeoutMs: 30_000,
      maxConcurrentSessionsPerAgent: 5,
      maxTriggerDepth: 5,
      defaultCpus: 1,
      defaultMemoryMb: 512,
      defaultPidsLimit: 256,
      defaultTimeoutSec: 600,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('uploads a workspace archive through the workspace API, not artifact APIs', async () => {
    act(() => {
      root.render(<AgentFilesTab agentId="agent-1" />);
    });

    const input = container.querySelector('input[data-testid="workspace-upload-input"]') as HTMLInputElement;
    const file = new File(['archive'], 'workspace.tar.gz', { type: 'application/gzip' });

    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(uploadWorkspaceTarballMock).toHaveBeenCalledWith('agent-1', file);
    expect(container.textContent).toContain('Uploaded workspace archive: 1 files, 12 bytes.');
  });

  it('disables base workspace archive uploads in conversation view', () => {
    act(() => {
      root.render(<AgentFilesTab agentId="agent-1" conversationId="conversation-1" />);
    });

    const button = container.querySelector('button[data-testid="workspace-upload-button"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('Base workspace uploads are disabled in conversation view.');
  });

  it('rejects non-tar.gz files before uploading', async () => {
    act(() => {
      root.render(<AgentFilesTab agentId="agent-1" />);
    });
    await flushEffects();

    const input = container.querySelector('input[data-testid="workspace-upload-input"]') as HTMLInputElement;
    const file = new File(['nope'], 'archive.zip', { type: 'application/zip' });

    await act(async () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(uploadWorkspaceTarballMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('must be a .tar.gz or .tgz archive');
  });

  it('rejects archives larger than the configured limit before uploading', async () => {
    fetchSettingsMock.mockResolvedValue({
      maxWorkspaceTarBytes: 100 * 1024 * 1024,
      maxTarUploadBytes: 1024, // 1KB, very small to trigger rejection
      idleTimeoutMs: 60_000,
      turnTimeoutMs: 120_000,
      reconciliationIntervalMs: 30_000,
      maxGlobalContainers: 10,
      maxQueuedTurnsGlobal: 1000,
      maxQueuedTurnsPerAgent: 100,
      maxIngestQueueDepth: 10_000,
      queuedTurnTimeoutMs: 1_800_000,
      queueTimeoutMs: 30_000,
      maxConcurrentSessionsPerAgent: 5,
      maxTriggerDepth: 5,
      defaultCpus: 1,
      defaultMemoryMb: 512,
      defaultPidsLimit: 256,
      defaultTimeoutSec: 600,
    });

    act(() => {
      root.render(<AgentFilesTab agentId="agent-1" />);
    });
    await flushEffects();

    const input = container.querySelector('input[data-testid="workspace-upload-input"]') as HTMLInputElement;
    // Construct a fake "large" archive (10KB > 1KB limit)
    const big = new File([new Uint8Array(10 * 1024)], 'workspace.tar.gz', { type: 'application/gzip' });

    await act(async () => {
      Object.defineProperty(input, 'files', { value: [big], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(uploadWorkspaceTarballMock).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/exceeds the .* limit/);
  });

  it('exposes a drop zone that uploads dropped tar.gz archives', async () => {
    act(() => {
      root.render(<AgentFilesTab agentId="agent-1" />);
    });
    await flushEffects();

    const dropZone = container.querySelector('[data-testid="workspace-upload-dropzone"]') as HTMLElement;
    expect(dropZone).not.toBeNull();

    const file = new File(['archive'], 'workspace.tar.gz', { type: 'application/gzip' });
    const dataTransfer = {
      files: [file],
      items: [],
      types: ['Files'],
      dropEffect: 'copy' as const,
    };

    await act(async () => {
      const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: typeof dataTransfer };
      Object.defineProperty(dropEvent, 'dataTransfer', { value: dataTransfer });
      dropZone.dispatchEvent(dropEvent);
    });
    await flushEffects();

    expect(uploadWorkspaceTarballMock).toHaveBeenCalledWith('agent-1', file);
  });
});
