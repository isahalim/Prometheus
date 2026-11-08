/**
 * The agent's side of the pair: decides WHEN to look (cadence), builds what
 * it sees (observation), and replays what it decides (actions).
 *
 * Cadence: a human message is sent at once. Ambient turns happen only when
 * there is something new to look at — the human made strokes and has paused
 * for a beat — or, in lead mode, when the human has been idle a while. They
 * are further spaced per mode, and the server-side Gate has the final word on
 * the shared Gemini budget, so this layer only ever asks politely.
 */
import { PANEL_PX, type ActionResult, type AgentMode, type BudgetStatus, type ShapeAction, type TurnRequest, type TurnResponse } from "../../shared/protocol.ts";
import { AgentCancelled, type Studio } from "../sculpt/studio.ts";

export type LoopMode = AgentMode | "off";

/** Client-side spacing of ambient turns (the server enforces its own floor too). */
const AMBIENT_MIN_GAP_MS: Record<AgentMode, number> = { lead: 1_500, follow: 22_000, watch: 45_000 };
/** How long the human must pause after strokes before the agent looks. */
const PAUSE_BEFORE_LOOK_S = 2.2;
/**
 * Lead mode iterates continuously: as soon as one turn's actions have played
 * out, the next look is taken (the server Gate still spaces calls evenly
 * across the minute). It stops only when the agent declares the sculpture
 * done, the budget reserve is reached, or the human switches mode — and a
 * new human stroke or message after "done" starts it again.
 */

export interface LoopEvents {
  onThinking(thinking: boolean): void;
  onSculpting(active: boolean): void;
  onTurn(response: TurnResponse, frameUrl: string): void;
  onError(message: string): void;
  onBudget(budget: BudgetStatus): void;
}

export class AgentLoop {
  mode: LoopMode = "follow";
  /** Lead mode: the agent said the piece is finished; resumes on new human input. */
  leadDone = false;
  sessionId = crypto.randomUUID();
  /** Bumped by reset(); a turn from an older session drops its response instead of applying it. */
  private epoch = 0;
  private inFlight = false;
  private lastAmbientAt = 0;
  private blockedUntil = 0;
  private lastResults: ActionResult[] = [];
  private timer: number | undefined;

  constructor(private readonly studio: Studio, private readonly events: LoopEvents) {}

  start() {
    this.timer = window.setInterval(() => void this.maybeAmbient(), 1000);
    window.addEventListener("pagehide", () => this.endServerSession());
    void this.refreshBudget();
    window.setInterval(() => void this.refreshBudget(), 20_000);
  }

  stop() {
    if (this.timer) window.clearInterval(this.timer);
  }

  /** End the server-side session now: its short-term memory is deleted rather than left to time out. */
  private endServerSession() {
    navigator.sendBeacon("/api/session/end", JSON.stringify({ sessionId: this.sessionId }));
  }

  /** A fresh agent: new server session (the old one's memory is deleted), nothing queued, default mode. */
  reset() {
    this.endServerSession();
    this.epoch++;
    this.sessionId = crypto.randomUUID();
    this.mode = "follow";
    this.leadDone = false;
    this.queued = null;
    this.lastResults = [];
    this.lastAmbientAt = Date.now();
    this.blockedUntil = 0;
    this.inFlight = false;
    this.studio.setAgentBusy(false);
    this.events.onSculpting(false);
    this.events.onThinking(false);
  }

  get busy() {
    return this.inFlight;
  }

  private queued: string | null = null;

  /** A human message always gets through: if a turn is in flight it is sent the moment that one finishes. */
  async ask(message: string) {
    if (this.mode === "off") this.mode = "follow";
    this.leadDone = false;
    if (this.inFlight) {
      this.queued = message;
      return;
    }
    await this.turn("human", message);
  }

  private async maybeAmbient() {
    if (this.mode === "off" || this.inFlight || this.studio.isStroking || this.studio.isAgentBusy || document.hidden) return;
    const now = Date.now();
    if (now < this.blockedUntil || now - this.lastAmbientAt < AMBIENT_MIN_GAP_MS[this.mode]) return;
    const idle = this.studio.idleSeconds;
    const fresh = this.studio.pendingHumanStrokes > 0 && idle >= PAUSE_BEFORE_LOOK_S;
    if (fresh) this.leadDone = false;
    const initiative = this.mode === "lead" && !this.leadDone;
    if (!fresh && !initiative) return;
    this.lastAmbientAt = now;
    await this.turn("ambient");
  }

  private async turn(trigger: "human" | "ambient", message?: string) {
    if (this.inFlight) return;
    this.inFlight = true;
    const epoch = this.epoch;
    this.events.onThinking(true);
    const mode: AgentMode = this.mode === "off" ? "follow" : this.mode;
    const capture = this.studio.capture(PANEL_PX[mode]);
    const strokes = this.studio.takeStrokes();
    const request: TurnRequest = {
      sessionId: this.sessionId,
      trigger,
      mode,
      message,
      observation: {
        sheet: capture.sheet,
        thumb: capture.thumb,
        geometry: this.studio.summary(),
        strokes,
        idleSeconds: this.studio.idleSeconds,
        activeBrush: { ...this.studio.settings },
      },
      lastResults: this.lastResults,
    };
    let response: TurnResponse;
    try {
      const res = await fetch("/api/agent/turn", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(150_000),
      });
      if (res.status === 401) {
        location.reload();
        return;
      }
      response = (await res.json()) as TurnResponse;
    } catch (cause) {
      this.events.onError(`The agent could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`);
      this.finish();
      return;
    }
    if (response.budget) this.events.onBudget(response.budget);
    if (epoch !== this.epoch) return; // a new session started while this turn was out: drop it

    if (!response.ok) {
      this.blockedUntil = Date.now() + Math.min(response.retryAfterMs ?? 5_000, 10 * 60_000);
      // Transient conditions retry on their own; only say so when the human asked or it's a real problem.
      const quiet = response.error === "ambient_too_soon" || ((response.error === "upstream_overloaded" || response.error === "busy") && trigger !== "human");
      if (!quiet) this.events.onError(describeError(response));
      // Strokes the agent never saw go back into the log for next time.
      this.studio.returnStrokes(strokes);
      this.finish();
      return;
    }

    if (response.done && mode === "lead") this.leadDone = true;
    this.events.onTurn(response, capture.thumbUrl);
    this.events.onThinking(false);
    this.lastResults = [];
    if (response.actions.length) {
      this.studio.setAgentBusy(true);
      this.events.onSculpting(true);
      this.studio.pushUndo();
      // Consecutive primitives share one voxel remesh.
      for (let i = 0; i < response.actions.length; i++) {
        const action = response.actions[i];
        try {
          if (action.kind === "shape") {
            const batch: ShapeAction[] = [];
            while (i < response.actions.length && response.actions[i].kind === "shape") batch.push(response.actions[i++] as ShapeAction);
            i--;
            this.lastResults.push(...(await this.studio.agentShapes(batch)));
          } else {
            this.lastResults.push(await this.studio.agentAction(action, capture.half));
          }
        } catch (error) {
          if (error instanceof AgentCancelled) return; // reset() already cleaned up
          throw error;
        }
      }
      this.studio.setAgentBusy(false);
      this.events.onSculpting(false);
    }
    this.finish();
  }

  private finish() {
    this.inFlight = false;
    this.events.onThinking(false);
    const next = this.queued;
    this.queued = null;
    if (next) void this.turn("human", next);
  }

  private async refreshBudget() {
    try {
      const res = await fetch("/api/agent/budget", { credentials: "same-origin" });
      if (res.ok) this.events.onBudget((await res.json()) as BudgetStatus);
    } catch {
      /* the next turn will report it */
    }
  }
}

function describeError(response: TurnResponse): string {
  const secs = Math.ceil((response.retryAfterMs ?? 0) / 1000);
  switch (response.error) {
    case "busy":
      return `The Gemini lane is busy — next free slot in ${secs}s.`;
    case "daily_limit":
      return "Today's Gemini budget is spent. It resets at midnight Pacific.";
    case "ambient_paused_reserve":
      return "Budget is low, so the agent only answers when you ask it directly.";
    case "upstream_overloaded":
      return "Gemini is overloaded right now — retrying in a few seconds.";
    case "rate_limited_upstream":
      return `Gemini asked us to slow down — pausing ${secs}s.`;
    default:
      return `Agent error: ${response.error ?? "unknown"}`;
  }
}
