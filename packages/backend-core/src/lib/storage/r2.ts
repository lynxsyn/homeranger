import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Cloudflare R2 attachment storage for the M4 inbound-ingestion pipeline.
 *
 * R2 speaks the S3 API, so we use `@aws-sdk/client-s3` exactly like Doxus's
 * `R2StorageService` (doxus-web `packages/backend-core/src/services/storage.service.ts`):
 * a single `S3Client` configured with `region: "auto"` against the
 * account-scoped R2 endpoint. Unlike Doxus we own NO Prisma in this module —
 * attachments are write-once blobs keyed by their R2 object key, and the
 * Listing/ListingSourceRecord rows are written by the repository layer. This is
 * a thin storage primitive: `putAttachment(buffer, key, contentType)` ->
 * `{ key, url, etag, contentType }`. The inbound worker decodes each Resend
 * attachment to a `Buffer`, stores it here, and passes the resulting key (and,
 * for Claude native blocks, the in-memory buffer) to the extraction provider.
 *
 * DI pattern (backend.md): interface + `DefaultR2Storage` + `deps.client ??
 * defaultClient` + singleton export, no top-level side effects. Config is read
 * lazily from env so unit tests can inject a fake S3 client without R2 creds.
 */

export interface R2Config {
  /** Account-scoped S3 endpoint, e.g. https://<acct>.eu.r2.cloudflarestorage.com */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Bucket for inbound attachments (default homescout-attachments). */
  bucket: string;
}

export interface PutAttachmentInput {
  /** Decoded attachment bytes (Resend delivers attachments base64-encoded). */
  body: Buffer;
  /** Fully-qualified object key, e.g. `inbound/<MessageId>/<filename>`. */
  key: string;
  /** MIME type recorded as the object's Content-Type. */
  contentType: string;
}

export interface StoredAttachment {
  /** R2 object key (stable handle the worker persists / re-reads). */
  key: string;
  /**
   * Canonical `r2://<bucket>/<key>` URL. R2 buckets are private by design — a
   * presigned GET is minted on demand (see `getAttachmentBuffer`) rather than
   * exposing a public URL. The `r2://` scheme is the durable reference stored
   * alongside the Listing/attachment metadata.
   */
  url: string;
  contentType: string;
  etag?: string;
}

export interface R2Storage {
  putAttachment(input: PutAttachmentInput): Promise<StoredAttachment>;
  getAttachmentBuffer(key: string): Promise<Buffer>;
  deleteAttachment(key: string): Promise<void>;
}

export interface R2StorageDeps {
  client?: S3Client;
  config?: R2Config;
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function requireEnv(displayName: string, ...names: string[]): string {
  const value = firstEnv(...names);
  if (!value) {
    throw new Error(`${displayName} environment variable is required`);
  }
  return value;
}

export function getR2Config(): R2Config {
  return {
    endpoint: requireEnv("R2_ENDPOINT", "R2_ENDPOINT", "R2_S3_ENDPOINT"),
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY"),
    bucket: firstEnv("R2_BUCKET", "R2_BUCKET_NAME") ?? "homescout-attachments",
  };
}

/**
 * Build the S3 client for R2. `region: "auto"` is required for R2; path-style
 * addressing is NOT needed because the account-scoped endpoint already encodes
 * the account, and the bucket is passed per-command (Doxus relies on the same
 * default virtual-host addressing).
 */
export function createR2Client(config: R2Config = getR2Config()): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export class DefaultR2Storage implements R2Storage {
  private readonly client: S3Client;
  private readonly config: R2Config;

  constructor(deps: R2StorageDeps = {}) {
    this.config = deps.config ?? getR2Config();
    this.client = deps.client ?? createR2Client(this.config);
  }

  async putAttachment(input: PutAttachmentInput): Promise<StoredAttachment> {
    const putInput: PutObjectCommandInput = {
      Bucket: this.config.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ContentLength: input.body.byteLength,
    };

    const response = await this.client.send(new PutObjectCommand(putInput));

    return {
      key: input.key,
      url: `r2://${this.config.bucket}/${input.key}`,
      contentType: input.contentType,
      etag: response.ETag ?? undefined,
    };
  }

  async getAttachmentBuffer(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );

    if (!response.Body) {
      throw new Error(`R2 object ${key} has empty body`);
    }

    // `transformToByteArray` is provided by the SDK's streaming body mixin in
    // Node — returns the whole object as a Uint8Array we wrap in a Buffer.
    const bytes = await (
      response.Body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();

    return Buffer.from(bytes);
  }

  async deleteAttachment(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }
}

let singleton: R2Storage | undefined;

/** Lazy singleton (mirrors Doxus `createR2StorageService` + service singletons). */
export function getR2Storage(deps?: R2StorageDeps): R2Storage {
  if (deps) {
    return new DefaultR2Storage(deps);
  }
  if (!singleton) {
    singleton = new DefaultR2Storage();
  }
  return singleton;
}

/**
 * Deterministic key for an inbound attachment. Scoped by Resend `MessageId`
 * (the idempotency anchor for the whole inbound job) so re-ingest overwrites
 * rather than orphaning blobs. The filename is sanitised to avoid path
 * traversal / control chars in the key (mirrors Doxus `object-key.ts`).
 */
export function buildAttachmentKey(messageId: string, fileName: string): string {
  const safeMessageId = messageId.replace(/[^A-Za-z0-9._@-]/g, "_");
  const safeFileName =
    fileName
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 200) || "attachment";
  return `inbound/${safeMessageId}/${safeFileName}`;
}
