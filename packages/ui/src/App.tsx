import { Routes, Route, useLocation } from 'react-router-dom';
import { DashboardPage } from './pages/DashboardPage';
import { ChatPage } from './pages/ChatPage';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { EventsPage } from './pages/EventsPage';
import { ToolRegistryPage } from './pages/ToolRegistryPage';
import { AgentFlowPage } from './pages/AgentFlowPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { TriggersPage } from './pages/TriggersPage';
import { SettingsPage } from './pages/SettingsPage';
import { Sidebar } from './components/ui/Sidebar';
import { ErrorBoundary } from './components/ui/ErrorBoundary';

export function App() {
  const location = useLocation();
  return (
    <div className="min-h-screen bg-surface-950 text-surface-100">
      <Sidebar />
      <div className="ml-14">
        <ErrorBoundary key={location.pathname}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/tools" element={<ToolRegistryPage />} />
          <Route path="/flow" element={<AgentFlowPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/triggers" element={<TriggersPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/agents/:id/chat" element={<ChatPage />} />
          <Route path="/agents/:id/runs/:runId" element={<RunDetailPage />} />
          <Route path="/agents/:id" element={<AgentDetailPage />} />
        </Routes>
        </ErrorBoundary>
      </div>
    </div>
  );
}
