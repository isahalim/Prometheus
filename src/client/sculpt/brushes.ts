/**
 * Brushes, after Blender's sculpt mode: same names, same idea of a radius in
 * world units, a strength, a smooth falloff and Ctrl-to-invert. The maths is
 * written fresh (Blender is GPL; only the conventions are borrowed).
 *
 * Every dab is brute force over all vertices — at ~38K vertices that is a
 * fraction of a millisecond, simpler and more robust than keeping a spatial
 * index in sync with a moving surface.
 */
import type { BrushName, FormOp } from "../../shared/protocol.ts";
import type { SculptMesh } from "./mesh.ts";

export type Vec3 = [number, number, number];

export interface DabParams {
  brush: Exclude<BrushName, "grab">;
  center: Vec3;
  radius: number;
  strength: number;
  invert: boolean;
}

/** Blender's "Smooth" falloff curve: 3t^2 - 2t^3 on t = 1 - d/r. */
const falloff = (d: number, r: number) => {
  const t = 1 - d / r;
  return t <= 0 ? 0 : t * t * (3 - 2 * t);
};

interface Footprint {
  indices: number[];
  weights: number[];
  /** Falloff-weighted average normal and position of the footprint. */
  normal: Vec3;
  centroid: Vec3;
}

function footprint(mesh: SculptMesh, center: Vec3, radius: number): Footprint {
  const p = mesh.positions, nrm = mesh.normals;
  const r2 = radius * radius;
  const indices: number[] = [];
  const weights: number[] = [];
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, wsum = 0;
  for (let i = 0, o = 0; i < mesh.vertexCount; i++, o += 3) {
    const dx = p[o] - center[0], dy = p[o + 1] - center[1], dz = p[o + 2] - center[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;
    const w = falloff(Math.sqrt(d2), radius);
    if (w <= 0) continue;
    indices.push(i);
    weights.push(w);
    nx += nrm[o] * w; ny += nrm[o + 1] * w; nz += nrm[o + 2] * w;
    cx += p[o] * w; cy += p[o + 1] * w; cz += p[o + 2] * w;
    wsum += w;
  }
  const nl = Math.hypot(nx, ny, nz) || 1;
  const ws = wsum || 1;
  return { indices, weights, normal: [nx / nl, ny / nl, nz / nl], centroid: [cx / ws, cy / ws, cz / ws] };
}

/** Applies one dab; returns the vertices it moved. */
export function applyDab(mesh: SculptMesh, dab: DabParams): number[] {
  const fp = footprint(mesh, dab.center, dab.radius);
  if (fp.indices.length === 0) return fp.indices;
  const p = mesh.positions, nrm = mesh.normals;
  const sign = dab.invert ? -1 : 1;
  const s = dab.strength;
  const r = dab.radius;
  const [nx, ny, nz] = fp.normal;

  switch (dab.brush) {
    case "draw": {
      const amount = sign * s * r * 0.22;
      fp.indices.forEach((v, k) => {
        const w = fp.weights[k] * amount;
        p[v * 3] += nx * w; p[v * 3 + 1] += ny * w; p[v * 3 + 2] += nz * w;
      });
      break;
    }
    case "inflate": {
      const amount = sign * s * r * 0.14;
      fp.indices.forEach((v, k) => {
        const w = fp.weights[k] * amount;
        p[v * 3] += nrm[v * 3] * w; p[v * 3 + 1] += nrm[v * 3 + 1] * w; p[v * 3 + 2] += nrm[v * 3 + 2] * w;
      });
      break;
    }
    case "clay":
    case "flatten": {
      // Plane through the footprint; clay lifts that plane a little first, so it builds up in layers.
      const lift = dab.brush === "clay" ? sign * r * 0.2 * s : 0;
      const px = fp.centroid[0] + nx * lift, py = fp.centroid[1] + ny * lift, pz = fp.centroid[2] + nz * lift;
      const k0 = dab.brush === "clay" ? 0.35 : 0.3;
      fp.indices.forEach((v, k) => {
        const o = v * 3;
        const d = (p[o] - px) * nx + (p[o + 1] - py) * ny + (p[o + 2] - pz) * nz;
        // Clay only fills (moves points below the plane up, or above it down when inverted); flatten goes both ways.
        if (dab.brush === "clay" && d * sign > 0) return;
        const w = fp.weights[k] * s * k0;
        p[o] -= nx * d * w; p[o + 1] -= ny * d * w; p[o + 2] -= nz * d * w;
      });
      break;
    }
    case "smooth": {
      const targets = new Float32Array(fp.indices.length * 3);
      fp.indices.forEach((v, k) => {
        let ax = 0, ay = 0, az = 0;
        const a = mesh.neighborStart[v], b = mesh.neighborStart[v + 1];
        for (let j = a; j < b; j++) {
          const q = mesh.neighbors[j] * 3;
          ax += p[q]; ay += p[q + 1]; az += p[q + 2];
        }
        const c = b - a || 1;
        targets[k * 3] = ax / c; targets[k * 3 + 1] = ay / c; targets[k * 3 + 2] = az / c;
      });
      fp.indices.forEach((v, k) => {
        const w = Math.min(1, fp.weights[k] * s * 0.9);
        const o = v * 3;
        p[o] += (targets[k * 3] - p[o]) * w;
        p[o + 1] += (targets[k * 3 + 1] - p[o + 1]) * w;
        p[o + 2] += (targets[k * 3 + 2] - p[o + 2]) * w;
      });
      break;
    }
    case "pinch":
    case "crease": {
      // Pull toward the dab centre in the tangent plane; crease also cuts a groove.
      const pull = sign * s * (dab.brush === "crease" ? 0.18 : 0.25);
      const dig = dab.brush === "crease" ? -sign * s * r * 0.18 : 0;
      fp.indices.forEach((v, k) => {
        const o = v * 3;
        let dx = dab.center[0] - p[o], dy = dab.center[1] - p[o + 1], dz = dab.center[2] - p[o + 2];
        const dn = dx * nx + dy * ny + dz * nz;
        dx -= nx * dn; dy -= ny * dn; dz -= nz * dn;
        const w = fp.weights[k];
        const crease = dab.brush === "crease" ? w * w : w;
        p[o] += dx * w * pull + nx * dig * crease;
        p[o + 1] += dy * w * pull + ny * dig * crease;
        p[o + 2] += dz * w * pull + nz * dig * crease;
      });
      break;
    }
  }
  return fp.indices;
}

/** Grab: captures a footprint once, then drags it rigidly-with-falloff by each delta. */
export class Grab {
  private readonly indices: number[];
  private readonly weights: number[];
  constructor(private readonly mesh: SculptMesh, center: Vec3, radius: number, strength: number) {
    const fp = footprint(mesh, center, radius);
    this.indices = fp.indices;
    this.weights = fp.weights.map((w) => w * Math.min(1, 0.4 + strength * 0.6));
  }
  move(delta: Vec3): number[] {
    const p = this.mesh.positions;
    this.indices.forEach((v, k) => {
      const w = this.weights[k];
      p[v * 3] += delta[0] * w; p[v * 3 + 1] += delta[1] * w; p[v * 3 + 2] += delta[2] * w;
    });
    return this.indices;
  }
}

export const mirrorX = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];

// ---------- the agent's 3D-addressed operations ----------


/**
 * One form operation at a 3D surface point. `amount` is model units of
 * displacement at the centre for add/carve/pull/push, and 0..1 intensity for
 * the rest (applied as repeated full-strength dabs).
 */
export function applyForm(mesh: SculptMesh, op: FormOp, center: Vec3, radius: number, amount: number, direction?: Vec3): number[] {
  if (op === "flatten" || op === "smooth" || op === "inflate" || op === "pinch") {
    const passes = Math.max(1, Math.round(amount * 6));
    const touched = new Set<number>();
    for (let i = 0; i < passes; i++) for (const v of applyDab(mesh, { brush: op, center, radius, strength: 1, invert: false })) touched.add(v);
    return [...touched];
  }
  const fp = footprint(mesh, center, radius);
  let d: Vec3 = fp.normal;
  if ((op === "pull" || op === "push") && direction) {
    const l = Math.hypot(...direction) || 1;
    d = [direction[0] / l, direction[1] / l, direction[2] / l];
  }
  const sign = op === "carve" || op === "push" ? -1 : 1;
  const p = mesh.positions;
  fp.indices.forEach((v, k) => {
    const w = fp.weights[k] * amount * sign;
    p[v * 3] += d[0] * w; p[v * 3 + 1] += d[1] * w; p[v * 3 + 2] += d[2] * w;
  });
  return fp.indices;
}

/** Target positions for a whole-model blend (spherize / inflate / scale), to be eased toward. */
export function globalTarget(mesh: SculptMesh, op: "spherize" | "inflate" | "scale", amount: number, scale?: Vec3): Float32Array {
  const p = mesh.positions, n = mesh.normals;
  const out = p.slice();
  let cx = 0, cy = 0, cz = 0;
  for (let v = 0; v < mesh.vertexCount; v++) { cx += p[v * 3]; cy += p[v * 3 + 1]; cz += p[v * 3 + 2]; }
  cx /= mesh.vertexCount; cy /= mesh.vertexCount; cz /= mesh.vertexCount;
  let mean = 0;
  for (let v = 0; v < mesh.vertexCount; v++) mean += Math.hypot(p[v * 3] - cx, p[v * 3 + 1] - cy, p[v * 3 + 2] - cz);
  mean /= mesh.vertexCount;
  for (let v = 0; v < mesh.vertexCount; v++) {
    const o = v * 3;
    if (op === "spherize") {
      const dx = p[o] - cx, dy = p[o + 1] - cy, dz = p[o + 2] - cz;
      const l = Math.hypot(dx, dy, dz) || 1;
      out[o] = p[o] + (cx + (dx / l) * mean - p[o]) * amount;
      out[o + 1] = p[o + 1] + (cy + (dy / l) * mean - p[o + 1]) * amount;
      out[o + 2] = p[o + 2] + (cz + (dz / l) * mean - p[o + 2]) * amount;
    } else if (op === "inflate") {
      const k = amount * 0.25 * mean;
      out[o] = p[o] + n[o] * k; out[o + 1] = p[o + 1] + n[o + 1] * k; out[o + 2] = p[o + 2] + n[o + 2] * k;
    } else {
      const s = scale ?? [1, 1, 1];
      out[o] = p[o] * s[0]; out[o + 1] = p[o + 1] * s[1]; out[o + 2] = p[o + 2] * s[2];
    }
  }
  return out;
}

/** Whole-model Laplacian smoothing, `iterations` passes at half strength. */
export function smoothAll(mesh: SculptMesh, iterations: number) {
  const p = mesh.positions;
  const tmp = new Float32Array(p.length);
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < mesh.vertexCount; v++) {
      const a = mesh.neighborStart[v], b = mesh.neighborStart[v + 1];
      let x = 0, y = 0, z = 0;
      for (let j = a; j < b; j++) { const q = mesh.neighbors[j] * 3; x += p[q]; y += p[q + 1]; z += p[q + 2]; }
      const c = b - a || 1;
      tmp[v * 3] = p[v * 3] + (x / c - p[v * 3]) * 0.5;
      tmp[v * 3 + 1] = p[v * 3 + 1] + (y / c - p[v * 3 + 1]) * 0.5;
      tmp[v * 3 + 2] = p[v * 3 + 2] + (z / c - p[v * 3 + 2]) * 0.5;
    }
    p.set(tmp);
  }
}
