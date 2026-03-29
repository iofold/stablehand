import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { allowConsoleErrors } from '../setup-strict.js';

const API_BASE = process.env.API_URL ?? 'http://localhost:3002';
const AGENTS_BASE = `${API_BASE}/api/agents`;
const ARTIFACTS_BASE = `${API_BASE}/api/artifacts`;

type CreatedAgent = {
  id: string;
  name: string;
};

type UploadUrlResponse = {
  artifactId: string;
  uploadUrl: string;
  storageKey: string;
  expiresIn: number;
};

type DownloadUrlResponse = {
  url: string;
  expiresIn: number;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

type ArtifactRecord = {
  id: string;
  agentId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  status: string;
  deletedAt: string | null;
};

type ArtifactEnvelope = {
  artifact: ArtifactRecord;
};

type ArtifactListEnvelope = {
  artifacts: ArtifactRecord[];
};

const createdAgentIds = new Set<string>();
const createdArtifactIds = new Set<string>();
const deletedArtifactIds = new Set<string>();

function uniqueName(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function createTestAgent(prefix: string): Promise<CreatedAgent> {
  const response = await fetch(AGENTS_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: uniqueName(prefix),
      displayName: 'Artifact REST Test',
      harness: 'langgraph',
      description: 'Live REST artifact integration test agent',
      harnessConfig: { provider: 'openai', model: 'gpt-5-mini' },
      systemPrompt: 'You are a test agent.',
      tools: ['artifact_upload', 'artifact_download'],
    }),
  });

  expect(response.status).toBe(201);
  const agent: CreatedAgent = await response.json();
  createdAgentIds.add(agent.id);
  return agent;
}

async function deleteAgent(agentId: string) {
  const response = await fetch(`${AGENTS_BASE}/${agentId}`, { method: 'DELETE' });
  expect([200, 204, 404]).toContain(response.status);
}

async function deleteArtifact(artifactId: string) {
  const response = await fetch(`${ARTIFACTS_BASE}/${artifactId}`, { method: 'DELETE' });
  expect([200, 404]).toContain(response.status);
  if (response.status === 200) {
    deletedArtifactIds.add(artifactId);
  }
}

describe('Artifact REST API Integration', () => {
  let testAgentId = '';
  let emptyAgentId = '';

  beforeEach(() => {
    allowConsoleErrors();
  });

  beforeAll(async () => {
    const [testAgent, emptyAgent] = await Promise.all([
      createTestAgent('artifact-rest'),
      createTestAgent('artifact-empty'),
    ]);

    testAgentId = testAgent.id;
    emptyAgentId = emptyAgent.id;
  });

  afterAll(async () => {
    for (const artifactId of createdArtifactIds) {
      if (!deletedArtifactIds.has(artifactId)) {
        await deleteArtifact(artifactId);
      }
    }

    for (const agentId of createdAgentIds) {
      await deleteAgent(agentId);
    }
  });

  it('returns a signed upload URL and creates artifact metadata', async () => {
    const response = await fetch(`${ARTIFACTS_BASE}/upload-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: testAgentId,
        name: 'test-upload.txt',
        mimeType: 'text/plain',
        sizeBytes: 100,
      }),
    });

    expect(response.status).toBe(200);
    const data: UploadUrlResponse = await response.json();
    createdArtifactIds.add(data.artifactId);

    expect(data.artifactId).toBeTruthy();
    expect(data.storageKey).toContain(testAgentId);
    expect(data.expiresIn).toBe(3600);

    const uploadUrl = new URL(data.uploadUrl);
    expect(uploadUrl.host).toBe('localhost:9000');
    expect(uploadUrl.searchParams.has('X-Amz-Signature')).toBe(true);

    const metadataResponse = await fetch(`${ARTIFACTS_BASE}/${data.artifactId}`);
    expect(metadataResponse.status).toBe(200);

    const metadata: ArtifactEnvelope = await metadataResponse.json();
    expect(metadata.artifact.id).toBe(data.artifactId);
    expect(metadata.artifact.agentId).toBe(testAgentId);
    expect(metadata.artifact.name).toBe('test-upload.txt');
    expect(metadata.artifact.mimeType).toBe('text/plain');
    expect(metadata.artifact.sizeBytes).toBe(100);
    expect(metadata.artifact.status).toBe('active');
  });

  it('rejects invalid upload-url requests', async () => {
    const missingAgentId = await fetch(`${ARTIFACTS_BASE}/upload-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'missing-agent.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
      }),
    });

    expect(missingAgentId.status).toBe(400);

    const missingName = await fetch(`${ARTIFACTS_BASE}/upload-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: testAgentId,
        mimeType: 'text/plain',
        sizeBytes: 10,
      }),
    });

    expect(missingName.status).toBe(400);
  });

  it('round-trips an artifact through upload URL, metadata, download URL, list, and delete', async () => {
    const fileContent = `artifact-rest-round-trip-${Date.now()}`;
    const uploadUrlResponse = await fetch(`${ARTIFACTS_BASE}/upload-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: testAgentId,
        name: 'round-trip.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(fileContent),
      }),
    });

    expect(uploadUrlResponse.status).toBe(200);
    const uploadData: UploadUrlResponse = await uploadUrlResponse.json();
    createdArtifactIds.add(uploadData.artifactId);

    const uploadObjectResponse = await fetch(uploadData.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: fileContent,
    });

    expect(uploadObjectResponse.status).toBe(200);

    const metadataResponse = await fetch(`${ARTIFACTS_BASE}/${uploadData.artifactId}`);
    expect(metadataResponse.status).toBe(200);

    const metadata: ArtifactEnvelope = await metadataResponse.json();
    expect(metadata.artifact.id).toBe(uploadData.artifactId);
    expect(metadata.artifact.agentId).toBe(testAgentId);
    expect(metadata.artifact.name).toBe('round-trip.txt');
    expect(metadata.artifact.mimeType).toBe('text/plain');
    expect(metadata.artifact.sizeBytes).toBe(Buffer.byteLength(fileContent));
    expect(metadata.artifact.storageKey).toBe(uploadData.storageKey);

    const downloadResponse = await fetch(`${ARTIFACTS_BASE}/${uploadData.artifactId}/download-url?expiresIn=120`);
    expect(downloadResponse.status).toBe(200);

    const downloadData: DownloadUrlResponse = await downloadResponse.json();
    expect(downloadData.expiresIn).toBe(120);
    expect(downloadData.name).toBe('round-trip.txt');
    expect(downloadData.mimeType).toBe('text/plain');
    expect(downloadData.sizeBytes).toBe(Buffer.byteLength(fileContent));

    const downloadUrl = new URL(downloadData.url);
    expect(downloadUrl.host).toBe('localhost:9000');
    expect(downloadUrl.searchParams.has('X-Amz-Signature')).toBe(true);

    const objectResponse = await fetch(downloadData.url);
    expect(objectResponse.status).toBe(200);
    expect(await objectResponse.text()).toBe(fileContent);

    const listResponse = await fetch(`${ARTIFACTS_BASE}?agentId=${encodeURIComponent(testAgentId)}&limit=100&offset=0`);
    expect(listResponse.status).toBe(200);

    const listed: ArtifactListEnvelope = await listResponse.json();
    const listedArtifact = listed.artifacts.find((artifact) => artifact.id === uploadData.artifactId);
    expect(listedArtifact).toBeDefined();
    expect(listedArtifact?.name).toBe('round-trip.txt');
    expect(listedArtifact?.status).toBe('active');

    const deleteResponse = await fetch(`${ARTIFACTS_BASE}/${uploadData.artifactId}`, {
      method: 'DELETE',
    });

    expect(deleteResponse.status).toBe(200);
    deletedArtifactIds.add(uploadData.artifactId);
    expect(await deleteResponse.json()).toEqual({ deleted: true, id: uploadData.artifactId });

    const deletedMetadataResponse = await fetch(`${ARTIFACTS_BASE}/${uploadData.artifactId}`);
    expect(deletedMetadataResponse.status).toBe(200);

    const deletedMetadata: ArtifactEnvelope = await deletedMetadataResponse.json();
    expect(deletedMetadata.artifact.status).toBe('deleted');
    expect(deletedMetadata.artifact.id).toBe(uploadData.artifactId);
  });

  it('returns 404 for a missing artifact', async () => {
    const response = await fetch(`${ARTIFACTS_BASE}/00000000-0000-0000-0000-000000000000`);
    expect(response.status).toBe(404);
  });

  it('requires agentId for list and returns an empty list for a fresh agent', async () => {
    const missingAgentIdResponse = await fetch(ARTIFACTS_BASE);
    expect(missingAgentIdResponse.status).toBe(400);

    const emptyListResponse = await fetch(`${ARTIFACTS_BASE}?agentId=${encodeURIComponent(emptyAgentId)}`);
    expect(emptyListResponse.status).toBe(200);

    const emptyList: ArtifactListEnvelope = await emptyListResponse.json();
    expect(emptyList.artifacts).toEqual([]);
  });
});
