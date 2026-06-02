/**
 * Warm-up recalc (M6 AC#3) — the scheduler-driven daily ramp. Raises the send
 * cap gradually as the sending domain ages, and reconciles `sentToday` from
 * DURABLE state (actual outbound count for the day) so transient token-bucket
 * consume drift self-heals daily rather than accumulating (DD2 / review fix).
 * The breaker rates are computed live by the ComplianceGuard per send (gate 4);
 * this job owns only the cap ramp + the window counter the M7 dashboard reads.
 *
 * Variant-A module singleton (all deps default to prod repositories).
 */
import {
  warmupStateRepository as defaultWarmupStateRepository,
  type WarmupStateRepository,
} from "../repositories/warmup-state.repository.js";
import {
  outreachRepository as defaultOutreachRepository,
  type OutreachRepository,
} from "../repositories/outreach.repository.js";

export interface WarmupRecalcResult {
  dailyCap: number;
  sentToday: number;
}

export interface WarmupService {
  recalc(): Promise<WarmupRecalcResult>;
}

export interface WarmupConfig {
  /** Cap on day 0. */
  baseCap: number;
  /** Cap increase per full day since ramp start. */
  step: number;
  /** Hard ceiling the ramp never exceeds. */
  maxCap: number;
}

export function getWarmupConfig(): WarmupConfig {
  const intEnv = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    baseCap: intEnv("WARMUP_BASE_CAP", 20),
    step: intEnv("WARMUP_STEP", 20),
    maxCap: intEnv("WARMUP_MAX_CAP", 200),
  };
}

function utcStartOfDay(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}

export interface WarmupServiceDependencies {
  warmupStateRepository?: WarmupStateRepository;
  outreachRepository?: OutreachRepository;
  config?: WarmupConfig;
  now?: () => Date;
}

export class DefaultWarmupService implements WarmupService {
  private readonly warmupStateRepository: WarmupStateRepository;
  private readonly outreachRepository: OutreachRepository;
  private readonly config: WarmupConfig;
  private readonly now: () => Date;

  constructor(deps: WarmupServiceDependencies = {}) {
    this.warmupStateRepository =
      deps.warmupStateRepository ?? defaultWarmupStateRepository;
    this.outreachRepository =
      deps.outreachRepository ?? defaultOutreachRepository;
    this.config = deps.config ?? getWarmupConfig();
    this.now = deps.now ?? (() => new Date());
  }

  async recalc(): Promise<WarmupRecalcResult> {
    const state = await this.warmupStateRepository.getOrCreate();
    const now = this.now();
    const daysSinceStart = Math.max(
      0,
      Math.floor((now.getTime() - state.rampStartedAt.getTime()) / 86_400_000),
    );
    const dailyCap = Math.min(
      this.config.maxCap,
      this.config.baseCap + daysSinceStart * this.config.step,
    );
    const sentToday = await this.outreachRepository.countOutboundSince(
      utcStartOfDay(now),
    );

    if (dailyCap !== state.dailyCap) {
      await this.warmupStateRepository.setDailyCap(dailyCap);
    }
    await this.warmupStateRepository.reconcileWindow({ windowDate: now, sentToday });

    console.info(
      JSON.stringify({
        type: "info",
        scope: "warmup.recalc",
        dailyCap,
        sentToday,
        daysSinceStart,
      }),
    );
    return { dailyCap, sentToday };
  }
}

const defaultWarmupService = new DefaultWarmupService();

export let warmupService: WarmupService = defaultWarmupService;

export function _setWarmupServiceForTesting(
  service: WarmupService | null,
): void {
  warmupService = service ?? defaultWarmupService;
}
