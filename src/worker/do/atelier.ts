/**
 * Atelier — one per sculpting session (one browser tab).
 *
 * Holds the agent's SHORT-TERM memory: the last few multi-view frames (low-res
 * sheets, each captioned with what happened after it), the working notes,
 * intent, plan, active skills and the recent dialogue. Every turn pushes the
 * current frame in and drops the oldest, so the agent always sees a sliding
 * window of the most recent moments rather than an ever-growing history.
 *
 * Nothing here outlives the session: every turn re-arms an alarm IDLE_WIPE_MS
 * ahead, and when it fires the object deletes all of its storage. The mesh
 * itself is never sent here — only pictures of it.
 */
import { DurableObject } from "cloudflare:workers";
import { LIMITS, type StrokeSummary, type TurnRequest, type TurnResponse } from "../../shared/protocol.ts";
import { buildRequestBody, emptyState, parseSteps, type WorkingState } from "../agent/harness.ts";
import { MAX_ACTIVE_SKILLS } from "../agent/skills.ts";
import type { AppEnv } from "../env.ts";
import type { GateResult } from "./gate.ts";

const IDLE_WIPE_MS = 20 * 60 * 1000;
/** Minimum spacing of ambient (un-asked) turns per session, by mode. */
const AMBIENT_INTERVAL_MS = { lead: 12_000, follow: 20_000, watch: 40_000 } as const;

export class Atelier extends DurableObject<AppEnv> {
  private state: WorkingState | null = null;

  private async load(): Promise<WorkingState> {
    if (!this.state) this.state = (await this.ctx.storage.get<WorkingState>("state")) ?? emptyState(Date.now());
    return this.state;
  }

  async alarm(): Promise<void> {
    this.state = null;
    await this.ctx.storage.deleteAll();
  }

  /** Called when the tab closes (sendBeacon) — wipe now rather than in 20 minutes. */
  async end(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.alarm();
  }

  async snapshot(): Promise<{ notes: string[]; intent?: WorkingState["intent"]; plan: string[]; frames: number; activeSkills: string[] }> {
    const s = await this.load();
    return { notes: s.notes, intent: s.intent, plan: s.plan, frames: s.frames.length, activeSkills: s.activeSkills };
  }

  async turn(req: TurnRequest): Promise<TurnResponse> {
    const started = Date.now();
    const state = await this.load();
    await this.ctx.storage.setAlarm(started + IDLE_WIPE_MS);
    const gate = this.env.GATE.get(this.env.GATE.idFromName("gemini"));
    const studio = this.env.STUDIO.get(this.env.STUDIO.idFromName("studio"));

    const base = (): TurnResponse => ({
      ok: false,
      actions: [],
      activeSkills: state.activeSkills,
      memory: { longTerm: "", notes: state.notes },
    });

    if (req.trigger === "ambient") {
      const gap = started - state.lastAmbientAt;
      const need = AMBIENT_INTERVAL_MS[req.mode];
      if (gap < need) return { ...base(), error: "ambient_too_soon", retryAfterMs: need - gap };
      state.lastAmbientAt = started;
    }

    const longTerm = await studio.getLongTermMemory();
    const { body, estTokens } = buildRequestBody(req, state, longTerm, started);
    const result: GateResult = await gate.generate({ priority: req.trigger === "human" ? "human" : "ambient", body, estTokens });

    if (req.message) pushDialogue(state, "human", req.message.slice(0, LIMITS.chatChars));

    if (!result.ok) {
      await this.save(state);
      return { ...base(), error: result.error, retryAfterMs: result.retryAfterMs, budget: result.budget, memory: { longTerm, notes: state.notes } };
    }

    const success = result as unknown as Extract<GateResult, { ok: true }>;
    const parsed = parseSteps(success.data.steps ?? [], req.mode, req.trigger === "human");

    if (parsed.intent) state.intent = parsed.intent;
    if (parsed.plan) state.plan = parsed.plan;
    if (parsed.notes) state.notes = parsed.notes;
    for (const name of parsed.skills) {
      state.activeSkills = [name, ...state.activeSkills.filter((s) => s !== name)].slice(0, MAX_ACTIVE_SKILLS);
    }
    let memory = longTerm;
    if (parsed.longTerm !== undefined) memory = await studio.setLongTermMemory(parsed.longTerm);
    if (parsed.say) pushDialogue(state, "agent", parsed.say);

    // Slide the short-term visual window: this turn's frame goes in, captioned
    // with what the human had just done and what the agent decided.
    if (req.observation.thumb && req.observation.thumb.length <= LIMITS.thumbB64) {
      state.frames.push({ t: started, thumb: req.observation.thumb, caption: caption(req.observation.strokes, parsed.actions.length, parsed.say, parsed.waited) });
      while (state.frames.length > LIMITS.recentFrames) state.frames.shift();
    }
    state.turns += 1;
    await this.save(state);

    return {
      ok: true,
      say: parsed.say,
      intent: state.intent,
      plan: state.plan,
      actions: parsed.actions,
      activeSkills: state.activeSkills,
      memory: { longTerm: memory, notes: state.notes },
      budget: success.budget,
      latencyMs: Date.now() - started,
      tokens: success.tokens,
    };
  }

  private async save(state: WorkingState) {
    this.state = state;
    await this.ctx.storage.put("state", state);
  }
}

function pushDialogue(state: WorkingState, who: "human" | "agent", text: string) {
  state.dialogue.push({ who, text, t: Date.now() });
  while (state.dialogue.length > 8) state.dialogue.shift();
}

function caption(strokes: StrokeSummary[], agentStrokes: number, said: string | undefined, waited: string | undefined): string {
  const human = strokes.filter((s) => s.by === "human");
  const byBrush = new Map<string, number>();
  for (const s of human) byBrush.set(s.brush, (byBrush.get(s.brush) ?? 0) + 1);
  const parts = [
    human.length ? `human made ${[...byBrush].map(([b, c]) => `${c} ${b}`).join(", ")}` : "human idle",
    agentStrokes ? `you then made ${agentStrokes} stroke(s)` : waited ? `you waited (${waited})` : "you did not sculpt",
  ];
  if (said) parts.push(`you said "${said.slice(0, 80)}"`);
  return parts.join("; ");
}
