#!/usr/bin/env node
import { createInterface } from 'node:readline';

const API_BASE = process.env.CTXMILL_API_URL || `http://localhost:${process.env.CTXMILL_PORT || '3001'}`;

interface Agent {
  id: string;
  name: string;
}

async function resolveAgentId(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/agents`);
  if (!res.ok) throw new Error(`Failed to list agents: ${res.status}`);
  const agents = (await res.json()) as Agent[];
  if (agents.length === 0) throw new Error('No agents registered. Start `ctxmill dev` first.');
  return agents[0].id;
}

export async function startChat() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let agentId: string;
  try {
    agentId = await resolveAgentId();
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log('\nCTXMill Chat (type "exit" to quit)\n');

  const prompt = () => {
    rl.question('You: ', async (input) => {
      if (input.trim() === 'exit') {
        rl.close();
        return;
      }

      try {
        // Send message
        const msgRes = await fetch(`${API_BASE}/api/agents/${agentId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: input }),
        });

        if (!msgRes.ok) {
          console.error(`\nError: ${msgRes.status} ${msgRes.statusText}\n`);
          prompt();
          return;
        }

        // Connect to SSE stream to receive the response
        const sseRes = await fetch(`${API_BASE}/api/agents/${agentId}/stream`);
        const reader = sseRes.body?.getReader();
        if (!reader) {
          console.log('\nAssistant: [no streaming response]\n');
          prompt();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let started = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6)) as { type: string; content?: string };
              if (event.type === 'TEXT_MESSAGE_CONTENT' && event.content) {
                if (!started) {
                  process.stdout.write('\nAssistant: ');
                  started = true;
                }
                process.stdout.write(event.content);
              }
              if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
                reader.cancel();
                break;
              }
            } catch {
              // Skip non-JSON lines
            }
          }
        }

        if (started) console.log('\n');
        else console.log('\nAssistant: [no text response]\n');
      } catch (err) {
        console.error('Error: Could not connect to API server. Is `ctxmill dev` running?');
        console.error(`  ${(err as Error).message}\n`);
      }

      prompt();
    });
  };

  prompt();
}

startChat().catch(console.error);
