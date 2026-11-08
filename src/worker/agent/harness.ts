/**
 * The agent harness: system prompt, tool declarations, per-turn context, and
 * the parser that turns Gemini's function calls into validated actions.
 *
 * Design, after what has worked for VLM agents that edit 3D:
 *
 * - An inner visual-feedback loop (SceneCraft: removing it cost the most).
 *   Every turn starts with `assess` — observe each view, VERIFY the previous
 *   turn's predicted change against the new frame, compare to the target —
 *   and ends with a prediction (`expected_change`) that the next turn checks.
 * - Planner / critic / verifier roles (LL3M) collapsed into one structured
 *   call, so the free-tier request budget buys iterations, not hand-offs.
 * - Explicit 3D grounding (3DAxisPrompt, SpatialMind): an axis gizmo drawn on
 *   every panel, the exact panel-to-object coordinate formulas, and the form
 *   as numbers (horizontal slices with X/Z extents).
 * - Sculpting doctrine: primary → secondary → tertiary forms, silhouette
 *   first, big Move-style operations before brushes.
 *
 * One model call per turn, tool_choice "any": every answer is a batch of
 * parallel tool calls. Its effect is observed in the next turn's frames.
 */
import {
  BRUSHES,
  FORM_OPS,
  GLOBAL_OPS,
  LIMITS,
  SHAPES,
  VIEWS,
  type AgentAction,
  type AgentMode,
  type BrushName,
  type FormOp,
  type GlobalOp,
  type ShapeKind,
  type TurnRequest,
  type ViewName,
} from "../../shared/protocol.ts";
import type { InteractionStep } from "../do/gate.ts";
import { selectSkills, skillIndex, SKILLS, type Skill } from "./skills.ts";

export const SYSTEM_PROMPT = `You are Prometheus, a master sculptor working live in a digital clay studio, side by side with a human.
You and the human sculpt the SAME mesh at the same time. It starts as Blender's default cube.

=== 3D SPACE (memorise this) ===
- Object space, right-handed, Y UP. The model FACES +Z (its front/face points at the viewer in the FRONT panel).
- +X is the model's own LEFT side (appears on the RIGHT of the front panel). -X is its right side. Symmetry mirrors X -> -X.
- Units: the start cube spans -1..1 on every axis (2 wide). Keep the whole sculpture within about |x|,|y|,|z| <= 1.6 so it frames well.
- Typical sizes: a head bust ~1.6 tall; eyes ~0.12 radius; a nose ~0.25 long; fingers ~0.06 thick.

=== THE SHEET (what you see) ===
3 columns x 2 rows of ORTHOGRAPHIC panels: [front | right | back] / [left | top | three_quarter].
Each panel is labelled, shows "half H" (its half-extent in model units), a faint 4x4 grid at 0.25/0.5/0.75, and an axis gizmo
(X red, Y green, Z blue; "·" = axis points at you, "×" = points away). Panel coordinates (u, v) run 0..1 from the TOP-LEFT.
Converting panel (u, v) to object space, with H = the "half" value:
  front:  x = (2u-1)H,   y = (1-2v)H        (you look along -Z; you see the +Z surface)
  right:  z = -(2u-1)H,  y = (1-2v)H        (camera on +X; panel-left is the FRONT of the model)
  back:   x = -(2u-1)H,  y = (1-2v)H
  left:   z = (2u-1)H,   y = (1-2v)H        (camera on -X; panel-right is the FRONT)
  top:    x = (2u-1)H,   z = (2v-1)H        (looking down; panel-bottom is the FRONT, +Z)
  three_quarter: for judging only, never for coordinates.
Use the SLICES table (X and Z extents at each height) to find surface positions numerically, e.g. the front surface at height y is near z = slice.z[1].

=== HOW YOU ACT (tools; several in one turn) ===
Big moves (primary forms) — use these first, they change the silhouette:
- add_shape: blend a primitive INTO the clay (mode add) or carve it OUT (mode subtract): sphere, ellipsoid (radii), capsule (center->end), box (radii),
  cylinder/cone (axis, radius, minor = half-height), torus (axis, radius, minor = tube). blend 0.05-0.3 = how softly it fuses (bigger = smoother join).
  This is how you add real mass: ears, a snout, limbs, a body, a base, horns. It voxel-remeshes, so topology stays even.
  Sink shapes partly into the existing surface so they fuse. With symmetry=true give only the +X (or centre) instance; the mirror is made for you.
- sculpt_global: whole-model spherize (cube -> ball), smooth, inflate, or scale [sx, sy, sz] (stretch into an egg, a tall bust, a long body).
- sculpt_form: a 3D-addressed Move brush at an object-space point (snapped to the surface): pull/push along a direction by "amount" model units,
  add/carve along the surface normal by "amount" units, or flatten/smooth/inflate/pinch with intensity 0..1. Radius 0.1-0.8.
Secondary and detail:
- sculpt_stroke: a polyline drawn on one panel, projected onto the surface from that panel's camera (points that miss are skipped, so stay
  inside the silhouette). Brushes: draw (raise; invert digs), clay (build layers), inflate, smooth, flatten, pinch, crease (sharp groove), grab.
  passes 1-4 repeats it for strength. Radius in model units: 0.03 fine detail, 0.08-0.15 features, 0.3+ big forms.
- remesh: re-even topology after heavy stretching (no new mass).
Thinking and memory:
- assess (CALL FIRST, EVERY TURN): your structured critique and prediction. See protocol below.
- set_target: the finished sculpture and its milestone checklist (mark milestones done as you go).
- update_intent: your reading of what the HUMAN is making. say: 1-2 sentences to the human, like a studio partner. Skip it if nothing to say.
- use_skill: load a playbook. declare_done: the piece is finished (lead mode). wait: do nothing this turn.

=== REASONING PROTOCOL (think step by step, then act) ===
1. OBSERVE every panel: silhouette, main masses, proportions, what changed since the previous frame (compare with RECENT FRAMES).
2. VERIFY last turn: read "YOU PREDICTED" and the action results. Did the change appear where and how strongly you expected?
   If not, diagnose (wrong coordinates? wrong direction sign? too weak? missed the surface?) and correct this turn.
3. COMPARE to the target: name the 1-3 biggest discrepancies, biggest first, in this order of importance:
   silhouette (front and right) > proportions > primary masses > secondary features > surface quality.
4. PLAN actions that fix the biggest discrepancy. Compute coordinates explicitly from the formulas, bbox and slices; double-check signs
   (front = +Z, model's left = +X, up = +Y).
5. PREDICT what will visibly change and where (goes in assess.expected_change; you will be held to it next turn).

=== SCULPTING DOCTRINE ===
- Primary forms first: the silhouette from front and right must read as the target before any detail. Big radius, big amounts, shapes.
- Then secondary forms (planes, sockets, junctions, major features), then tertiary detail (small radius creases, pinches). Never detail a wrong form.
- Fuse added mass: sink it in, then smooth/clay the seam. Keep it symmetric unless asymmetry is intended.
- Check every view each turn: a form that is right from the front is often wrong from the side or top.
- Prefer a few decisive, large, correct moves over many timid ones. A turn that changes nothing visible is a wasted turn.

=== MODES ===
- lead: YOU OWN THE SCULPTURE. Pick (or adopt from the human) an ambitious, clear target, call set_target, and keep iterating turn after turn
  until it reads unmistakably from every view. Use up to ${LIMITS.actionsByMode.lead} actions per turn, mostly big ones early. Declare done only when
  every milestone is done; until then, never wait. If the human speaks or sculpts, fold their wish into the target.
- follow: support the human — extend their pattern, mirror, fuse and clean beside their work; add mass when it clearly serves their intent.
  Up to ${LIMITS.actionsByMode.follow} actions. Don't overwrite their newest hotspot unless asked.
- watch: comment and infer only; sculpt only if the human asks this turn.
- Whenever the human asks for something, make a substantial, clearly visible step toward it in that same turn.`;

const vec3 = { type: "array", items: { type: "number" }, description: "[x, y, z] in object space" };
const point = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] };

export const TOOLS = [
  {
    type: "function",
    name: "assess",
    description: "Call FIRST every turn: structured critique of the current frame and a prediction for this turn.",
    parameters: {
      type: "object",
      properties: {
        observations: { type: "string", description: "What each panel shows now and what changed since the previous frame." },
        last_turn_verdict: { type: "string", description: "Did your predicted change appear? If not, why, and the correction." },
        discrepancies: { type: "array", items: { type: "string" }, description: "Biggest gaps to the target, biggest first." },
        stage: { type: "string", enum: ["primary", "secondary", "tertiary", "finishing"] },
        expected_change: { type: "string", description: "What will visibly change after this turn's actions, and where." },
      },
      required: ["observations", "discrepancies", "expected_change"],
    },
  },
  {
    type: "function",
    name: "add_shape",
    description: "Blend a primitive into the clay (add) or carve it out (subtract). Voxel-remeshes.",
    parameters: {
      type: "object",
      properties: {
        shape: { type: "string", enum: [...SHAPES] },
        mode: { type: "string", enum: ["add", "subtract"] },
        center: vec3,
        radius: { type: "number", description: "Sphere radius; capsule/cylinder/cone radius; torus ring radius. 0.03-1.2." },
        radii: { ...vec3, description: "Ellipsoid / box half-sizes [rx, ry, rz]." },
        end: { ...vec3, description: "Capsule: the second end point." },
        axis: { ...vec3, description: "Cylinder/cone/torus axis direction (cone tip points along it)." },
        minor: { type: "number", description: "Cylinder/cone half-height, torus tube radius." },
        blend: { type: "number", description: "Smooth fusion width 0-0.4 (default 0.12)." },
        symmetry: { type: "boolean", description: "Also place the X-mirrored copy (default true)." },
        why: { type: "string" },
      },
      required: ["shape", "mode", "center", "radius"],
    },
  },
  {
    type: "function",
    name: "sculpt_global",
    description: "Whole-model operation: spherize (0..1), smooth (0..1), inflate (0..1), or scale by [sx, sy, sz].",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: [...GLOBAL_OPS] },
        amount: { type: "number" },
        scale: { ...vec3, description: "Per-axis factors 0.5-2, for op=scale." },
        why: { type: "string" },
      },
      required: ["op"],
    },
  },
  {
    type: "function",
    name: "sculpt_form",
    description: "3D-addressed Move brush at an object-space surface point.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: [...FORM_OPS] },
        center: vec3,
        radius: { type: "number", description: "0.05-1.0 model units." },
        amount: { type: "number", description: "pull/push/add/carve: displacement in model units (0.02-0.8). Others: intensity 0-1." },
        direction: { ...vec3, description: "pull/push direction, e.g. [0,0,1] = toward the front." },
        symmetry: { type: "boolean" },
        why: { type: "string" },
      },
      required: ["op", "center", "radius", "amount"],
    },
  },
  {
    type: "function",
    name: "sculpt_stroke",
    description: "A brush stroke drawn as a polyline on one panel of the current sheet.",
    parameters: {
      type: "object",
      properties: {
        brush: { type: "string", enum: [...BRUSHES] },
        view: { type: "string", enum: [...VIEWS.filter((v) => v !== "three_quarter")] },
        points: { type: "array", items: point, description: `1-${LIMITS.pointsPerStroke} points, panel coordinates 0..1, origin top-left.` },
        radius: { type: "number", description: "Model units, 0.02-1.0." },
        strength: { type: "number", description: "0.05-1." },
        passes: { type: "integer", description: "Repeat 1-4 times." },
        invert: { type: "boolean" },
        symmetry: { type: "boolean" },
        why: { type: "string" },
      },
      required: ["brush", "view", "points", "radius", "strength"],
    },
  },
  {
    type: "function",
    name: "remesh",
    description: "Re-even the topology (no new mass). Use after heavy stretching.",
    parameters: { type: "object", properties: { why: { type: "string" } } },
  },
  {
    type: "function",
    name: "set_target",
    description: "Define (or revise) the finished sculpture and its milestone checklist; mark milestones done as they are achieved.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "The finished piece, with proportions in model units." },
        milestones: {
          type: "array",
          items: { type: "object", properties: { text: { type: "string" }, done: { type: "boolean" } }, required: ["text", "done"] },
        },
      },
      required: ["description", "milestones"],
    },
  },
  {
    type: "function",
    name: "update_intent",
    description: "Record what you believe the human is making.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        confidence: { type: "number", description: "0..1" },
        target: { type: "string" },
        plan: { type: "array", items: { type: "string" }, description: "Up to 4 next steps." },
      },
      required: ["summary", "confidence"],
    },
  },
  { type: "function", name: "say", description: "A short message to the human.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  {
    type: "function",
    name: "use_skill",
    description: "Load a skill playbook for the rest of the session.",
    parameters: { type: "object", properties: { name: { type: "string", enum: SKILLS.map((s) => s.name) } }, required: ["name"] },
  },
  {
    type: "function",
    name: "declare_done",
    description: "Lead mode: the sculpture is finished (all milestones done, reads from every view).",
    parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  },
  { type: "function", name: "wait", description: "Deliberately do nothing this turn.", parameters: { type: "object", properties: { reason: { type: "string" } } } },
];

export interface WorkingState {
  startedAt: number;
  intent?: { summary: string; confidence: number; target?: string };
  plan: string[];
  activeSkills: string[];
  /** Short-term visual memory: the most recent sheets, replaced every turn. */
  frames: { t: number; thumb: string; caption: string }[];
  dialogue: { who: "human" | "agent"; text: string; t: number }[];
  lastAmbientAt: number;
  turns: number;
  target?: string;
  milestones: { text: string; done: boolean }[];
  /** The last turn's prediction, checked against the next frame. */
  expected?: string;
  assessment?: string;
  stage?: string;
  done?: boolean;
}

export function emptyState(now: number): WorkingState {
  return { startedAt: now, plan: [], activeSkills: [], frames: [], dialogue: [], lastAmbientAt: 0, turns: 0, milestones: [] };
}

/** Per-mode budgets: lead spends tokens freely (sharper sheet, more frames, deep thinking, long output). */
export const MODE_CONFIG = {
  lead: { frames: LIMITS.recentFramesByMode.lead, sheetResolution: "high", thinking: "high", maxOutput: 16384 },
  follow: { frames: LIMITS.recentFramesByMode.follow, sheetResolution: "medium", thinking: "medium", maxOutput: 8192 },
  watch: { frames: LIMITS.recentFramesByMode.watch, sheetResolution: "medium", thinking: "low", maxOutput: 4096 },
} as const;

const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "?");
const v3 = (v: [number, number, number]) => `(${f2(v[0])}, ${f2(v[1])}, ${f2(v[2])})`;

/** The text part of the turn: everything except the images. */
export function contextText(req: TurnRequest, state: WorkingState, skills: Skill[], now: number): string {
  const o = req.observation;
  const g = o.geometry;
  const strokes = o.strokes.slice(-LIMITS.strokesPerObservation);
  const lines: string[] = [];

  lines.push(`MODE: ${req.mode} (up to ${LIMITS.actionsByMode[req.mode]} actions this turn). TRIGGER: ${req.trigger === "human" ? "the human spoke to you" : req.mode === "lead" ? "your next lead iteration" : "ambient check-in (the human did not ask)"}.`);
  if (req.message) lines.push(`HUMAN SAYS: "${req.message.slice(0, LIMITS.chatChars)}"`);

  lines.push(`\nTARGET: ${state.target ?? "(not set yet" + (req.mode === "lead" ? " — call set_target this turn)" : ")")}`);
  if (state.milestones.length) lines.push(state.milestones.map((m, i) => `  ${i + 1}. [${m.done ? "x" : " "}] ${m.text}`).join("\n"));
  if (state.stage) lines.push(`STAGE: ${state.stage}`);
  lines.push(`YOU PREDICTED LAST TURN: ${state.expected ?? "(nothing yet — first look)"}`);
  if (req.lastResults?.length) {
    lines.push(`LAST TURN'S ACTIONS: ${req.lastResults.map((r) => `${r.id} ${r.ok ? "ok" : "FAILED"}${r.hitRatio < 1 ? ` hit=${f2(r.hitRatio)}` : ""}${r.note ? ` (${r.note})` : ""}`).join("; ")}`);
  }

  lines.push(
    `\nGEOMETRY: ${g.vertices} verts / ${g.triangles} tris; bbox ${v3(g.bboxMin)} to ${v3(g.bboxMax)}; mean radius ${f2(g.meanRadius)}; ` +
      `changed since last remesh ${f2(g.displacementFromCube)}; X-asymmetry ${f2(g.symmetryError)}. Panel half H = ${f2(g.half)} (three_quarter uses ${f2(g.half * 1.25)}).`,
  );
  if (g.slices?.length) {
    lines.push("SLICES (bottom to top): y | x-extent | z-extent (front surface = z max) | verts");
    for (const s of g.slices) lines.push(`  y=${f2(s.y)} | x ${f2(s.x[0])}..${f2(s.x[1])} | z ${f2(s.z[0])}..${f2(s.z[1])} | ${s.n}`);
  }
  if (g.hotspots.length) lines.push(`HOTSPOTS (recent change): ${g.hotspots.map((h) => `${v3(h.center)} x${f2(h.magnitude)}`).join("; ")}`);
  lines.push(
    `HUMAN'S BRUSH: ${o.activeBrush.brush} r=${f2(o.activeBrush.radius)} s=${f2(o.activeBrush.strength)} symmetry=${o.activeBrush.symmetry}. Human idle ${Math.round(o.idleSeconds)}s.`,
  );
  if (strokes.length) {
    lines.push(`STROKES SINCE LAST LOOK (${strokes.length}):`);
    for (const s of strokes) {
      lines.push(`- ${s.by} ${s.brush}${s.invert ? "(inv)" : ""} ${v3(s.from)}->${v3(s.to)} r=${f2(s.radius)} ${s.dabs} dabs${s.symmetry ? " sym" : ""} @${Math.round(s.t)}s`);
    }
  } else lines.push("No strokes since your last look.");

  lines.push(`\nWORKING MEMORY (session ${Math.round((now - state.startedAt) / 1000)}s, turn ${state.turns + 1}):`);
  lines.push(state.intent ? `- human intent: ${state.intent.summary} (confidence ${f2(state.intent.confidence)}${state.intent.target ? `, target: ${state.intent.target}` : ""})` : "- human intent: unknown yet");
  if (state.plan.length) lines.push(`- plan: ${state.plan.join(" -> ")}`);
  if (state.assessment) lines.push(`- your last critique: ${state.assessment}`);
  for (const d of state.dialogue.slice(-6)) lines.push(`- ${d.who}: ${d.text}`);

  lines.push(`\nSKILLS AVAILABLE (call use_skill to load):\n${skillIndex()}`);
  for (const s of skills) lines.push(`\nLOADED SKILL — ${s.body}`);
  return lines.join("\n");
}

export function buildRequestBody(req: TurnRequest, state: WorkingState, now: number) {
  const config = MODE_CONFIG[req.mode];
  const skills = selectSkills(state.activeSkills, req.message);
  const content: Record<string, unknown>[] = [{ type: "text", text: contextText(req, state, skills, now) }];
  const frames = state.frames.slice(-config.frames);
  if (frames.length) {
    content.push({ type: "text", text: `RECENT FRAMES (oldest first; same 3x2 layout):` });
    frames.forEach((f, i) => {
      content.push({ type: "text", text: `Frame -${frames.length - i} (${Math.round((now - f.t) / 1000)}s ago): ${f.caption}` });
      content.push({ type: "image", data: f.thumb, mime_type: "image/jpeg", resolution: "low" });
    });
  }
  content.push({ type: "text", text: "CURRENT SHEET (this is now; act on this):" });
  content.push({ type: "image", data: req.observation.sheet, mime_type: "image/jpeg", resolution: config.sheetResolution });

  const body = {
    system_instruction: SYSTEM_PROMPT,
    input: [{ type: "user_input", content }],
    tools: TOOLS,
    generation_config: { tool_choice: "any", thinking_level: config.thinking, max_output_tokens: config.maxOutput },
  };
  // ~4 chars/token for text; the sheet ~1.1K tokens at medium, ~2.5K at high; low frames ~300 each.
  const textChars = JSON.stringify(content.filter((c) => c.type === "text")).length + SYSTEM_PROMPT.length + JSON.stringify(TOOLS).length;
  const sheetTokens = config.sheetResolution === "high" ? 2600 : 1100;
  const estTokens = Math.ceil(textChars / 4) + sheetTokens + frames.length * 300 + Math.round(config.maxOutput / 2);
  return { body, estTokens, skills };
}

export interface ParsedTurn {
  actions: AgentAction[];
  say?: string;
  intent?: { summary: string; confidence: number; target?: string };
  plan?: string[];
  skills: string[];
  waited?: string;
  assessment?: string;
  expected?: string;
  stage?: string;
  target?: { description: string; milestones: { text: string; done: boolean }[] };
  done?: string;
}

const num = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const vec = (v: unknown, lo = -3, hi = 3): [number, number, number] | undefined => {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const out = v.slice(0, 3).map((x) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : NaN));
  return out.some(Number.isNaN) ? undefined : (out as [number, number, number]);
};

export function parseSteps(steps: InteractionStep[], mode: AgentMode, humanAsked: boolean): ParsedTurn {
  const out: ParsedTurn = { actions: [], skills: [] };
  const sayParts: string[] = [];
  const cap = LIMITS.actionsByMode[mode];
  const maySculpt = mode !== "watch" || humanAsked;
  let n = 0;
  const push = (action: AgentAction) => {
    if (maySculpt && out.actions.length < cap) out.actions.push(action);
  };
  for (const step of steps) {
    if (step.type === "model_output") {
      const text = (step.content ?? []).map((c) => c.text ?? "").join("").trim();
      if (text) sayParts.push(text);
      continue;
    }
    if (step.type !== "function_call" || !step.name) continue;
    const a = step.arguments ?? {};
    const why = str(a.why, 60);
    switch (step.name) {
      case "assess": {
        const discrepancies = Array.isArray(a.discrepancies) ? a.discrepancies.slice(0, 4).map((d) => str(d, 160)).filter(Boolean) : [];
        out.assessment = [str(a.last_turn_verdict, 240), discrepancies.length ? `Gaps: ${discrepancies.join("; ")}` : ""].filter(Boolean).join(" ").slice(0, 600) || str(a.observations, 400);
        out.expected = str(a.expected_change, 300) || undefined;
        out.stage = str(a.stage, 20) || undefined;
        break;
      }
      case "sculpt_stroke": {
        const brush = a.brush as BrushName;
        const view = a.view as ViewName;
        if (!BRUSHES.includes(brush) || !VIEWS.includes(view)) break;
        const points = (Array.isArray(a.points) ? a.points : [])
          .slice(0, LIMITS.pointsPerStroke)
          .map((p) => {
            const q = p as { x?: unknown; y?: unknown } | number[];
            const x = Array.isArray(q) ? q[0] : q.x;
            const y = Array.isArray(q) ? q[1] : q.y;
            return [num(x, 0, 1, NaN), num(y, 0, 1, NaN)] as [number, number];
          })
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (points.length === 0) break;
        push({
          kind: "stroke",
          id: `a${++n}`,
          brush,
          view,
          points,
          radius: num(a.radius, 0.02, 1, 0.15),
          strength: num(a.strength, 0.05, 1, 0.5),
          passes: Math.round(num(a.passes, 1, 4, 1)),
          invert: a.invert === true,
          symmetry: a.symmetry !== false,
          why,
        });
        break;
      }
      case "sculpt_form": {
        const op = a.op as FormOp;
        const center = vec(a.center);
        if (!FORM_OPS.includes(op) || !center) break;
        push({ kind: "form", id: `a${++n}`, op, center, radius: num(a.radius, 0.03, 1.2, 0.3), amount: num(a.amount, 0, 1, 0.2), direction: vec(a.direction, -1, 1), symmetry: a.symmetry !== false, why });
        break;
      }
      case "sculpt_global": {
        const op = a.op as GlobalOp;
        if (!GLOBAL_OPS.includes(op)) break;
        const scale = op === "scale" ? vec(a.scale, 0.5, 2) : undefined;
        if (op === "scale" && !scale) break;
        push({ kind: "global", id: `a${++n}`, op, amount: num(a.amount, 0, 1, 0.5), scale, why });
        break;
      }
      case "add_shape": {
        const shape = a.shape as ShapeKind;
        const center = vec(a.center);
        if (!SHAPES.includes(shape) || !center) break;
        push({
          kind: "shape",
          id: `a${++n}`,
          shape,
          mode: a.mode === "subtract" ? "subtract" : "add",
          center,
          radius: num(a.radius, 0.03, 1.2, 0.3),
          radii: vec(a.radii, 0.02, 1.5),
          end: vec(a.end),
          axis: vec(a.axis, -1, 1),
          minor: a.minor === undefined ? undefined : num(a.minor, 0.01, 1.2, 0.2),
          blend: num(a.blend, 0, 0.4, 0.12),
          symmetry: a.symmetry !== false,
          why,
        });
        break;
      }
      case "remesh":
        push({ kind: "remesh", id: `a${++n}`, why: why || "even out topology" });
        break;
      case "set_target": {
        const milestones = (Array.isArray(a.milestones) ? a.milestones : [])
          .slice(0, LIMITS.milestones)
          .map((m) => ({ text: str((m as { text?: unknown }).text, 120), done: (m as { done?: unknown }).done === true }))
          .filter((m) => m.text);
        const description = str(a.description, 300);
        if (description) out.target = { description, milestones };
        break;
      }
      case "update_intent":
        out.intent = { summary: str(a.summary, 200), confidence: num(a.confidence, 0, 1, 0.5), target: str(a.target, 80) || undefined };
        if (Array.isArray(a.plan)) out.plan = a.plan.slice(0, 4).map((p) => str(p, 120)).filter(Boolean);
        break;
      case "say":
        if (str(a.text, 400)) sayParts.push(str(a.text, 400));
        break;
      case "use_skill":
        if (typeof a.name === "string" && SKILLS.some((s) => s.name === a.name)) out.skills.push(a.name);
        break;
      case "declare_done":
        if (mode === "lead") out.done = str(a.summary, 300) || "finished";
        break;
      case "wait":
        out.waited = str(a.reason, 120) || "waiting";
        break;
    }
  }
  if (sayParts.length) out.say = sayParts.join(" ").slice(0, 500);
  if (out.done && !out.say) out.say = out.done;
  return out;
}
