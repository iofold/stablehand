import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import {
  CONVERSATION_ROUTE,
  LEGACY_CHAT_ROUTE,
  LEGACY_NEW_SESSION_ROUTE,
  LEGACY_SESSION_ROUTE,
  NEW_CONVERSATION_ROUTE,
} from './lib/routes';

vi.mock('./components/ui/Sidebar', () => ({
  Sidebar: () => null,
}));

vi.mock('./components/ui/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./pages/DashboardPage', () => ({
  DashboardPage: () => <div data-testid="dashboard-page">dashboard</div>,
}));

vi.mock('./pages/SessionPage', () => ({
  SessionPage: () => <div data-testid="session-page">session</div>,
}));

vi.mock('./pages/AgentDetailPage', () => ({
  AgentDetailPage: () => <div data-testid="agent-detail-page">agent detail</div>,
}));

vi.mock('./pages/EventsPage', () => ({
  EventsPage: () => <div data-testid="events-page">events</div>,
}));

vi.mock('./pages/ToolRegistryPage', () => ({
  ToolRegistryPage: () => <div data-testid="tools-page">tools</div>,
}));

vi.mock('./pages/AgentFlowPage', () => ({
  AgentFlowPage: () => <div data-testid="flow-page">flow</div>,
}));

vi.mock('./pages/TriggersPage', () => ({
  TriggersPage: () => <div data-testid="triggers-page">triggers</div>,
}));

vi.mock('./pages/SettingsPage', () => ({
  SettingsPage: () => <div data-testid="settings-page">settings</div>,
}));

vi.mock('./pages/ArtifactsPage', () => ({
  ArtifactsPage: () => <div data-testid="artifacts-page">artifacts</div>,
}));

describe('App routes', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderAt(path: string) {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );
    });
  }

  it.each([
    NEW_CONVERSATION_ROUTE.replace(':id', 'agent-1'),
    CONVERSATION_ROUTE.replace(':id', 'agent-1').replace(':conversationId', 'conversation-1'),
    LEGACY_NEW_SESSION_ROUTE.replace(':id', 'agent-1'),
    LEGACY_SESSION_ROUTE.replace(':id', 'agent-1').replace(':conversationId', 'conversation-1'),
    LEGACY_CHAT_ROUTE.replace(':id', 'agent-1'),
  ])('renders SessionPage for %s', (path) => {
    renderAt(path);
    expect(container.querySelector('[data-testid="session-page"]')).not.toBeNull();
  });

  it('renders the dashboard on the root route', () => {
    renderAt('/');
    expect(container.querySelector('[data-testid="dashboard-page"]')).not.toBeNull();
  });
});
