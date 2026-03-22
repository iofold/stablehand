#!/usr/bin/env npx tsx
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const API_BASE = process.env.API_URL ?? 'http://localhost:3002';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Helpers ──────────────────────────────────────────────────

interface ImportResult {
  id?: string;
  agentId?: string;
  name?: string;
  created?: boolean;
  error?: string;
  [key: string]: unknown;
}

interface TriggerResult {
  id?: string;
  error?: string;
  [key: string]: unknown;
}

async function importManifest(dir: string, manifestYaml: string): Promise<ImportResult> {
  const res = await fetch(`${API_BASE}/api/agents/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: manifestYaml }),
  });
  const data = (await res.json()) as ImportResult;
  const status = res.ok ? 'OK' : 'FAIL';
  const verb = data.created ? 'created' : 'updated';
  console.log(
    `  [${status}] ${dir} => ${data.name ?? data.id ?? 'unknown'} (${verb})`,
  );
  if (!res.ok) {
    console.error(`        Error: ${JSON.stringify(data)}`);
  }
  return data;
}

async function registerTrigger(
  agentId: string,
  eventType: string,
  taskTemplate: string,
  label: string,
): Promise<TriggerResult | null> {
  const res = await fetch(`${API_BASE}/api/triggers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, eventType, taskTemplate, enabled: true }),
  });
  const data = (await res.json()) as TriggerResult;
  if (res.ok) {
    console.log(`  [OK]   ${label}: on "${eventType}" => agent ${agentId}`);
  } else {
    console.error(`  [FAIL] ${label}: ${JSON.stringify(data)}`);
  }
  return res.ok ? data : null;
}

// ── Main ─────────────────────────────────────────────────────

async function seed(): Promise<void> {
  console.log(`\nSeeding kitchen-sink agents against ${API_BASE}\n`);

  // ── 1. Import all agent manifests ──────────────────────────

  console.log('--- Importing agent manifests ---\n');

  const agentsDir = path.join(__dirname, 'agents');
  const agentDirs = fs.readdirSync(agentsDir).sort();
  const importedAgents: Record<string, string> = {}; // dir -> agentId

  for (const dir of agentDirs) {
    const manifestPath = path.join(agentsDir, dir, 'agent.yaml');
    if (!fs.existsSync(manifestPath)) {
      console.log(`  [SKIP] ${dir}: no agent.yaml`);
      continue;
    }

    const manifestYaml = fs.readFileSync(manifestPath, 'utf-8');
    const result = await importManifest(dir, manifestYaml);
    const agentId = result.agentId ?? result.id;
    if (agentId) {
      importedAgents[dir] = agentId;
    }
  }

  const importedCount = Object.keys(importedAgents).length;
  console.log(`\nImported ${importedCount} / ${agentDirs.length} agents.\n`);

  if (importedCount === 0) {
    console.error('No agents imported. Aborting trigger registration.');
    process.exit(1);
  }

  // ── 2. Register event triggers for chaining ────────────────

  console.log('--- Registering event triggers ---\n');

  const langgraphId = importedAgents['langgraph-agent'];
  const claudeId = importedAgents['claude-agent'];
  const piId = importedAgents['pi-agent'];

  if (claudeId) {
    await registerTrigger(
      claudeId,
      'analysis.complete',
      'Write a polished final report based on this analysis:\n\n{{payload.analysis}}',
      'analyst -> writer',
    );
  }

  if (piId) {
    await registerTrigger(
      piId,
      'report.ready',
      'Audit log entry: Event "report.ready" received. Payload: {{payload}}',
      'writer -> auditor',
    );
  }

  if (piId) {
    const auditEvents = [
      'analysis.complete',
      'report.ready',
    ];
    for (const eventType of auditEvents) {
      await registerTrigger(
        piId,
        eventType,
        `Audit log entry: Event "${eventType}" received. Payload: {{payload}}`,
        `auditor <- ${eventType}`,
      );
    }
  }

  // ── 3. Summary ─────────────────────────────────────────────

  console.log('\n--- Seed complete ---\n');
  console.log('Agent chain:');
  console.log(
    `  ${langgraphId ? 'langgraph-analyst' : '(missing)'} ` +
    `--[analysis.complete]--> ${claudeId ? 'claude-writer' : '(missing)'} ` +
    `--[report.ready]--> ${piId ? 'pi-auditor' : '(missing)'}`,
  );
  console.log(
    `  ${piId ? 'pi-auditor' : '(missing)'} monitors: analysis.complete, report.ready`,
  );
  console.log('');
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
