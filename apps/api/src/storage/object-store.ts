/**
 * Off-chain object storage.
 *
 * Resumes, invoices, identity evidence and deliverables live here - never on a
 * ledger. A ledger only ever receives the canonical SHA-256 commitment of the
 * bytes. Storage keys are opaque and are never sent to a blockchain, a log line
 * or an AI trace.
 *
 * MinIO locally; any S3-compatible service when hosted; an in-memory store for
 * the offline demo and the tests.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ApiConfig } from '../config.js';
import { notFound } from '../errors.js';
import { sha256Bytes } from '../runtime.js';

export interface StoredObject {
  readonly bucket: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

export interface ObjectStore {
  readonly mode: 's3' | 'memory';
  put(objectKey: string, body: Uint8Array, contentType: string): Promise<StoredObject>;
  signedDownloadUrl(objectKey: string, ttlSeconds: number, now: Date): Promise<SignedUrl>;
  get(objectKey: string): Promise<Uint8Array>;
}

/** Bytes never leave the process; the signed URL is a scoped, expiring token. */
export class MemoryObjectStore implements ObjectStore {
  readonly mode = 'memory' as const;
  readonly #objects = new Map<string, { body: Uint8Array; contentType: string }>();

  constructor(private readonly bucket: string) {}

  async put(objectKey: string, body: Uint8Array, contentType: string): Promise<StoredObject> {
    this.#objects.set(objectKey, { body: Uint8Array.from(body), contentType });
    return {
      bucket: this.bucket,
      objectKey,
      contentType,
      byteLength: body.byteLength,
      sha256: sha256Bytes(body),
    };
  }

  async signedDownloadUrl(objectKey: string, ttlSeconds: number, now: Date): Promise<SignedUrl> {
    if (!this.#objects.has(objectKey)) throw notFound(`No stored object for key ${objectKey}.`);
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
    // The memory profile URL is only a demonstration handle. Hash the scoped
    // input so even a curious client cannot decode the internal object key.
    const token = sha256Bytes(Buffer.from(`${objectKey} ${expiresAt.toISOString()}`, 'utf8')).slice(7);
    return {
      url: `/v1/objects/${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds,
    };
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const found = this.#objects.get(objectKey);
    if (!found) throw notFound(`No stored object for key ${objectKey}.`);
    return found.body;
  }
}

export class S3ObjectStore implements ObjectStore {
  readonly mode = 's3' as const;
  readonly #client: S3Client;

  constructor(private readonly config: ApiConfig['storage']) {
    this.#client = new S3Client({
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint, forcePathStyle: true }),
      ...(config.accessKeyId && config.secretAccessKey
        ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
        : {}),
    });
  }

  async put(objectKey: string, body: Uint8Array, contentType: string): Promise<StoredObject> {
    await this.#client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }));
    return {
      bucket: this.config.bucket,
      objectKey,
      contentType,
      byteLength: body.byteLength,
      sha256: sha256Bytes(body),
    };
  }

  async signedDownloadUrl(objectKey: string, ttlSeconds: number, now: Date): Promise<SignedUrl> {
    const url = await getSignedUrl(
      this.#client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }),
      { expiresIn: ttlSeconds },
    );
    return { url, expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(), ttlSeconds };
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const response = await this.#client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) throw notFound(`No stored object for key ${objectKey}.`);
    return bytes;
  }
}

export function createObjectStore(config: ApiConfig['storage']): ObjectStore {
  return config.mode === 's3' ? new S3ObjectStore(config) : new MemoryObjectStore(config.bucket);
}

/**
 * Object keys are derived from opaque identifiers only. No name, email, company
 * or file title ever appears in a key, because keys end up in access logs.
 */
export function objectKeyFor(classification: string, ownerOrganizationId: string, objectId: string): string {
  return `${classification.toLowerCase()}/${ownerOrganizationId}/${objectId}`;
}

/** Accepted deliverable and document types, checked before bytes are stored. */
export const ALLOWED_CONTENT_TYPES: readonly string[] = [
  'application/pdf',
  'application/zip',
  'application/json',
  'image/png',
  'image/jpeg',
  'text/csv',
  'text/markdown',
  'text/plain',
];

export const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
