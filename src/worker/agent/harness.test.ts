import { describe, expect, it } from "vitest";
import { LIMITS, type TurnRequest } from "../../shared/protocol.ts";
import { buildRequestBody, describeAction, emptyState, parseSteps } from "./harness.ts";
import { selectSkills, MAX_ACTIVE_SKILLS } from "./skills.ts";

const call = (name: string, args: Record<string, unknown>) => ({ type: "function_call", id: name, name, arguments: args });

describe("parseSteps", () => {
  it("turns a stroke call into a validated, clamped action", () => {
    const out = parseSteps(
      [call("sculpt_stroke", { brush: "clay", view: "front", points: [{ x: 0.5, y: 0.4 }, { x: 2, y: -1 }], radius: 5, strength: 0.4 })],
      "lead",
      false,
    );
    expect(out.actions).toHaveLength(1);
    const action = out.actions[0];
    if (action.kind !== "stroke") throw new Error("expected a stroke");
    expect(action.points).toEqual([[0.5, 0.4], [1, 0]]);
    expect(action.radius).toBe(1);
    expect(action.symmetry).toBe(true);
    expect(action.passes).toBe(1);
  });

  it("drops unknown brushes and views", () => {
    const out = parseSteps([call("sculpt_stroke", { brush: "chisel", view: "front", points: [{ x: 0.5, y: 0.5 }], radius: 0.1, strength: 0.5 })], "lead", false);
    expect(out.actions).toHaveLength(0);
  });

  it("does not sculpt in watch mode unless the human asked", () => {
    const stroke = call("sculpt_stroke", { brush: "draw", view: "top", points: [{ x: 0.5, y: 0.5 }], radius: 0.1, strength: 0.5 });
    expect(parseSteps([stroke], "watch", false).actions).toHaveLength(0);
    expect(parseSteps([stroke], "watch", true).actions).toHaveLength(1);
  });

  it("caps actions per turn by mode", () => {
    const strokes = Array.from({ length: 40 }, () => call("sculpt_stroke", { brush: "draw", view: "front", points: [{ x: 0.5, y: 0.5 }], radius: 0.1, strength: 0.5 }));
    const lead = parseSteps(strokes, "lead", true);
    expect(lead.actions).toHaveLength(LIMITS.actionsByMode.lead);
    expect(parseSteps(strokes, "follow", true).actions).toHaveLength(LIMITS.actionsByMode.follow);
  });

  it("parses 3D actions: shapes, form moves and global ops", () => {
    const out = parseSteps(
      [
        call("add_shape", { shape: "ellipsoid", mode: "add", center: [0.6, 0.2, 0], radius: 0.2, radii: [0.06, 0.18, 0.12] }),
        call("add_shape", { shape: "blob", mode: "add", center: [0, 0, 0], radius: 0.2 }),
        call("add_shape", { shape: "sphere", mode: "subtract", center: [0.22, 0.1, 0.7], radius: 0.14, blend: 9 }),
        call("sculpt_form", { op: "pull", center: [0, 0, 1], radius: 0.3, amount: 0.2, direction: [0, 0, 1] }),
        call("sculpt_global", { op: "scale", scale: [0.8, 1.2, 9] }),
        call("sculpt_global", { op: "scale" }),
        call("sculpt_global", { op: "spherize", amount: 0.8 }),
        call("remesh", {}),
      ],
      "lead",
      false,
    );
    expect(out.actions.map((a) => a.kind)).toEqual(["shape", "shape", "form", "global", "global", "remesh"]);
    const carve = out.actions[1];
    if (carve.kind !== "shape") throw new Error("expected a shape");
    expect(carve.mode).toBe("subtract");
    expect(carve.blend).toBe(0.4);
    const scale = out.actions[3];
    if (scale.kind !== "global") throw new Error("expected a global op");
    expect(scale.scale).toEqual([0.8, 1.2, 2]);
  });

  it("records the critique, prediction, target and done", () => {
    const out = parseSteps(
      [
        call("assess", { observations: "a ball", last_turn_verdict: "nose landed", discrepancies: ["ears missing"], expected_change: "ears appear at x=±0.6", stage: "primary" }),
        call("set_target", { description: "an owl", milestones: [{ text: "body egg", done: true }, { text: "ear tufts", done: false }] }),
        call("declare_done", { summary: "The owl is finished." }),
      ],
      "lead",
      false,
    );
    expect(out.expected).toBe("ears appear at x=±0.6");
    expect(out.assessment).toContain("ears missing");
    expect(out.target?.milestones).toHaveLength(2);
    expect(out.done).toBe("The owl is finished.");
    expect(out.say).toBe("The owl is finished.");
    expect(parseSteps([call("declare_done", { summary: "x" })], "follow", false).done).toBeUndefined();
  });

  it("collects say, intent and skills", () => {
    const out = parseSteps(
      [
        call("say", { text: "Rounding the corners." }),
        call("update_intent", { summary: "a head", confidence: 1.4, plan: ["round", "eyes"] }),
        call("use_skill", { name: "head" }),
        call("use_skill", { name: "nonexistent" }),
      ],
      "follow",
      true,
    );
    expect(out.say).toBe("Rounding the corners.");
    expect(out.intent?.confidence).toBe(1);
    expect(out.plan).toEqual(["round", "eyes"]);
    expect(out.skills).toEqual(["head"]);
  });
});

describe("buildRequestBody", () => {
  const request = (frames: number): TurnRequest => ({
    sessionId: "session-1234",
    trigger: "human",
    mode: "lead",
    message: "make a head",
    observation: {
      sheet: "x".repeat(200),
      thumb: "y".repeat(100),
      geometry: {
        vertices: 1, triangles: 1, bboxMin: [-1, -1, -1], bboxMax: [1, 1, 1], meanRadius: 1.2, displacementFromCube: 0, hotspots: [], symmetryError: 0,
        slices: [{ y: 0, x: [-1, 1], z: [-1, 1], n: 10 }], half: 1.25,
      },
      strokes: [],
      idleSeconds: 3,
      activeBrush: { brush: "draw", radius: 0.2, strength: 0.5, symmetry: true },
    },
  });

  it("sends the recent frames at low resolution, oldest first, then the current sheet", () => {
    const state = emptyState(0);
    state.frames = [1, 2, 3].map((t) => ({ t: t * 1000, thumb: `thumb${t}`, human: "nothing", did: [`add sphere ${t}`], expected: `bump ${t}`, verdict: t < 3 ? `landed ${t}` : undefined }));
    const { body } = buildRequestBody(request(3), state, 10_000);
    expect(body.generation_config.thinking_level).toBe("high");
    const text = JSON.stringify(body.input);
    // Each step pairs the frame with the exact actions, the prediction and the later verdict.
    expect(text).toContain("STEP -3");
    expect(text).toContain("you then did: add sphere 1");
    expect(text).toContain("you predicted: bump 2");
    expect(text).toContain("your verdict on seeing the result: landed 1");
    const content = (body.input[0] as unknown as { content: { type: string; data?: string; resolution?: string }[] }).content;
    const images = content.filter((c) => c.type === "image");
    expect(images.map((i) => i.data)).toEqual(["thumb1", "thumb2", "thumb3", "x".repeat(200)]);
    expect(images.slice(0, 3).every((i) => i.resolution === "low")).toBe(true);
    expect(body.generation_config.tool_choice).toBe("any");
  });

  it("loads skills triggered by the human's words", () => {
    const { skills } = buildRequestBody(request(0), emptyState(0), 0);
    expect(skills.map((s) => s.name)).toContain("head");
  });
});

describe("describeAction", () => {
  it("keeps the numbers needed to attribute an effect", () => {
    expect(describeAction({ kind: "shape", id: "a1", shape: "ellipsoid", mode: "add", center: [0.6, 0.2, 0], radius: 0.2, radii: [0.06, 0.18, 0.12], blend: 0.12, symmetry: true, why: "" })).toBe(
      "add ellipsoid at (0.60,0.20,0.00) r=0.20 radii=(0.06,0.18,0.12) sym",
    );
    expect(describeAction({ kind: "form", id: "a2", op: "pull", center: [0, 0, 1], radius: 0.3, amount: 0.2, direction: [0, 0, 1], symmetry: false, why: "" })).toBe(
      "pull at (0.00,0.00,1.00) r=0.30 amt=0.20 dir=(0.00,0.00,1.00)",
    );
    expect(describeAction({ kind: "global", id: "a3", op: "scale", amount: 0.5, scale: [0.8, 1.2, 1], why: "" })).toBe("scale (0.80,1.20,1.00)");
  });
});

describe("selectSkills", () => {
  it("never loads more than the cap plus one triggered skill", () => {
    const chosen = selectSkills(["blockout", "cleanup"], "smooth the head of the dragon creature with sharp edges");
    expect(chosen.length).toBeLessThanOrEqual(MAX_ACTIVE_SKILLS + 1);
  });
});
