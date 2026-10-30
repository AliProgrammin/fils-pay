import { randomInt, randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { createSeededRng } from "./rng.js";
import type {
  AcquirerAuthorizeRequest,
  AcquirerAuthorizeResult,
  AcquirerCaptureRequest,
  AcquirerCaptureResult,
  AcquirerOutcome,
  AcquirerRefundRequest,
  AcquirerRefundResult,
  AcquirerSimulator,
} from "./types.js";

const DECLINE_REASONS = ["do_not_honor", "insufficient_funds", "card_expired", "suspected_fraud"];

interface RandomSource {
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
}

/** Crypto-backed randomness, used when no deterministic seed is configured. */
function cryptoRandomSource(): RandomSource {
  return {
    int(min, max) {
      return randomInt(min, max + 1);
    },
    chance(probability) {
      const resolution = 1_000_000;
      const clamped = Math.max(0, Math.min(1, probability));
      return randomInt(0, resolution) < Math.round(clamped * resolution);
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError("cryptoRandomSource.pick: items must not be empty");
      }
      const idx = randomInt(0, items.length);
      return items[idx] as T;
    },
  };
}

/** Seeded, reproducible randomness — used when `config.acquirerRngSeed` is
 *  set, so a fixed seed plus a fixed sequence of calls reproduces
 *  byte-identical latency/outcome sequences. */
function seededRandomSource(seed: number): RandomSource {
  const rng = createSeededRng(seed);
  return {
    int(min, max) {
      return rng.int(min, max);
    },
    chance(probability) {
      return rng.next() < probability;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError("seededRandomSource.pick: items must not be empty");
      }
      const idx = Math.floor(rng.next() * items.length);
      return items[Math.min(idx, items.length - 1)] as T;
    },
  };
}

const CACHE_MAX_ENTRIES = 50_000;

/** Map with a size cap; Map keeps insertion order, so the first key is the oldest. */
class BoundedCache<T> {
  private readonly map = new Map<string, T>();
  constructor(private readonly maxEntries: number) {}
  get(key: string): T | undefined {
    return this.map.get(key);
  }
  set(key: string, value: T): void {
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value as string);
    }
  }
}

/**
 * Only the simulator knobs from Config.
 * — MK
 */
type SimulatorConfig = Pick<
  Config,
  "acquirerLatencyMinMs" | "acquirerLatencyMaxMs" | "acquirerFailureRate" | "acquirerRngSeed"
>;

/**
 * In-process simulated acquirer. Lives in `apps/api` rather than a separate
 * service: the load test only needs observable HTTP-boundary latency, which
 * an in-process `await sleep(ms)` produces identically to an out-of-process
 * call, at zero extra RAM/CPU cost — a meaningful saving under the 0.5 vCPU
 * / 512 MB budget for the whole platform.
 */
export function createAcquirerSimulator(config: SimulatorConfig): AcquirerSimulator {
  const random = config.acquirerRngSeed !== null ? seededRandomSource(config.acquirerRngSeed) : cryptoRandomSource();

  // In-process idempotency caches, one per operation. A retried call with
  // the same idempotency key returns the cached result unchanged rather
  // than re-rolling latency/outcome, so a client retry after a timeout
  // gets a consistent acquirer response. In-memory and process-local: a
  // deliberate fit for this platform's single small container target, not
  // durable across a process restart or multiple replicas.
  // Bounded (oldest entry dropped first): a client retry comes seconds after
  // the first call, and an unbounded map grows with every payment until the
  // 512 MB API container runs out of memory.
  const authorizeCache = new BoundedCache<AcquirerAuthorizeResult>(CACHE_MAX_ENTRIES);
  const captureCache = new BoundedCache<AcquirerCaptureResult>(CACHE_MAX_ENTRIES);
  const refundCache = new BoundedCache<AcquirerRefundResult>(CACHE_MAX_ENTRIES);

  async function applyLatency(): Promise<number> {
    const ms = random.int(config.acquirerLatencyMinMs, config.acquirerLatencyMaxMs);
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return ms;
  }

  function rollOutcome(): { outcome: AcquirerOutcome; declineReason?: string } {
    if (!random.chance(config.acquirerFailureRate)) {
      return { outcome: "approved" };
    }
    if (random.chance(0.7)) {
      return { outcome: "declined", declineReason: random.pick(DECLINE_REASONS) };
    }
    return { outcome: "error" };
  }

  /** A card is valid through the last day of its expiry month, judged on
   *  the Asia/Bahrain calendar and the server's clock. A 2-digit year means
   *  20YY. Input with no integer month 1-12 or no integer year is not judged
   *  (never declined as expired), so every shape the API accepts keeps its
   *  outcome. */
  function isExpired(card: AcquirerAuthorizeRequest["card"]): boolean {
    const { expiryMonth, expiryYear } = card;
    if (!Number.isInteger(expiryMonth) || expiryMonth < 1 || expiryMonth > 12) return false;
    if (!Number.isInteger(expiryYear) || expiryYear < 0) return false;
    const year = expiryYear < 100 ? 2000 + expiryYear : expiryYear;
    const bahrainNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const currentMonthIndex = bahrainNow.getUTCFullYear() * 12 + bahrainNow.getUTCMonth();
    return year * 12 + (expiryMonth - 1) < currentMonthIndex;
  }

  function magicOutcomeForPan(pan: string): { outcome: AcquirerOutcome; declineReason?: string } | null {
    if (pan.endsWith("0002")) return { outcome: "declined", declineReason: "do_not_honor" };
    if (pan.endsWith("0119")) return { outcome: "declined", declineReason: "insufficient_funds" };
    if (pan.endsWith("0069")) return { outcome: "error" };
    return null;
  }

  return {
    async authorize(req: AcquirerAuthorizeRequest): Promise<AcquirerAuthorizeResult> {
      const cached = authorizeCache.get(req.idempotencyKey);
      if (cached) return cached;

      // Deterministic magic test cards are checked first, then an expired
      // card, both independent of the failure-rate roll.
      const rolled: { outcome: AcquirerOutcome; declineReason?: string } =
        magicOutcomeForPan(req.card.pan) ??
        (isExpired(req.card) ? { outcome: "declined", declineReason: "card_expired" } : rollOutcome());
      const latencyMs = await applyLatency();

      const result: AcquirerAuthorizeResult = {
        outcome: rolled.outcome,
        acquirerReference: `acq_${randomUUID()}`,
        ...(rolled.declineReason !== undefined ? { declineReason: rolled.declineReason } : {}),
        latencyMs,
      };
      authorizeCache.set(req.idempotencyKey, result);
      return result;
    },

    async capture(req: AcquirerCaptureRequest): Promise<AcquirerCaptureResult> {
      const cached = captureCache.get(req.idempotencyKey);
      if (cached) return cached;

      const rolled = rollOutcome();
      const latencyMs = await applyLatency();

      const result: AcquirerCaptureResult = {
        outcome: rolled.outcome,
        acquirerReference: req.acquirerReference,
        latencyMs,
      };
      captureCache.set(req.idempotencyKey, result);
      return result;
    },

    async refund(req: AcquirerRefundRequest): Promise<AcquirerRefundResult> {
      const cached = refundCache.get(req.idempotencyKey);
      if (cached) return cached;

      const rolled = rollOutcome();
      const latencyMs = await applyLatency();

      const result: AcquirerRefundResult = {
        outcome: rolled.outcome,
        acquirerReference: req.acquirerReference,
        latencyMs,
      };
      refundCache.set(req.idempotencyKey, result);
      return result;
    },
  };
}
