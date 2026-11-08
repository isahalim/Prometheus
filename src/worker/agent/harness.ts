/**
 * The agent harness: system prompt, tool declarations, the per-turn context,
 * and the parser that turns Gemini's function calls into validated actions.
 *
 * One model call per turn, with tool_choice "any" so every answer is a set of
 * parallel tool calls. There is no in-request tool loop: the effect of the
 * agent's strokes is observed on the NEXT turn's frames, which closes the
 * loop through the human's own screen and costs no extra requests.
 */
import {
  BRUSHES,
  LIMITS,
  VIEWS,
  type AgentAction,
  type AgentMode,
  type BrushName,
  type StrokeAction,
  type TurnRequest,
  type ViewName,
} from "../../shared/protocol.ts";
import type { InteractionStep } from "../do/gate.ts";
import { selectSkills, skillIndex, SKILLS, type Skill } from "./skills.ts";

export const SYSTEM_PROMPT = `You are Prometheus, a sculptor pair-working with a human in a live digital clay studio.
You both sculpt the same mesh at the same time. It started as Blender's default cube (2 units wide, centred at the origin, Y up).

WHAT YOU SEE EACH TURN
- CURRENT SHEET: one image, 3 columns x 2 rows of orthographic panels: [front | right | back] / [left | top | three_quarter].
  front: camera on +Z looking at the model; panel right = +X, panel up = +Y.
  right: camera on +X; panel right = -Z. back: camera on -Z; panel right = -X. left: camera on -X; panel right = +Z.
  top: camera above (+Y); panel right = +X, panel DOWN = +Z (the front of the model is at the bottom of the panel).
  three_quarter: from front-right-above, for judging form only.
  Each panel has a faint 4x4 grid at 0.25/0.5/0.75. Coordinates inside a panel are (x, y) in 0..1 with (0,0) at the panel's TOP-LEFT.
- RECENT FRAMES: up to ${LIMITS.recentFrames} earlier sheets, oldest first, each captioned with what happened after it. Compare them with the current sheet to infer where the human is going.
- The human's recent strokes (brush, object-space centre, direction), a geometry summary and hotspots of recent change.
- WORKING MEMORY (this session) and LONG-TERM MEMORY (across sessions, about this human).

HOW YOU ACT — only through tool calls, several per turn when useful:
- sculpt_stroke: a stroke drawn on one panel. Points are projected from that panel's camera onto the surface; points that miss the model are skipped, so stay on the silhouette's inside. Radius is in model units (the cube is 2 wide): 0.03 fine detail, 0.1 features, 0.3+ big forms.
  Brushes: draw (raise; invert to dig), clay (build flat layers), inflate (swell), smooth (relax), flatten (plane), pinch (tighten toward the stroke line, sharpens edges), crease (cut a sharp groove), grab (moves surface along the stroke direction — the main way to change the silhouette).
- update_intent: your current reading of what the human is making, with confidence, and a short plan.
- say: one or two short sentences to the human. Talk like a studio partner, not an assistant. Skip it when you have nothing useful to say.
- set_working_notes: replace your session scratchpad (max ${LIMITS.workingNotes} short notes).
- rewrite_long_term_memory: replace the WHOLE long-term memory (max ${LIMITS.longTermChars} chars) with a consolidated version. Only when you learned something durable about the human's taste, goals or habits; merge with what is there and drop what is stale.
- use_skill: load a skill playbook for the rest of the session.
- wait: when the right move is to do nothing.

MODES
- lead: you drive toward the inferred/agreed target, 1-4 deliberate strokes per turn.
- follow: support the human — continue their pattern, mirror, clean up beside their work. Never overwrite what they are doing right now.
- watch: do not sculpt unless the human explicitly asks in this turn; infer intent, comment sparingly.

RULES
- When the human asks you for something, make a substantial, clearly visible step toward it in that same turn: 3-6 strokes, big radius for big changes. On ambient turns prefer 1-3 strokes. Never more than ${LIMITS.actionsPerTurn} strokes in a turn.
- The start is a hard-edged cube: rounding it needs large smooth/inflate strokes ALONG the edges and corners (radius 0.4-0.6, strength 0.8-1), not one dab in the middle of a face.
- Respect the human's work: don't smooth away or carve into their newest hotspot unless asked.
- If last turn's strokes missed (low hit ratio), fix your coordinates against the current sheet before trying again.
- Always call update_intent when your reading of the goal changes.`;

const point = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] };

export const TOOLS = [
  {
    type: "function",
    name: "sculpt_stroke",
    description: "Apply one brush stroke drawn as a polyline on one panel of the current sheet.",
    parameters: {
      type: "object",
      properties: {
        brush: { type: "string", enum: [...BRUSHES] },
        view: { type: "string", enum: [...VIEWS] },
        points: { type: "array", items: point, description: "1-24 points, panel coordinates 0..1, origin top-left." },
        radius: { type: "number", description: "Model units, 0.02-0.6." },
        strength: { type: "number", description: "0.05-1." },
        invert: { type: "boolean" },
        symmetry: { type: "boolean", description: "Mirror across X." },
        why: { type: "string", description: "Five words or fewer." },
      },
      required: ["brush", "view", "points", "radius", "strength"],
    },
  },
  {
    type: "function",
    name: "update_intent",
    description: "Record what you believe the human is making and your plan.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        confidence: { type: "number", description: "0..1" },
        target: { type: "string", description: "The finished form, in a few words." },
        plan: { type: "array", items: { type: "string" }, description: "Up to 4 next steps." },
      },
      required: ["summary", "confidence"],
    },
  },
  {
    type: "function",
    name: "say",
    description: "A short message to the human.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    type: "function",
    name: "set_working_notes",
    description: "Replace the session scratchpad.",
    parameters: { type: "object", properties: { notes: { type: "array", items: { type: "string" } } }, required: ["notes"] },
  },
  {
    type: "function",
    name: "rewrite_long_term_memory",
    description: "Replace the entire long-term memory with a consolidated version.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    type: "function",
    name: "use_skill",
    description: "Load a skill playbook for the rest of the session.",
    parameters: { type: "object", properties: { name: { type: "string", enum: SKILLS.map((s) => s.name) } }, required: ["name"] },
  },
  {
    type: "function",
    name: "wait",
    description: "Deliberately do nothing this turn.",
    parameters: { type: "object", properties: { reason: { type: "string" } } },
  },
];

export interface WorkingState {
  startedAt: number;
  notes: string[];
  intent?: { summary: string; confidence: number; target?: string };
  plan: string[];
  activeSkills: string[];
  /** Short-term visual memory: the most recent sheets, replaced every turn. */
  frames: { t: number; thumb: string; caption: string }[];
  dialogue: { who: "human" | "agent"; text: string; t: number }[];
  lastAmbientAt: number;
  turns: number;
}

export function emptyState(now: number): WorkingState {
  return { startedAt: now, notes: [], plan: [], activeSkills: [], frames: [], dialogue: [], lastAmbientAt: 0, turns: 0 };
}

const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "?");
const v3 = (v: [number, number, number]) => `(${f2(v[0])}, ${f2(v[1])}, ${f2(v[2])})`;

/** The text part of the turn: everything except the images. */
export function contextText(req: TurnRequest, state: WorkingState, longTerm: string, skills: Skill[], now: number): string {
  const o = req.observation;
  const g = o.geometry;
  const strokes = o.strokes.slice(-LIMITS.strokesPerObservation);
  const lines: string[] = [];

  lines.push(`MODE: ${req.mode}. TRIGGER: ${req.trigger === "human" ? "the human spoke to you" : "ambient check-in (the human did not ask)"}.`);
  if (req.message) lines.push(`HUMAN SAYS: "${req.message.slice(0, LIMITS.chatChars)}"`);
  lines.push(
    `\nGEOMETRY: ${g.vertices} verts; bbox ${v3(g.bboxMin)} to ${v3(g.bboxMax)}; mean radius ${f2(g.meanRadius)}; ` +
      `changed from cube ${f2(g.displacementFromCube)}; X-asymmetry ${f2(g.symmetryError)}.`,
  );
  if (g.hotspots.length) lines.push(`HOTSPOTS (recent change): ${g.hotspots.map((h) => `${v3(h.center)} x${f2(h.magnitude)}`).join("; ")}`);
  lines.push(
    `HUMAN'S BRUSH: ${o.activeBrush.brush} r=${f2(o.activeBrush.radius)} s=${f2(o.activeBrush.strength)} symmetry=${o.activeBrush.symmetry}. Idle ${Math.round(o.idleSeconds)}s.`,
  );
  if (strokes.length) {
    lines.push(`STROKES SINCE LAST LOOK (${strokes.length}):`);
    for (const s of strokes) {
      lines.push(
        `- ${s.by} ${s.brush}${s.invert ? "(inv)" : ""} ${v3(s.from)}->${v3(s.to)} r=${f2(s.radius)} ${s.dabs} dabs${s.symmetry ? " sym" : ""} @${Math.round(s.t)}s`,
      );
    }
  } else lines.push("No strokes since your last look.");
  if (req.lastResults?.length) {
    lines.push(`YOUR LAST STROKES: ${req.lastResults.map((r) => `${r.id} ${r.ok ? "ok" : "MISSED"} hit=${f2(r.hitRatio)}`).join("; ")}`);
  }

  lines.push(`\nWORKING MEMORY (session ${Math.round((now - state.startedAt) / 1000)}s, turn ${state.turns + 1}):`);
  lines.push(state.intent ? `- intent: ${state.intent.summary} (confidence ${f2(state.intent.confidence)}${state.intent.target ? `, target: ${state.intent.target}` : ""})` : "- intent: unknown yet");
  if (state.plan.length) lines.push(`- plan: ${state.plan.join(" -> ")}`);
  for (const n of state.notes) lines.push(`- note: ${n}`);
  for (const d of state.dialogue.slice(-6)) lines.push(`- ${d.who}: ${d.text}`);

  lines.push(`\nLONG-TERM MEMORY (${longTerm.length}/${LIMITS.longTermChars} chars):\n${longTerm || "(empty)"}`);
  lines.push(`\nSKILLS AVAILABLE (call use_skill to load):\n${skillIndex()}`);
  for (const s of skills) lines.push(`\nLOADED SKILL — ${s.body}`);
  return lines.join("\n");
}

export function buildRequestBody(req: TurnRequest, state: WorkingState, longTerm: string, now: number) {
  const skills = selectSkills(state.activeSkills, req.message);
  const content: Record<string, unknown>[] = [{ type: "text", text: contextText(req, state, longTerm, skills, now) }];
  if (state.frames.length) {
    content.push({ type: "text", text: `RECENT FRAMES (oldest first):` });
    state.frames.forEach((f, i) => {
      content.push({ type: "text", text: `Frame -${state.frames.length - i} (${Math.round((now - f.t) / 1000)}s ago): ${f.caption}` });
      content.push({ type: "image", data: f.thumb, mime_type: "image/jpeg", resolution: "low" });
    });
  }
  content.push({ type: "text", text: "CURRENT SHEET:" });
  content.push({ type: "image", data: req.observation.sheet, mime_type: "image/jpeg", resolution: "medium" });

  const body = {
    system_instruction: SYSTEM_PROMPT,
    input: [{ type: "user_input", content }],
    tools: TOOLS,
    generation_config: { tool_choice: "any", thinking_level: "low", max_output_tokens: 2048 },
  };
  // ~4 chars/token for text; images measured live at ~1.1K tokens (medium) and well under that at low.
  const textChars = JSON.stringify(content.filter((c) => c.type === "text")).length + SYSTEM_PROMPT.length + JSON.stringify(TOOLS).length;
  const estTokens = Math.ceil(textChars / 4) + 1100 + state.frames.length * 300 + 2048;
  return { body, estTokens, skills };
}

export interface ParsedTurn {
  actions: AgentAction[];
  say?: string;
  intent?: { summary: string; confidence: number; target?: string };
  plan?: string[];
  notes?: string[];
  longTerm?: string;
  skills: string[];
  waited?: string;
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
};
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function parseSteps(steps: InteractionStep[], mode: AgentMode, humanAsked: boolean): ParsedTurn {
  const out: ParsedTurn = { actions: [], skills: [] };
  const sayParts: string[] = [];
  let n = 0;
  for (const step of steps) {
    if (step.type === "model_output") {
      const text = (step.content ?? []).map((c) => c.text ?? "").join("").trim();
      if (text) sayParts.push(text);
      continue;
    }
    if (step.type !== "function_call" || !step.name) continue;
    const a = step.arguments ?? {};
    switch (step.name) {
      case "sculpt_stroke": {
        if (mode === "watch" && !humanAsked) break;
        if (out.actions.length >= LIMITS.actionsPerTurn) break;
        const brush = a.brush as BrushName;
        const view = a.view as ViewName;
        if (!BRUSHES.includes(brush) || !VIEWS.includes(view)) break;
        const points = (Array.isArray(a.points) ? a.points : [])
          .slice(0, LIMITS.pointsPerStroke)
          .map((p) => {
            const q = p as { x?: unknown; y?: unknown } | number[];
            const x = Array.isArray(q) ? q[0] : q.x;
            const y = Array.isArray(q) ? q[1] : q.y;
            return [clamp(x, 0, 1, NaN), clamp(y, 0, 1, NaN)] as [number, number];
          })
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (points.length === 0) break;
        const action: StrokeAction = {
          kind: "stroke",
          id: `a${++n}`,
          brush,
          view,
          points,
          radius: clamp(a.radius, 0.02, 0.6, 0.15),
          strength: clamp(a.strength, 0.05, 1, 0.5),
          invert: a.invert === true,
          symmetry: a.symmetry !== false,
          why: str(a.why, 60),
        };
        out.actions.push(action);
        break;
      }
      case "update_intent":
        out.intent = { summary: str(a.summary, 200), confidence: clamp(a.confidence, 0, 1, 0.5), target: str(a.target, 80) || undefined };
        if (Array.isArray(a.plan)) out.plan = a.plan.slice(0, 4).map((p) => str(p, 120)).filter(Boolean);
        break;
      case "say":
        if (str(a.text, 400)) sayParts.push(str(a.text, 400));
        break;
      case "set_working_notes":
        if (Array.isArray(a.notes)) out.notes = a.notes.slice(0, LIMITS.workingNotes).map((x) => str(x, LIMITS.workingNoteChars)).filter(Boolean);
        break;
      case "rewrite_long_term_memory":
        if (typeof a.text === "string") out.longTerm = a.text;
        break;
      case "use_skill":
        if (typeof a.name === "string" && SKILLS.some((s) => s.name === a.name)) out.skills.push(a.name);
        break;
      case "wait":
        out.waited = str(a.reason, 120) || "waiting";
        break;
    }
  }
  if (sayParts.length) out.say = sayParts.join(" ").slice(0, 500);
  return out;
}
