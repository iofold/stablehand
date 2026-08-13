import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsPage } from '../SettingsPage';
import { fetchConfig, fetchSettings, updateSettings } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('@/components/settings/BudgetsSection', () => ({
  BudgetsSection: () => null,
}));

const fetchConfigMock = vi.mocked(fetchConfig);
const fetchSettingsMock = vi.mocked(fetchSettings);
const updateSettingsMock = vi.mocked(updateSettings);

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SettingsPage setting limits', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    fetchConfigMock.mockResolvedValue({
      system: { version: 'test', uptime: 1_000, dbPath: '/tmp/test.db' },
      agentDefaults: { harness: 'test', temperature: 0, maxTokens: 100 },
    });
    fetchSettingsMock.mockResolvedValue({
      maxWorkspaceTarBytes: 100 * 1024 * 1024,
      maxTarUploadBytes: 100 * 1024 * 1024,
      idleTimeoutMs: 300_000,
      turnTimeoutMs: 1_800_000,
      reconciliationIntervalMs: 300_000,
      maxGlobalContainers: 20,
      maxQueuedTurnsGlobal: 1000,
  maxQueuedTurnsPerAgent: 100,
  queuedTurnTimeoutMs: 1_800_000,
  queueTimeoutMs: 600_000,
      maxConcurrentSessionsPerAgent: 20,
      maxTriggerDepth: 5,
      defaultCpus: 1,
      defaultMemoryMb: 1024,
      defaultPidsLimit: 256,
      defaultTimeoutSec: 43_200,
    });
    updateSettingsMock.mockResolvedValue({} as never);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function inputFor(label: string): HTMLInputElement {
    const labelElement = Array.from(container.querySelectorAll('p')).find((element) =>
      element.textContent === label,
    );
    const input = labelElement?.parentElement?.parentElement?.querySelector('input');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`No numeric input found for ${label}`);
    }
    return input;
  }

  it.each([
    ['Max Workspace Snapshot', '1', '1024', ''],
    ['Max Workspace Upload', '1', '1024', ''],
    ['Idle Timeout', '10', '3600', ''],
    ['Turn Timeout', '30', '7200', ''],
    ['Reconciliation Interval', '10', '3600', ''],
    ['Max Global Containers', '1', '100', ''],
    ['Queue Timeout', '5', '1800', ''],
    ['Max Sessions Per Agent', '1', '20', ''],
    ['Max Trigger Depth', '1', '20', ''],
    ['Default CPU', '0.1', '16', '0.1'],
    ['Default Memory', '128', '32768', ''],
    ['Default PID Limit', '32', '2048', ''],
    ['Default Session Timeout', '60', '43200', ''],
  ])('uses the server-supported bounds for %s', async (label, min, max, step) => {
    act(() => {
      root.render(<SettingsPage />);
    });
    await flushEffects();

    expect(inputFor(label)).toMatchObject({ min, max, step });
  });

  it('blocks an out-of-range draft before sending the settings mutation', async () => {
    act(() => {
      root.render(<SettingsPage />);
    });
    await flushEffects();

    const turnTimeout = inputFor('Turn Timeout');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      valueSetter?.call(turnTimeout, '10');
      turnTimeout.dispatchEvent(new Event('input', { bubbles: true }));
      turnTimeout.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save all settings'),
    );
    await act(async () => {
      save!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(updateSettingsMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('turnTimeoutMs must be between 30000 and 7200000');
  });
});
