import { Routes, Route } from 'react-router-dom';
import { DashboardPage } from './pages/DashboardPage';
import { ChatPage } from './pages/ChatPage';
import { AgentDetailPage } from './pages/AgentDetailPage';
import { RunDetailPage } from './pages/RunDetailPage';

export function App() {
  return (
    <div className="min-h-screen bg-surface-950 text-surface-100">
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/agents/:id/chat" element={<ChatPage />} />
        <Route path="/agents/:id/runs/:runId" element={<RunDetailPage />} />
        <Route path="/agents/:id" element={<AgentDetailPage />} />
      </Routes>
    </div>
  );
}
