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
  bucket?: string;
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
      harnessConfig: { provider: 'openai', model: 'gpt-5.4-mini' },
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
    expect(data.storageKey).toBe(`artifacts/${data.artifactId}/test-upload.txt`);
    expect(data.expiresIn).toBe(3600);

    const uploadUrl = new URL(data.uploadUrl);
    expect(uploadUrl.host).toBe('localhost:9000');
    expect(uploadUrl.searchParams.has('X-Amz-Signature')).toBe(true);

    const metadataResponse = await fetch(`${ARTIFACTS_BASE}/${data.artifactId}`);
    expect(metadataResponse.status).toBe(200);

    const metadata: ArtifactRecord = await metadataResponse.json();
    expect(metadata.id).toBe(data.artifactId);
    expect(metadata.agentId).toBe(testAgentId);
    expect(metadata.name).toBe('test-upload.txt');
    expect(metadata.mimeType).toBe('text/plain');
    expect(metadata.sizeBytes).toBe(100);
    expect(metadata.status).toBe('pending_upload');

    const downloadBeforeUpload = await fetch(`${ARTIFACTS_BASE}/${data.artifactId}/download-url`);
    expect(downloadBeforeUpload.status).toBe(409);

    const listResponse = await fetch(`${ARTIFACTS_BASE}?agentId=${encodeURIComponent(testAgentId)}&limit=100&offset=0`);
    expect(listResponse.status).toBe(200);
    const listed: ArtifactListEnvelope = await listResponse.json();
    expect(listed.artifacts.some((artifact) => artifact.id === data.artifactId)).toBe(false);
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

    const pendingMetadataResponse = await fetch(`${ARTIFACTS_BASE}/${uploadData.artifactId}`);
    expect(pendingMetadataResponse.status).toBe(200);
    const pendingMetadata: ArtifactRecord = await pendingMetadataResponse.json();
    expect(pendingMetadata.status).toBe('pending_upload');

    const downloadResponse = await fetch(`${ARTIFACTS_BASE}/${uploadData.artifactId}/download-url?expiresIn=120`);
    expect(downloadResponse.status).toBe(200);

    const metadataResponse = await fetch(`${ARTIFACTS_BASE}/${uploadData.artifactId}`);
    expect(metadataResponse.status).toBe(200);

    const metadata: ArtifactRecord = await metadataResponse.json();
    expect(metadata.id).toBe(uploadData.artifactId);
    expect(metadata.agentId).toBe(testAgentId);
    expect(metadata.name).toBe('round-trip.txt');
    expect(metadata.mimeType).toBe('text/plain');
    expect(metadata.sizeBytes).toBe(Buffer.byteLength(fileContent));
    expect(metadata.storageKey).toBe(uploadData.storageKey);
    expect(metadata.status).toBe('active');

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

    const deletedMetadata: ArtifactRecord = await deletedMetadataResponse.json();
    expect(deletedMetadata.status).toBe('deleted');
    expect(deletedMetadata.id).toBe(uploadData.artifactId);
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

  it('uploads an artifact via multipart proxy and round-trips through download', async () => {
    const fileContent = `multipart-upload-${Date.now()}`;
    const fileName = 'proxy-upload.txt';

    const formData = new FormData();
    formData.append('file', new Blob([fileContent], { type: 'text/plain' }), fileName);
    formData.append('agentId', testAgentId);
    formData.append('name', fileName);

    const uploadResponse = await fetch(`${ARTIFACTS_BASE}/upload`, {
      method: 'POST',
      body: formData,
    });

    expect(uploadResponse.status).toBe(201);
    const artifact: ArtifactRecord = await uploadResponse.json();
    createdArtifactIds.add(artifact.id);

    expect(artifact.id).toBeTruthy();
    expect(artifact.agentId).toBe(testAgentId);
    expect(artifact.name).toBe(fileName);
    expect(artifact.mimeType).toBe('text/plain');
    expect(artifact.sizeBytes).toBe(Buffer.byteLength(fileContent));
    expect(artifact.storageKey).toBe(`artifacts/${artifact.id}/${fileName}`);
    expect(artifact.status).toBe('active');

    // Verify download via proxy
    const downloadResponse = await fetch(`${ARTIFACTS_BASE}/${artifact.id}/download`);
    expect(downloadResponse.status).toBe(200);
    expect(await downloadResponse.text()).toBe(fileContent);

    // Verify it appears in list
    const listResponse = await fetch(`${ARTIFACTS_BASE}?agentId=${encodeURIComponent(testAgentId)}&limit=100&offset=0`);
    expect(listResponse.status).toBe(200);
    const listed: ArtifactListEnvelope = await listResponse.json();
    const found = listed.artifacts.find((a) => a.id === artifact.id);
    expect(found).toBeDefined();
    expect(found?.name).toBe(fileName);
  });

  it('accepts an optional name override in multipart upload', async () => {
    const formData = new FormData();
    formData.append('agentId', testAgentId);
    formData.append('name', 'renamed-artifact.bin');
    formData.append('file', new Blob(['custom-name-test'], { type: 'application/octet-stream' }), 'original.bin');

    const response = await fetch(`${ARTIFACTS_BASE}/upload`, {
      method: 'POST',
      body: formData,
    });

    expect(response.status).toBe(201);
    const artifact: ArtifactRecord = await response.json();
    createdArtifactIds.add(artifact.id);

    expect(artifact.name).toBe('renamed-artifact.bin');
  });

  it('rejects multipart upload without agentId', async () => {
    const formData = new FormData();
    formData.append('file', new Blob(['no-agent'], { type: 'text/plain' }), 'orphan.txt');

    const response = await fetch(`${ARTIFACTS_BASE}/upload`, {
      method: 'POST',
      body: formData,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('agentId');
  });

  it('rejects multipart upload without a file', async () => {
    const formData = new FormData();
    formData.append('agentId', testAgentId);

    const response = await fetch(`${ARTIFACTS_BASE}/upload`, {
      method: 'POST',
      body: formData,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('file');
  });
});
