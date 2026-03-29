import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactStore } from '../../../packages/ctxmill/src/artifact/artifact-store.js';

describe('ArtifactStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ensureBucket calls HeadBucket and skips create when bucket exists', async () => {
    const { store, sendMock } = createStore();
    sendMock.mockResolvedValueOnce({});

    await store.ensureBucket();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(getSentCommand(sendMock, 0)).toEqual({
      name: 'HeadBucketCommand',
      input: { Bucket: 'artifacts' },
    });
  });

  it('ensureBucket creates the bucket when it is missing', async () => {
    const { store, sendMock } = createStore();
    sendMock
      .mockRejectedValueOnce(createAwsError('NotFound'))
      .mockResolvedValueOnce({});

    await store.ensureBucket();

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(getSentCommand(sendMock, 0)).toEqual({
      name: 'HeadBucketCommand',
      input: { Bucket: 'artifacts' },
    });
    expect(getSentCommand(sendMock, 1)).toEqual({
      name: 'CreateBucketCommand',
      input: { Bucket: 'artifacts' },
    });
  });

  it('ensureBucket tolerates BucketAlreadyOwnedByYou during create', async () => {
    const { store, sendMock } = createStore();
    sendMock
      .mockRejectedValueOnce(createAwsError('NotFound'))
      .mockRejectedValueOnce(createAwsError('BucketAlreadyOwnedByYou'));

    await expect(store.ensureBucket()).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('upload sends PutObjectCommand with key body and content type', async () => {
    const { store, sendMock } = createStore();
    const body = Buffer.from('hello');
    sendMock.mockResolvedValueOnce({});

    await store.upload('runs/output.txt', body, 'text/plain');

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(getSentCommand(sendMock, 0)).toEqual({
      name: 'PutObjectCommand',
      input: {
        Bucket: 'artifacts',
        Key: 'runs/output.txt',
        Body: body,
        ContentType: 'text/plain',
      },
    });
  });

  it('download reads the response body into a Buffer', async () => {
    const { store, sendMock } = createStore();
    const body = {
      transformToByteArray: vi.fn().mockResolvedValue(Uint8Array.from(Buffer.from('hello'))),
    };
    sendMock.mockResolvedValueOnce({ Body: body, ContentType: 'text/plain' });

    const result = await store.download('runs/output.txt');

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(getSentCommand(sendMock, 0)).toEqual({
      name: 'GetObjectCommand',
      input: {
        Bucket: 'artifacts',
        Key: 'runs/output.txt',
      },
    });
    expect(body.transformToByteArray).toHaveBeenCalledTimes(1);
    expect(result.body.equals(Buffer.from('hello'))).toBe(true);
    expect(result.contentType).toBe('text/plain');
  });

  it('getSignedDownloadUrl calls the signed URL helper with GetObjectCommand', async () => {
    const { store, getSignedUrlFn, client } = createStore();

    const result = await store.getSignedDownloadUrl('runs/output.txt', 120);

    expect(getSignedUrlFn).toHaveBeenCalledTimes(1);
    expect(getSignedCallClient(getSignedUrlFn, 0)).toBe(client);
    expect(getSignedCommand(getSignedUrlFn, 0)).toEqual({
      name: 'GetObjectCommand',
      input: {
        Bucket: 'artifacts',
        Key: 'runs/output.txt',
      },
      expiresIn: 120,
    });
    expect(result).toBe('https://minio:9000/signed-url');
  });

  it('getSignedUploadUrl calls the signed URL helper with PutObjectCommand', async () => {
    const { store, getSignedUrlFn, client } = createStore();

    const result = await store.getSignedUploadUrl('runs/output.txt', 'text/plain', 300);

    expect(getSignedUrlFn).toHaveBeenCalledTimes(1);
    expect(getSignedCallClient(getSignedUrlFn, 0)).toBe(client);
    expect(getSignedCommand(getSignedUrlFn, 0)).toEqual({
      name: 'PutObjectCommand',
      input: {
        Bucket: 'artifacts',
        Key: 'runs/output.txt',
        ContentType: 'text/plain',
      },
      expiresIn: 300,
    });
    expect(result).toBe('https://minio:9000/signed-url');
  });

  it('deleteObject sends DeleteObjectCommand', async () => {
    const { store, sendMock } = createStore();
    sendMock.mockResolvedValueOnce({});

    await store.deleteObject('runs/output.txt');

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(getSentCommand(sendMock, 0)).toEqual({
      name: 'DeleteObjectCommand',
      input: {
        Bucket: 'artifacts',
        Key: 'runs/output.txt',
      },
    });
  });

  it('headObject returns size and content type when the object exists', async () => {
    const { store, sendMock } = createStore();
    sendMock.mockResolvedValueOnce({ ContentLength: 42, ContentType: 'text/plain' });

    await expect(store.headObject('runs/output.txt')).resolves.toEqual({
      sizeBytes: 42,
      contentType: 'text/plain',
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(getSentCommand(sendMock, 0)).toEqual({
      name: 'HeadObjectCommand',
      input: {
        Bucket: 'artifacts',
        Key: 'runs/output.txt',
      },
    });
  });

  it('headObject returns null when the object does not exist', async () => {
    const { store, sendMock } = createStore();
    sendMock.mockRejectedValueOnce(createAwsError('NotFound'));

    await expect(store.headObject('runs/output.txt')).resolves.toBeNull();
  });
});

function createStore() {
  const sendMock = vi.fn();
  const client = { send: sendMock };
  const getSignedUrlFn = vi.fn(async () => 'https://minio:9000/signed-url');

  return {
    client,
    sendMock,
    getSignedUrlFn,
    store: new ArtifactStore({
      s3Endpoint: 'http://minio:9000',
      s3Region: 'us-east-1',
      s3AccessKey: 'minio',
      s3SecretKey: 'minio123',
      bucket: 'artifacts',
      client,
      getSignedUrlFn,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }),
  };
}

function getSentCommand(sendMock: ReturnType<typeof vi.fn>, index: number) {
  const call = sendMock.mock.calls[index];

  if (!call) {
    throw new Error(`Expected send call ${index}`);
  }

  const command = call[0];

  return {
    name: getCommandName(command),
    input: getCommandInput(command),
  };
}

function getSignedCommand(getSignedUrlFn: ReturnType<typeof vi.fn>, index: number) {
  const call = getSignedUrlFn.mock.calls[index];

  if (!call) {
    throw new Error(`Expected signed URL call ${index}`);
  }

  return {
    name: getCommandName(call[1]),
    input: getCommandInput(call[1]),
    expiresIn: getExpiresIn(call[2]),
  };
}

function getSignedCallClient(getSignedUrlFn: ReturnType<typeof vi.fn>, index: number): unknown {
  const call = getSignedUrlFn.mock.calls[index];

  if (!call) {
    throw new Error(`Expected signed URL call ${index}`);
  }

  return call[0];
}

function getCommandName(command: unknown): string {
  if (typeof command !== 'object' || command === null || !('constructor' in command)) {
    throw new Error('Expected command object');
  }

  if (typeof command.constructor !== 'function' || command.constructor.name.length === 0) {
    throw new Error('Expected command constructor name');
  }

  return command.constructor.name;
}

function getCommandInput(command: unknown): unknown {
  if (typeof command !== 'object' || command === null || !('input' in command)) {
    throw new Error('Expected command input');
  }

  return command.input;
}

function getExpiresIn(options: unknown): number {
  if (typeof options !== 'object' || options === null || !('expiresIn' in options)) {
    throw new Error('Expected expiresIn option');
  }

  if (typeof options.expiresIn !== 'number') {
    throw new Error('Expected expiresIn to be a number');
  }

  return options.expiresIn;
}

function createAwsError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
