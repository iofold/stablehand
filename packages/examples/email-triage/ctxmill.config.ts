import { defineConfig } from 'ctxmill';

export default defineConfig({
  preset: 'local',
  name: 'email-triage',
  version: '0.1.0',
  agents: [
    'agents/triage',
    'agents/urgent-responder',
    'agents/meeting-scheduler',
    'agents/digest-writer',
  ],
  tools: ['tools/*.ts'],
});
