/**
 * WarmupState repository — owns ALL Prisma access for the single-row
 * warm-up/send-governance state (daily cap ramp + manual kill-switch). M2
 * authored the MODEL; M6 needs the repository because the ComplianceGuard reads
 * the kill-switch (gate 5) + the daily cap (gate 6) and the warmup:recalc job
 * ramps the cap + reconciles sentToday.
 *
 * Single-row: there is no unique constraint forcing one row, so getOrCreate
 * lazily inserts the canonical row on first read (oldest-by-createdAt wins if a
 * race ever produced two). Mirrors homescout repository conventions exactly
 * (validator-select + optional-tx + singleton + _setForTesting).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

const WARMUP_SELECT = Prisma.validator<Prisma.WarmupStateSelect>()({
  id: true,
  dailyCap: true,
  sentToday: true,
  windowDate: true,
  killSwitch: true,
  rampStartedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type WarmupStateRecord = Prisma.WarmupStateGetPayload<{
  select: typeof WARMUP_SELECT;
}>;

/** Midnight-UTC for a Date — the @db.Date window key (time component ignored). */
function utcDateOnly(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}

export class WarmupStateRepository {
  /** The single warm-up row, lazily created with safe defaults on first read. */
  async getOrCreate(tx?: Prisma.TransactionClient): Promise<WarmupStateRecord> {
    const db: PrismaLike = tx ?? prisma;
    const existing = await db.warmupState.findFirst({
      select: WARMUP_SELECT,
      orderBy: { createdAt: "asc" },
    });
    if (existing) {
      return existing;
    }
    return db.warmupState.create({
      data: { windowDate: utcDateOnly(new Date()) },
      select: WARMUP_SELECT,
    });
  }

  /** Set the manual kill-switch (M7 toggles this; AC#6). Idempotent. */
  async setKillSwitch(
    value: boolean,
    tx?: Prisma.TransactionClient,
  ): Promise<WarmupStateRecord> {
    const db: PrismaLike = tx ?? prisma;
    const row = await this.getOrCreate(tx);
    return db.warmupState.update({
      where: { id: row.id },
      data: { killSwitch: value },
      select: WARMUP_SELECT,
    });
  }

  /** Ramp the daily cap (warmup:recalc). Idempotent on the value. */
  async setDailyCap(
    cap: number,
    tx?: Prisma.TransactionClient,
  ): Promise<WarmupStateRecord> {
    const db: PrismaLike = tx ?? prisma;
    const row = await this.getOrCreate(tx);
    return db.warmupState.update({
      where: { id: row.id },
      data: { dailyCap: cap },
      select: WARMUP_SELECT,
    });
  }

  /**
   * Reconcile the displayed window counter from durable state (warmup:recalc):
   * sets windowDate + the actual sentToday so transient token-bucket consume
   * drift self-heals daily rather than accumulating.
   */
  async reconcileWindow(
    input: { windowDate: Date; sentToday: number },
    tx?: Prisma.TransactionClient,
  ): Promise<WarmupStateRecord> {
    const db: PrismaLike = tx ?? prisma;
    const row = await this.getOrCreate(tx);
    return db.warmupState.update({
      where: { id: row.id },
      data: {
        windowDate: utcDateOnly(input.windowDate),
        sentToday: input.sentToday,
      },
      select: WARMUP_SELECT,
    });
  }
}

const defaultWarmupStateRepository = new WarmupStateRepository();

export let warmupStateRepository = defaultWarmupStateRepository;

export function _setWarmupStateRepositoryForTesting(
  repository: WarmupStateRepository | null,
): void {
  warmupStateRepository = repository ?? defaultWarmupStateRepository;
}
