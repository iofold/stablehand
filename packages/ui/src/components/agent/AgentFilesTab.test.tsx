import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentFilesTab } from './AgentFilesTab';
import { uploadWorkspaceTarball } from '@/lib/api';

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
  };
});

const uploadWorkspaceTarballMock = vi.mocked(uploadWorkspaceTarball);

describe('AgentFilesTab workspace upload', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    uploadWorkspaceTarballMock.mockResolvedValue({ files: 1, totalBytes: 12 });
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

  it('disables base workspace archive uploads in session view', () => {
    act(() => {
      root.render(<AgentFilesTab agentId="agent-1" sessionId="session-1" />);
    });

    const button = container.querySelector('button[data-testid="workspace-upload-button"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('Base workspace uploads are disabled in session view.');
  });
});
