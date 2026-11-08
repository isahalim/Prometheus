/**
 * Atelier — one per sculpting session (one browser tab).
 *
 * Holds the agent's SHORT-TERM memory: the last few multi-view frames (low-res
 * sheets, each paired with the human's strokes before it, the agent's exact
 * actions after it, its prediction and its later verdict), the reading,
 * intent, plan, active skills and the recent dialogue. Every turn pushes the
 * current frame in and drops the oldest, so the agent always sees a sliding
 * window of the most recent moments rather than an ever-growing history.
 *
 * Nothing here outlives the session: every turn re-arms an alarm IDLE_WIPE_MS
 * ahead, and when it fires the object deletes all of its storage. The mesh
 * itself is never sent here — only pictures of it.
 */
import { DurableObject } from "cloudflare:workers";
import { LIMITS, type ActionResult, type MemoryStep, type StrokeSummary, type TurnRequest, type TurnResponse } from "../../shared/protocol.ts";
import { buildRequestBody, describeAction, emptyState, parseSteps, type WorkingState } from "../agent/harness.ts";
import { MAX_ACTIVE_SKILLS } from "../agent/skills.ts";
import type { AppEnv } from "../env.ts";
import type { GateResult } from "./gate.ts";

const IDLE_WIPE_MS = 20 * 60 * 1000;
/** Minimum spacing of ambient (un-asked) turns per session, by mode. */
/** Lead iterates continuously; the Gate still spaces every call evenly across the minute. */
const AMBIENT_INTERVAL_MS = { lead: 2_000, follow: 20_000, watch: 40_000 } as const;

export class Atelier extends DurableObject<AppEnv> {
  private state: WorkingState | null = null;

  private async load(): Promise<WorkingState> {
    if (!this.state) {
      this.state = { ...emptyState(Date.now()), ...((await this.ctx.storage.get<WorkingState>("state")) ?? {}) };
      // Steps saved by an older build (caption-only) can't be rendered as a trajectory; drop them.
      this.state.frames = this.state.frames.filter((f) => Array.isArray(f.did));
    }
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

  async snapshot(): Promise<{ intent?: WorkingState["intent"]; plan: string[]; frames: number; activeSkills: string[] }> {
    const s = await this.load();
    return { intent: s.intent, plan: s.plan, frames: s.frames.length, activeSkills: s.activeSkills };
  }

  async turn(req: TurnRequest): Promise<TurnResponse> {
    const started = Date.now();
    const state = await this.load();
    await this.ctx.storage.setAlarm(started + IDLE_WIPE_MS);
    const gate = this.env.GATE.get(this.env.GATE.idFromName("gemini"));

    const base = (): TurnResponse => ({
      ok: false,
      actions: [],
      activeSkills: state.activeSkills,
    });

    if (req.trigger === "ambient") {
      const gap = started - state.lastAmbientAt;
      const need = AMBIENT_INTERVAL_MS[req.mode];
      if (gap < need) return { ...base(), error: "ambient_too_soon", retryAfterMs: need - gap };
      state.lastAmbientAt = started;
    }

    const { body, estTokens } = buildRequestBody(req, state, started);
    const priority = req.trigger === "human" ? "human" : req.mode === "lead" ? "lead" : "ambient";
    const result: GateResult = await gate.generate({ priority, body, estTokens });

    if (req.message) pushDialogue(state, "human", req.message.slice(0, LIMITS.chatChars));

    if (!result.ok) {
      await this.save(state);
      return { ...base(), error: result.error, retryAfterMs: result.retryAfterMs, budget: result.budget };
    }

    let success = result as unknown as Extract<GateResult, { ok: true }>;
    const steps = success.data.steps ?? [];
    let parsed = parseSteps(steps, req.mode, req.trigger === "human");

    // A turn that must act (the human asked, or Lead owns the piece) sometimes comes back as a
    // critique only: assess, maybe set_target, and nothing else. Continue the same interaction
    // once — echo the model's own steps verbatim (thought signatures included), answer each
    // call, and ask for the actions. Costs one extra request, only when it stalls.
    const mustAct = req.trigger === "human" || req.mode === "lead";
    if (mustAct && parsed.actions.length === 0 && !parsed.waited && !parsed.done && req.mode !== "watch") {
      const calls = steps.filter((st) => st.type === "function_call" && st.id && st.name);
      const continuation = {
        ...body,
        input: [
          ...(body.input as unknown[]),
          ...steps,
          ...calls.map((c) => ({
            type: "function_result",
            call_id: c.id,
            name: c.name,
            result: [{ type: "text", text: c.name === "assess" ? "Assessment recorded. Now ACT on it: call the sculpting tools for this turn (add_shape, sculpt_global, sculpt_form, sculpt_stroke). Do not call assess again." : "ok" }],
          })),
        ],
      };
      const second: GateResult = await gate.generate({ priority, body: continuation, estTokens });
      if (second.ok) {
        success = second as unknown as Extract<GateResult, { ok: true }>;
        const more = parseSteps(success.data.steps ?? [], req.mode, req.trigger === "human");
        parsed = {
          ...parsed,
          actions: more.actions,
          say: [parsed.say, more.say].filter(Boolean).join(" ") || undefined,
          intent: more.intent ?? parsed.intent,
          plan: more.plan ?? parsed.plan,
          target: more.target ?? parsed.target,
          expected: more.expected ?? parsed.expected,
          skills: [...parsed.skills, ...more.skills],
          done: more.done ?? parsed.done,
          waited: more.waited ?? parsed.waited,
        };
      }
    }

    if (parsed.intent) state.intent = parsed.intent;
    if (parsed.target) {
      state.target = parsed.target.description;
      if (parsed.target.milestones.length) state.milestones = parsed.target.milestones;
    }
    if (parsed.assessment) state.assessment = parsed.assessment;
    state.expected = parsed.expected ?? (parsed.actions.length ? undefined : state.expected);
    if (parsed.stage) state.stage = parsed.stage;
    state.done = Boolean(parsed.done);
    if (parsed.plan) state.plan = parsed.plan;
    for (const name of parsed.skills) {
      state.activeSkills = [name, ...state.activeSkills.filter((s) => s !== name)].slice(0, MAX_ACTIVE_SKILLS);
    }
    if (parsed.say) pushDialogue(state, "agent", parsed.say);

    // Close out the previous step: how its actions ran and the agent's verdict on its result.
    const previous = state.frames[state.frames.length - 1];
    if (previous) {
      if (req.lastResults?.length) previous.ran = describeResults(req.lastResults);
      if (parsed.verdict) previous.verdict = parsed.verdict;
    }
    // Then this turn becomes the newest step: the frame, what the human did
    // before it, and exactly what the agent does right after it.
    if (req.observation.thumb && req.observation.thumb.length <= LIMITS.thumbB64) {
      state.frames.push({
        t: started,
        thumb: req.observation.thumb,
        human: describeHuman(req.observation.strokes),
        did: parsed.actions.length ? parsed.actions.map(describeAction) : parsed.waited ? [`wait (${parsed.waited})`] : [],
        expected: parsed.expected,
      });
      while (state.frames.length > LIMITS.recentFrames) state.frames.shift();
    }
    state.turns += 1;
    await this.save(state);

    return {
      ok: true,
      say: parsed.say,
      intent: state.intent,
      plan: state.plan,
      target: state.target,
      milestones: state.milestones,
      assessment: state.assessment,
      done: state.done,
      actions: parsed.actions,
      activeSkills: state.activeSkills,
      memory: memorySteps(state, started),
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

function describeHuman(strokes: StrokeSummary[]): string {
  const human = strokes.filter((s) => s.by === "human");
  if (human.length === 0) return "nothing";
  const byBrush = new Map<string, number>();
  for (const s of human) byBrush.set(`${s.brush}${s.invert ? "-inv" : ""}`, (byBrush.get(`${s.brush}${s.invert ? "-inv" : ""}`) ?? 0) + 1);
  const where = human.slice(-3).map((s) => `(${s.center.map((n) => n.toFixed(1)).join(",")})`).join(" ");
  return `${[...byBrush].map(([b, c]) => `${c} ${b}`).join(", ")} near ${where}`;
}

function describeResults(results: ActionResult[]): string {
  const failed = results.filter((r) => !r.ok || r.hitRatio < 0.5);
  if (failed.length === 0) return `all ${results.length} ran`;
  return `${results.length - failed.length}/${results.length} ran; ${failed.map((r) => `${r.id} ${r.ok ? `hit only ${Math.round(r.hitRatio * 100)}%` : r.note ?? "missed"}`).join("; ")}`;
}

function memorySteps(state: WorkingState, now: number): MemoryStep[] {
  return state.frames.map((f) => ({
    ageSeconds: Math.round((now - f.t) / 1000),
    human: f.human,
    did: f.did,
    expected: f.expected,
    ran: f.ran,
    verdict: f.verdict,
  }));
}
