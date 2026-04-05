import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ArtifactStoreDeps {
  s3Endpoint: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  bucket: string;
  s3PublicEndpoint?: string;
  logger?: Logger;
  client?: ArtifactStoreClient;
  getSignedUrlFn?: ArtifactStoreSignedUrlFn;
}

interface TransformableBody {
  transformToByteArray(): Promise<Uint8Array>;
}

interface GetObjectResponse {
  Body?: unknown;
  ContentType?: string;
}

interface HeadObjectResponse {
  ContentLength?: number;
  ContentType?: string;
}

interface ArtifactStoreClient {
  send(command: HeadBucketCommand): Promise<unknown>;
  send(command: CreateBucketCommand): Promise<unknown>;
  send(command: PutObjectCommand): Promise<unknown>;
  send(command: GetObjectCommand): Promise<GetObjectResponse>;
  send(command: DeleteObjectCommand): Promise<unknown>;
  send(command: HeadObjectCommand): Promise<HeadObjectResponse>;
}

type ArtifactStoreSignedUrlFn = (
  client: ArtifactStoreClient,
  command: GetObjectCommand | PutObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const MISSING_BUCKET_ERROR_NAMES = new Set(['NotFound', 'NoSuchBucket']);
const BUCKET_EXISTS_ERROR_NAMES = new Set(['BucketAlreadyOwnedByYou', 'BucketAlreadyExists']);
const MISSING_OBJECT_ERROR_NAMES = new Set(['NotFound', 'NoSuchKey']);

/**
 * HTTP status codes that indicate a bucket does not exist or is inaccessible.
 * MinIO returns 403 Forbidden (often as UnknownError) for non-existent buckets
 * instead of 404 NotFound like AWS S3.
 */
const MISSING_BUCKET_HTTP_STATUS_CODES = new Set([403, 404]);

export class ArtifactStore {
  private readonly client: ArtifactStoreClient;
  private readonly signingClient: ArtifactStoreClient;
  private readonly bucket: string;
  private readonly getSignedUrlFn: ArtifactStoreSignedUrlFn;
  private readonly logger: Logger;

  constructor(deps: ArtifactStoreDeps) {
    this.bucket = deps.bucket;
    this.getSignedUrlFn = deps.getSignedUrlFn ?? defaultGetSignedUrl;
    this.logger = deps.logger ?? console;
    this.client =
      deps.client ??
      new S3Client({
        endpoint: deps.s3Endpoint,
        region: deps.s3Region,
        credentials: {
          accessKeyId: deps.s3AccessKey,
          secretAccessKey: deps.s3SecretKey,
        },
        forcePathStyle: true,
      });
    this.signingClient =
      deps.s3PublicEndpoint && deps.s3PublicEndpoint !== deps.s3Endpoint
        ? new S3Client({
            endpoint: deps.s3PublicEndpoint,
            region: deps.s3Region,
            credentials: {
              accessKeyId: deps.s3AccessKey,
              secretAccessKey: deps.s3SecretKey,
            },
            forcePathStyle: true,
          })
        : this.client;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      if (!isMissingBucketError(error)) {
        throw error;
      }
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.info('Created artifact bucket', this.bucket);
    } catch (error) {
      if (hasErrorName(error, BUCKET_EXISTS_ERROR_NAMES)) {
        this.logger.info('Artifact bucket already exists', this.bucket);
        return;
      }

      throw error;
    }
  }

  async upload(key: string, body: Buffer | Uint8Array | Readable, contentType: string, contentLength?: number): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(contentLength !== undefined && { ContentLength: contentLength }),
      }),
    );
  }

  getBucket(): string {
    return this.bucket;
  }

  async download(key: string): Promise<{ body: Buffer; contentType: string }> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    if (!isTransformableBody(response.Body)) {
      throw new Error(`Artifact object ${key} returned no readable body`);
    }

    const bytes = await response.Body.transformToByteArray();

    return {
      body: Buffer.from(bytes),
      contentType: response.ContentType ?? DEFAULT_CONTENT_TYPE,
    };
  }

  async getSignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    return this.getSignedUrlFn(
      this.signingClient,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
      { expiresIn },
    );
  }

  async getSignedUploadUrl(key: string, contentType: string, expiresIn = 3600): Promise<string> {
    return this.getSignedUrlFn(
      this.signingClient,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn },
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async headObject(key: string): Promise<{ sizeBytes: number; contentType: string } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      return {
        sizeBytes: response.ContentLength ?? 0,
        contentType: response.ContentType ?? DEFAULT_CONTENT_TYPE,
      };
    } catch (error) {
      if (hasErrorName(error, MISSING_OBJECT_ERROR_NAMES)) {
        return null;
      }

      throw error;
    }
  }
}

const defaultGetSignedUrl: ArtifactStoreSignedUrlFn = async (client, command, options) => {
  if (!(client instanceof S3Client)) {
    throw new Error('Signed URL generation requires an S3Client instance');
  }

  return getSignedUrl(client, command, options);
};

function isMissingBucketError(error: unknown): boolean {
  if (hasErrorName(error, MISSING_BUCKET_ERROR_NAMES)) {
    return true;
  }

  const httpStatus = getErrorHttpStatus(error);
  return httpStatus !== undefined && MISSING_BUCKET_HTTP_STATUS_CODES.has(httpStatus);
}

function getErrorHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) {
    return undefined;
  }

  const metadata = (error as { $metadata: unknown }).$metadata;

  if (typeof metadata !== 'object' || metadata === null || !('httpStatusCode' in metadata)) {
    return undefined;
  }

  const code = (metadata as { httpStatusCode: unknown }).httpStatusCode;
  return typeof code === 'number' ? code : undefined;
}

function hasErrorName(error: unknown, names: ReadonlySet<string>): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false;
  }

  return typeof error.name === 'string' && names.has(error.name);
}

function isTransformableBody(body: unknown): body is TransformableBody {
  if (typeof body !== 'object' || body === null || !('transformToByteArray' in body)) {
    return false;
  }

  return typeof body.transformToByteArray === 'function';
}
