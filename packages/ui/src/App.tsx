import { Routes, Route, useLocation } from 'react-router-dom';
import { DashboardPage } from './pages/DashboardPage';
import { SessionPage } from './pages/SessionPage';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { EventsPage } from './pages/EventsPage';
import { ToolRegistryPage } from './pages/ToolRegistryPage';
import { AgentFlowPage } from './pages/AgentFlowPage';
import { TriggersPage } from './pages/TriggersPage';
import { SettingsPage } from './pages/SettingsPage';
import { ArtifactsPage } from './pages/ArtifactsPage';
import { Sidebar } from './components/ui/Sidebar';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { TokenGate } from './components/ui/TokenGate';
import { useApiAuthStore } from './lib/auth';
import {
  CONVERSATION_ROUTE,
  LEGACY_CHAT_ROUTE,
  LEGACY_NEW_SESSION_ROUTE,
  LEGACY_SESSION_ROUTE,
  NEW_CONVERSATION_ROUTE,
} from './lib/routes';

export function App() {
  const location = useLocation();
  const apiToken = useApiAuthStore((s) => s.token);

  return (
    <div className="min-h-screen overflow-x-hidden bg-surface-950 text-surface-100">
      <Sidebar />
      <TokenGate />
      <div className="min-h-screen ml-0 pt-12 md:ml-12 md:pt-0">
        <ErrorBoundary key={`${location.pathname}:${apiToken ? 'authenticated' : 'anonymous'}`}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/tools" element={<ToolRegistryPage />} />
            <Route path="/flow" element={<AgentFlowPage />} />
            <Route path="/triggers" element={<TriggersPage />} />
            <Route path="/artifacts" element={<ArtifactsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path={NEW_CONVERSATION_ROUTE} element={<SessionPage />} />
            <Route path={CONVERSATION_ROUTE} element={<SessionPage />} />
            {/* Backwards-compatible session/chat routes stay mounted directly so older deep links
                still render the composer/history even outside nested route resolution. */}
            <Route path={LEGACY_NEW_SESSION_ROUTE} element={<SessionPage />} />
            <Route path={LEGACY_SESSION_ROUTE} element={<SessionPage />} />
            <Route path={LEGACY_CHAT_ROUTE} element={<SessionPage />} />
            <Route path="/agents/:id" element={<AgentDetailPage />} />
          </Routes>
        </ErrorBoundary>
      </div>
    </div>
  );
}
