/**
 * BullMQ client for the homescout queues. Both runtimes use it:
 *   - apps/api (webhook routes) construct one to ENQUEUE only (no processor).
 *   - apps/processor constructs one to CONSUME (registers processors).
 *
 * Adapted from doxus-web packages/backend-core/.../queue-client.ts, simplified:
 *   - A small per-name Queue/Worker map (homescout has three queues).
 *   - No Sentry wrapQueue / wrapBullMQProcessor (homescout has no Sentry).
 *   - No scheduled-job registration (homescout has no recurring jobs in M4).
 *
 * The lazy singleton (`getQueueClient`) is created on first enqueue/register so
 * importing a route module in a unit test does NOT require a live Redis; tests
 * swap it via `_setQueueClientForTesting` with an in-memory enqueue spy.
 */
import {
  Queue,
  Worker,
  type ConnectionOptions,
  type Job as BullMQJob,
  type WorkerOptions,
} from "bullmq";
import {
  QUEUE_NAMES,
  RETRY_POLICIES,
  type JobPayloadByType,
  type QueueName,
} from "./queue-config.js";
import { getRedisConnection } from "./redis-connection.js";

export type JobHandler<T = unknown> = (job: BullMQJob<T>) => Promise<void>;

/**
 * BullMQ rejects `:` in custom jobIds AND in queue names (its internal Redis
 * key delimiter). Our logical names/keys (`outreach:inbound`,
 * `resend:inbound:<id>`) are mapped before crossing the BullMQ boundary.
 * Sanitisation lives ONLY here — persisted application data
 * (ListingSourceRecord.externalId, EmailEvent.providerEventId) keeps the
 * original logical id with the colons.
 */
export function sanitizeJobId(idempotencyKey: string): string {
  return idempotencyKey.replaceAll(":", "__");
}

/** Map a logical queue name (`outreach:inbound`) to a BullMQ-safe name. */
export function bullmqQueueName(name: QueueName): string {
  return name.replaceAll(":", "__");
}

export interface EnqueueInput<T> {
  idempotencyKey: string;
  payload: T;
}

export interface QueueClient {
  enqueue<N extends QueueName>(
    name: N,
    input: EnqueueInput<JobPayloadByType[N]>,
  ): Promise<void>;
  registerProcessor<N extends QueueName>(
    name: N,
    handler: JobHandler<JobPayloadByType[N]>,
    workerOptions?: Partial<WorkerOptions>,
  ): void;
  getQueueDepth(name: QueueName): Promise<number>;
  close(force?: boolean): Promise<void>;
}

export class BullMQQueueClient implements QueueClient {
  private readonly connection: ConnectionOptions;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Map<QueueName, Worker>();

  constructor(connection?: ConnectionOptions) {
    this.connection = connection ?? getRedisConnection();
  }

  private getQueue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(bullmqQueueName(name), { connection: this.connection });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Idempotent enqueue: BullMQ dedupes on jobId, so a redelivered webhook (same
   * idempotencyKey) is a no-op — the job already exists. attempts/backoff come
   * from the per-queue RETRY_POLICIES.
   */
  async enqueue<N extends QueueName>(
    name: N,
    input: EnqueueInput<JobPayloadByType[N]>,
  ): Promise<void> {
    const policy = RETRY_POLICIES[name];
    await this.getQueue(name).add(name, input.payload as object, {
      attempts: policy.attempts,
      ...(policy.backoff ? { backoff: policy.backoff } : {}),
      jobId: sanitizeJobId(input.idempotencyKey),
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    });
  }

  registerProcessor<N extends QueueName>(
    name: N,
    handler: JobHandler<JobPayloadByType[N]>,
    workerOptions?: Partial<WorkerOptions>,
  ): void {
    if (this.workers.has(name)) {
      throw new Error(`Processor already registered for queue: ${name}`);
    }
    const worker = new Worker(
      bullmqQueueName(name),
      async (job) => handler(job as BullMQJob<JobPayloadByType[N]>),
      { concurrency: 4, ...workerOptions, connection: this.connection },
    );
    worker.on("error", (error) => {
      console.error(
        JSON.stringify({
          type: "error",
          scope: "bullmq.worker.error",
          queue: name,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    worker.on("failed", (job, error) => {
      console.error(
        JSON.stringify({
          type: "error",
          scope: "bullmq.job.failed",
          queue: name,
          jobId: job?.id ?? null,
          attemptsMade: job?.attemptsMade ?? null,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    this.workers.set(name, worker);
  }

  async getQueueDepth(name: QueueName): Promise<number> {
    const counts = await this.getQueue(name).getJobCounts();
    return (counts.waiting ?? 0) + (counts.active ?? 0);
  }

  async close(force = false): Promise<void> {
    await Promise.all(
      Array.from(this.workers.values()).map((w) => w.close(force)),
    );
    this.workers.clear();
    await Promise.all(Array.from(this.queues.values()).map((q) => q.close()));
    this.queues.clear();
  }
}

// Lazy singleton — created on first enqueue/register so a unit test importing a
// route does not need a live Redis at module load.
let singleton: QueueClient | null = null;

export function getQueueClient(): QueueClient {
  if (!singleton) {
    singleton = new BullMQQueueClient();
  }
  return singleton;
}

/** Test seam — inject a fake client (e.g. an in-memory enqueue spy). */
export function _setQueueClientForTesting(client: QueueClient | null): void {
  singleton = client;
}

// ── Thin enqueue helpers (so routes never import bullmq types directly) ──────

export async function enqueueInboundEmail(
  input: EnqueueInput<JobPayloadByType["outreach:inbound"]>,
): Promise<void> {
  await getQueueClient().enqueue(QUEUE_NAMES.inbound, input);
}

export async function enqueueResendEvent(
  input: EnqueueInput<JobPayloadByType["resend:event"]>,
): Promise<void> {
  await getQueueClient().enqueue(QUEUE_NAMES.event, input);
}

export async function enqueueAnalyzeListing(
  input: EnqueueInput<JobPayloadByType["analyze:listing"]>,
): Promise<void> {
  await getQueueClient().enqueue(QUEUE_NAMES.analyze, input);
}
