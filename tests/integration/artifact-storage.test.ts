import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../../packages/ctxmill/src/artifact/artifact-store.js';

const MINIO_ENDPOINT = process.env.S3_ENDPOINT || 'http://localhost:9000';
const MINIO_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'ctxmill';
const MINIO_SECRET_KEY = process.env.S3_SECRET_KEY || 'ctxmill-dev';
const MINIO_REGION = process.env.S3_REGION || 'us-east-1';
const TEST_BUCKET = `test-artifacts-${Date.now()}-${process.pid}`;

describe('Artifact Storage Integration (MinIO)', () => {
  let store: ArtifactStore;
  const createdKeys = new Set<string>();

  beforeAll(async () => {
    store = new ArtifactStore({
      s3Endpoint: MINIO_ENDPOINT,
      s3Region: MINIO_REGION,
      s3AccessKey: MINIO_ACCESS_KEY,
      s3SecretKey: MINIO_SECRET_KEY,
      bucket: TEST_BUCKET,
    });

    await store.ensureBucket();
  });

  afterAll(async () => {
    await Promise.all([...createdKeys].map(async (key) => store.deleteObject(key)));
  });

  it('creates bucket idempotently and exposes the configured bucket', async () => {
    await expect(store.ensureBucket()).resolves.toBeUndefined();
    expect(store.getBucket()).toBe(TEST_BUCKET);
  });

  it('verifies the full object round-trip against real MinIO', async () => {
    const key = 'test-agent/round-trip/hello.txt';
    const content = Buffer.from('Hello, artifact storage!');
    const mimeType = 'text/plain';
    createdKeys.add(key);

    await store.upload(key, content, mimeType);

    const head = await store.headObject(key);
    expect(head).not.toBeNull();
    expect(head?.sizeBytes).toBe(content.byteLength);
    expect(head?.contentType).toBe(mimeType);

    const download = await store.download(key);
    expect(Buffer.from(download.body)).toEqual(content);
    expect(download.contentType).toBe(mimeType);

    const signedDownloadUrl = await store.getSignedDownloadUrl(key, 300);
    expect(signedDownloadUrl).toContain(TEST_BUCKET);
    expect(signedDownloadUrl).toContain('X-Amz-Signature');

    const signedDownloadResponse = await fetch(signedDownloadUrl);
    expect(signedDownloadResponse.ok).toBe(true);
    expect(await signedDownloadResponse.text()).toBe(content.toString());

    const signedUploadKey = 'test-agent/signed-upload/upload.txt';
    createdKeys.add(signedUploadKey);
    const signedUploadUrl = await store.getSignedUploadUrl(signedUploadKey, mimeType, 300);
    expect(signedUploadUrl).toContain(TEST_BUCKET);
    expect(signedUploadUrl).toContain('X-Amz-Signature');

    const uploadedViaSignedUrl = 'Uploaded via signed URL';
    const signedUploadResponse = await fetch(signedUploadUrl, {
      method: 'PUT',
      body: uploadedViaSignedUrl,
      headers: {
        'content-type': mimeType,
      },
    });
    expect(signedUploadResponse.ok).toBe(true);

    const signedUploadDownload = await store.download(signedUploadKey);
    expect(Buffer.from(signedUploadDownload.body).toString()).toBe(uploadedViaSignedUrl);
    expect(signedUploadDownload.contentType).toBe(mimeType);

    await store.deleteObject(key);
    await store.deleteObject(signedUploadKey);

    expect(await store.headObject(key)).toBeNull();
    expect(await store.headObject(signedUploadKey)).toBeNull();
  });

  it('handles binary payloads, missing keys, and idempotent deletes', async () => {
    const key = 'test-agent/binary/data.bin';
    const content = Buffer.alloc(256);
    createdKeys.add(key);

    for (let index = 0; index < content.length; index += 1) {
      content[index] = index;
    }

    await store.upload(key, content, 'application/octet-stream');

    const download = await store.download(key);
    expect(Buffer.from(download.body)).toEqual(content);

    const head = await store.headObject(key);
    expect(head).not.toBeNull();
    expect(head?.sizeBytes).toBe(content.byteLength);
    expect(head?.contentType).toBe('application/octet-stream');

    expect(await store.headObject('missing/object.bin')).toBeNull();

    await expect(store.deleteObject(key)).resolves.toBeUndefined();
    await expect(store.deleteObject(key)).resolves.toBeUndefined();
    await expect(store.deleteObject('missing/object.bin')).resolves.toBeUndefined();
    expect(await store.headObject(key)).toBeNull();
  });
});
