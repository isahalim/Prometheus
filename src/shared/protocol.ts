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
  /** Long-term memory: one consolidated text block, rewritten, never appended. */
  longTermChars: 1200,
  /** Working notes the agent keeps for itself within a session. */
  workingNotes: 6,
  workingNoteChars: 200,
  /** Recent frames (multi-view sheets) the agent sees besides the current one. */
  recentFrames: 3,
  /** Raw stroke summaries per observation. */
  strokesPerObservation: 24,
  chatChars: 600,
  /** Base64 length caps: ~150 KB for the sheet, ~40 KB for a frame thumbnail. */
  sheetB64: 200_000,
  thumbB64: 56_000,
  /** Actions applied from one agent turn. */
  actionsPerTurn: 8,
  pointsPerStroke: 24,
} as const;

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
  why: string;
}

export type AgentAction = StrokeAction;

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
  actions: AgentAction[];
  activeSkills: string[];
  memory: { longTerm: string; notes: string[] };
  budget?: BudgetStatus;
  latencyMs?: number;
  tokens?: number;
}
