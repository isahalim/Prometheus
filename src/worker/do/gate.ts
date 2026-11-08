/**
 * Gate — the one place in the system that calls Gemini.
 *
 * Every agent turn from every session queues here, so the account-wide limits
 * (gemini-3.5-flash-lite free tier: 15 RPM, 250K TPM, 500 RPD) are enforced
 * against one ledger rather than per session.
 *
 * Pacing is a slot schedule, not a bucket: request N may start no earlier
 * than request N-1 + 60s/RPM_TARGET. At the default target of 12 RPM that is
 * one call every 5 s, distributed evenly across the minute instead of a burst
 * of 15 followed by 45 s of 429s. A Durable Object is single-threaded between
 * awaits, so reserving the slot before the first await makes the schedule
 * race-free without locks.
 *
 * Priorities: a human's message may queue for up to HUMAN_MAX_WAIT_MS; an
 * ambient observation is only accepted when the lane is free right now and
 * the day still has more than GEMINI_RPD_USER_RESERVE requests left — so the
 * agent watching quietly can never starve the human asking for help.
 *
 * TPM is checked with an estimate before the call and settled with the real
 * `usage.total_tokens` after it. A 429 from Google (which happens if something
 * else shares the key) pushes the whole lane back by the server's retry delay.
 */
import { DurableObject } from "cloudflare:workers";
import type { BudgetStatus } from "../../shared/protocol.ts";
import { intVar, type AppEnv } from "../env.ts";

const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const HUMAN_MAX_WAIT_MS = 40_000;
const AMBIENT_MAX_WAIT_MS = 1_500;
const REQUEST_TIMEOUT_MS = 45_000;
/** Keep 10% of the token budget as headroom against estimate error. */
const TPM_SAFETY = 0.9;
const DEFAULT_COOLDOWN_MS = 20_000;

export interface GateRequest {
  priority: "human" | "ambient";
  /** Interactions request body, minus `model` (the Gate owns the model choice). */
  body: Record<string, unknown>;
  estTokens: number;
}

export type GateResult =
  | { ok: true; data: InteractionResponse; tokens: number; waitedMs: number; budget: BudgetStatus }
  | { ok: false; error: string; retryAfterMs?: number; budget: BudgetStatus };

export interface InteractionStep {
  type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  content?: { type?: string; text?: string }[];
}

export interface InteractionResponse {
  status?: string;
  steps?: InteractionStep[];
  usage?: { total_tokens?: number };
  error?: { message?: string; code?: string | number };
}

interface Ledger {
  day: string;
  usedToday: number;
  /** Start times of recent requests, and the tokens each consumed (0 until settled). */
  recent: { t: number; tokens: number }[];
  nextSlotAt: number;
  cooldownUntil: number;
}

const pacificDay = (t: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(t);

/** Next Pacific midnight — when Gemini's per-day quota resets. */
function nextPacificMidnight(now: number): number {
  const today = pacificDay(now);
  // Step forward in 15-minute increments until the Pacific date changes; at most 96 steps.
  let t = now - (now % (15 * 60 * 1000)) + 15 * 60 * 1000;
  while (pacificDay(t) === today) t += 15 * 60 * 1000;
  // Refine to the minute.
  let lo = t - 15 * 60 * 1000;
  while (t - lo > 60_000) {
    const mid = lo + Math.floor((t - lo) / 2);
    if (pacificDay(mid) === today) lo = mid;
    else t = mid;
  }
  return t;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Gate extends DurableObject<AppEnv> {
  private ledger: Ledger = { day: "", usedToday: 0, recent: [], nextSlotAt: 0, cooldownUntil: 0 };

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Ledger>("ledger");
      if (saved) this.ledger = saved;
    });
  }

  private get rpmTarget() {
    return Math.min(intVar(this.env.GEMINI_RPM_TARGET, 12), this.rpmLimit);
  }
  private get rpmLimit() {
    return intVar(this.env.GEMINI_RPM_LIMIT, 15);
  }
  private get tpmLimit() {
    return intVar(this.env.GEMINI_TPM_LIMIT, 250_000);
  }
  private get rpdLimit() {
    return intVar(this.env.GEMINI_RPD_LIMIT, 500);
  }
  private get reserve() {
    return Math.min(intVar(this.env.GEMINI_RPD_USER_RESERVE, 80), this.rpdLimit);
  }
  private get spacingMs() {
    return Math.ceil(60_000 / this.rpmTarget);
  }

  private roll(now: number) {
    const day = pacificDay(now);
    if (day !== this.ledger.day) {
      this.ledger.day = day;
      this.ledger.usedToday = 0;
    }
    this.ledger.recent = this.ledger.recent.filter((r) => now - r.t < 60_000);
  }

  private persist() {
    // Fire-and-forget is safe: DO storage writes are ordered and coalesced.
    void this.ctx.storage.put("ledger", this.ledger);
  }

  status(): BudgetStatus {
    const now = Date.now();
    this.roll(now);
    return {
      model: this.env.GEMINI_MODEL,
      rpmTarget: this.rpmTarget,
      rpmLimit: this.rpmLimit,
      usedLastMinute: this.ledger.recent.length,
      tokensLastMinute: this.ledger.recent.reduce((s, r) => s + r.tokens, 0),
      tpmLimit: this.tpmLimit,
      usedToday: this.ledger.usedToday,
      rpdLimit: this.rpdLimit,
      reserve: this.reserve,
      nextSlotInMs: Math.max(0, this.ledger.nextSlotAt - now, this.ledger.cooldownUntil - now),
      cooldownMs: Math.max(0, this.ledger.cooldownUntil - now),
      resetsAt: new Date(nextPacificMidnight(now)).toISOString(),
    };
  }

  /** Earliest time at which `est` more tokens fit inside the rolling minute. */
  private tokenSlot(now: number, est: number): number {
    const cap = this.tpmLimit * TPM_SAFETY;
    let used = this.ledger.recent.reduce((s, r) => s + Math.max(r.tokens, 1), 0);
    if (used + est <= cap) return now;
    for (const r of [...this.ledger.recent].sort((a, b) => a.t - b.t)) {
      used -= Math.max(r.tokens, 1);
      if (used + est <= cap) return r.t + 60_000;
    }
    return now + 60_000;
  }

  async generate(req: GateRequest): Promise<GateResult> {
    const now = Date.now();
    this.roll(now);
    const { ledger } = this;

    if (ledger.usedToday >= this.rpdLimit) {
      return { ok: false, error: "daily_limit", retryAfterMs: nextPacificMidnight(now) - now, budget: this.status() };
    }
    if (req.priority === "ambient" && ledger.usedToday >= this.rpdLimit - this.reserve) {
      return { ok: false, error: "ambient_paused_reserve", retryAfterMs: nextPacificMidnight(now) - now, budget: this.status() };
    }

    // The slot: evenly spaced, after any upstream cooldown, and inside TPM.
    let slot = Math.max(now, ledger.nextSlotAt, ledger.cooldownUntil);
    slot = Math.max(slot, this.tokenSlot(now, req.estTokens));
    // Hard RPM guard on top of the spacing: never more than rpmLimit starts in any 60 s window.
    if (ledger.recent.length >= this.rpmLimit) slot = Math.max(slot, ledger.recent[ledger.recent.length - this.rpmLimit].t + 60_000);

    const wait = slot - now;
    const maxWait = req.priority === "human" ? HUMAN_MAX_WAIT_MS : AMBIENT_MAX_WAIT_MS;
    if (wait > maxWait) return { ok: false, error: "busy", retryAfterMs: wait, budget: this.status() };

    // Reserve synchronously — before any await — so concurrent callers queue behind.
    ledger.nextSlotAt = slot + this.spacingMs;
    ledger.usedToday += 1;
    const entry = { t: slot, tokens: req.estTokens };
    ledger.recent.push(entry);
    this.persist();

    if (wait > 0) await sleep(wait);

    let response: Response;
    try {
      response = await fetch(INTERACTIONS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.env.GEMINI_API_KEY },
        body: JSON.stringify({ ...req.body, model: this.env.GEMINI_MODEL, store: false }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      return { ok: false, error: `network: ${cause instanceof Error ? cause.message : String(cause)}`, budget: this.status() };
    }

    const text = await response.text();
    let data: InteractionResponse & { error?: { message?: string; code?: string | number; details?: unknown[] } };
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: `bad_response: HTTP ${response.status}`, budget: this.status() };
    }

    if (response.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(data.error?.message ?? "")) {
      const delay = retryDelayMs(data) ?? DEFAULT_COOLDOWN_MS;
      ledger.cooldownUntil = Date.now() + delay;
      ledger.nextSlotAt = Math.max(ledger.nextSlotAt, ledger.cooldownUntil);
      this.persist();
      return { ok: false, error: "rate_limited_upstream", retryAfterMs: delay, budget: this.status() };
    }
    if (!response.ok || data.error) {
      return { ok: false, error: `gemini: ${data.error?.message ?? `HTTP ${response.status}`}`.slice(0, 300), budget: this.status() };
    }

    const tokens = data.usage?.total_tokens ?? req.estTokens;
    entry.tokens = tokens;
    this.persist();
    return { ok: true, data, tokens, waitedMs: wait, budget: this.status() };
  }
}

/** Reads google.rpc.RetryInfo ("12s" / "1.5s") out of an error body. */
function retryDelayMs(body: { error?: { details?: unknown[] } }): number | undefined {
  for (const detail of body.error?.details ?? []) {
    const delay = (detail as { retryDelay?: string }).retryDelay;
    if (typeof delay === "string") {
      const seconds = Number.parseFloat(delay);
      if (Number.isFinite(seconds)) return Math.ceil(seconds * 1000) + 500;
    }
  }
  return undefined;
}
