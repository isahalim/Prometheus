/**
 * The wire contract between the studio (browser) and the agent (Worker).
 *
 * Sculptures never cross this boundary as geometry to be stored: the browser
 * sends *pictures* of the model plus a compact geometric summary, the agent
 * answers with *actions* the browser performs on its own mesh.
 */

/** The six panels of every contact sheet, in sheet order (3 columns x 2 rows). */
export const VIEWS = ["front", "right", "back", "left", "top", "three_quarter"] as const;
export type ViewName = (typeof VIEWS)[number];

export const BRUSHES = ["draw", "clay", "inflate", "smooth", "flatten", "pinch", "crease", "grab"] as const;
export type BrushName = (typeof BRUSHES)[number];

/** Caps that keep a request inside the token budget whatever the client sends. */
export const LIMITS = {
  /** Recent frames (multi-view sheets) the agent sees besides the current one, by mode. */
  recentFrames: 5,
  recentFramesByMode: { lead: 5, follow: 3, watch: 3 },
  /** Raw stroke summaries per observation. */
  strokesPerObservation: 24,
  chatChars: 600,
  /** Base64 length caps: the lead sheet is 960x640, ~250 KB as JPEG. */
  sheetB64: 640_000,
  thumbB64: 64_000,
  /** Actions applied from one agent turn, by mode — lead owns the sculpture and may do a lot. */
  actionsByMode: { lead: 24, follow: 10, watch: 6 },
  actionsPerTurn: 24,
  pointsPerStroke: 48,
  milestones: 8,
} as const;

/** Sheet panel size in pixels, by mode: the lead agent gets the sharpest look. */
export const PANEL_PX = { lead: 320, follow: 256, watch: 256 } as const;

/** One human (or agent) stroke, summarised for intent inference. */
export interface StrokeSummary {
  by: "human" | "agent";
  brush: BrushName;
  invert: boolean;
  /** Object-space centroid of the stroke, model units (cube spans -1..1). */
  center: [number, number, number];
  /** Start and end, object space. */
  from: [number, number, number];
  to: [number, number, number];
  radius: number;
  strength: number;
  dabs: number;
  symmetry: boolean;
  /** Seconds since the session started. */
  t: number;
}

export interface GeometrySummary {
  vertices: number;
  triangles: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  /** Mean distance of vertices from origin; and how far the shape is from the start cube. */
  meanRadius: number;
  displacementFromCube: number;
  /** Regions (object space) that changed most since the last observation, largest first. */
  hotspots: { center: [number, number, number]; magnitude: number }[];
  symmetryError: number;
  /**
   * The form as numbers, so proportions don't have to be read off pixels:
   * nine horizontal slices from bottom to top, each with its X (width) and
   * Z (depth) extent and how many vertices fall in it.
   */
  slices: { y: number; x: [number, number]; z: [number, number]; n: number }[];
  /** Panel half-extent of the orthographic views in this capture (model units). */
  half: number;
}

export interface Observation {
  /** JPEG base64 (no data: prefix) — 3x2 sheet of VIEWS, 768x512, with a labelled 4x4 grid on each panel. */
  sheet: string;
  /** JPEG base64 — the same sheet at 384x256, kept by the server as short-term memory. */
  thumb: string;
  geometry: GeometrySummary;
  strokes: StrokeSummary[];
  /** Seconds since the human last touched the model. */
  idleSeconds: number;
  activeBrush: { brush: BrushName; radius: number; strength: number; symmetry: boolean };
}

export type AgentMode = "lead" | "follow" | "watch";

export interface TurnRequest {
  sessionId: string;
  trigger: "human" | "ambient";
  message?: string;
  mode: AgentMode;
  observation: Observation;
  /** Outcome of the previous turn's actions, so the agent can tell what landed. */
  lastResults?: ActionResult[];
}

export interface StrokeAction {
  kind: "stroke";
  id: string;
  brush: BrushName;
  view: ViewName;
  /** Points in the named panel, normalised 0..1, origin top-left. */
  points: [number, number][];
  radius: number;
  strength: number;
  invert: boolean;
  symmetry: boolean;
  /** Apply the stroke this many times (1-4) for a stronger effect. */
  passes: number;
  why: string;
}

/**
 * A form operation addressed directly in 3D object space — the agent's
 * "Move brush". The centre snaps to the nearest surface point.
 */
export const FORM_OPS = ["add", "carve", "pull", "push", "flatten", "smooth", "inflate", "pinch"] as const;
export type FormOp = (typeof FORM_OPS)[number];

export interface FormAction {
  kind: "form";
  id: string;
  op: FormOp;
  center: [number, number, number];
  radius: number;
  /** Model units of displacement at the centre (pull/push/add/carve), or 0..1 strength for the others. */
  amount: number;
  /** For pull/push: the direction to move the surface, object space (normalised on apply). */
  direction?: [number, number, number];
  symmetry: boolean;
  why: string;
}

/** Whole-model operations for the big early moves (a cube becoming an egg). */
export const GLOBAL_OPS = ["spherize", "smooth", "inflate", "scale"] as const;
export type GlobalOp = (typeof GLOBAL_OPS)[number];

export interface GlobalAction {
  kind: "global";
  id: string;
  op: GlobalOp;
  /** 0..1 blend for spherize/smooth/inflate. */
  amount: number;
  /** For scale: per-axis factors (0.5..2). */
  scale?: [number, number, number];
  why: string;
}

/** Primitives that can be blended into (or carved out of) the clay via a voxel remesh. */
export const SHAPES = ["sphere", "ellipsoid", "capsule", "box", "cylinder", "cone", "torus"] as const;
export type ShapeKind = (typeof SHAPES)[number];

export interface ShapeAction {
  kind: "shape";
  id: string;
  shape: ShapeKind;
  mode: "add" | "subtract";
  center: [number, number, number];
  radius: number;
  radii?: [number, number, number];
  end?: [number, number, number];
  axis?: [number, number, number];
  minor?: number;
  blend: number;
  /** Also place the X-mirrored copy (skipped when the centre is on x = 0). */
  symmetry: boolean;
  why: string;
}

/** Rebuild the surface with even topology (no new mass). */
export interface RemeshAction {
  kind: "remesh";
  id: string;
  why: string;
}

export type AgentAction = StrokeAction | FormAction | GlobalAction | ShapeAction | RemeshAction;

export interface ActionResult {
  id: string;
  ok: boolean;
  /** Fraction of points that hit the surface. */
  hitRatio: number;
  note?: string;
}

export interface BudgetStatus {
  model: string;
  rpmTarget: number;
  rpmLimit: number;
  usedLastMinute: number;
  tokensLastMinute: number;
  tpmLimit: number;
  usedToday: number;
  rpdLimit: number;
  reserve: number;
  /** ms until the next free slot on the shared Gemini lane. */
  nextSlotInMs: number;
  cooldownMs: number;
  resetsAt: string;
}

export interface TurnResponse {
  ok: boolean;
  error?: string;
  retryAfterMs?: number;
  say?: string;
  intent?: { summary: string; confidence: number; target?: string };
  plan?: string[];
  /** Lead mode: the sculpture's target and milestone checklist. */
  target?: string;
  milestones?: { text: string; done: boolean }[];
  /** The agent's own critique of this frame (shown in the UI, fed back next turn). */
  assessment?: string;
  /** Lead mode: the agent believes the sculpture is finished. */
  done?: boolean;
  actions: AgentAction[];
  activeSkills: string[];
  budget?: BudgetStatus;
  latencyMs?: number;
  tokens?: number;
}
