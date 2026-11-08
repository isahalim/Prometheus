/**
 * Voxel remesh with primitives — Prometheus's DynaMesh / Blender Voxel Remesh.
 *
 * 1. The current surface becomes a signed distance field on an N^3 grid:
 *    inside/outside from ray parity along +Y columns (one BVH ray per
 *    column), exact distance from BVH closest-point queries in a narrow
 *    band around the surface, clamped elsewhere.
 * 2. Primitives are blended in with a smooth union (added clay) or smooth
 *    subtraction (carved), so new mass grows out of the model instead of
 *    floating beside it.
 * 3. Marching cubes (three's addon) rebuilds an even, watertight surface,
 *    vertices are welded, and a few Taubin passes take off the voxel steps.
 *
 * Besides adding mass, this resets topology, so a heavily stretched area gets
 * fresh, evenly spaced vertices to sculpt with.
 */
import * as THREE from "three";
import { MarchingCubes } from "three/addons/objects/MarchingCubes.js";
import type { ShapeKind } from "../../shared/protocol.ts";
import type { SculptMesh } from "./mesh.ts";

export type V3 = [number, number, number];

export interface ShapeSpec {
  shape: ShapeKind;
  center: V3;
  /** Sphere/torus major radius, cylinder/cone/capsule radius. */
  radius: number;
  /** Ellipsoid and box half-sizes. */
  radii?: V3;
  /** Capsule second end; cylinder/cone/torus axis is `axis`. */
  end?: V3;
  axis?: V3;
  /** Torus tube radius, cylinder/cone half-height. */
  minor?: number;
  mode: "add" | "subtract";
  /** Smooth-blend width in model units (0 = hard union). */
  blend: number;
}

export const DEFAULT_RESOLUTION = 96;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Rotates p into a frame whose +Y is `axis` (for cylinder, cone, torus). */
function toAxisFrame(p: V3, axis: V3): V3 {
  const y = norm(axis);
  const helper: V3 = Math.abs(y[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  let x: V3 = [helper[1] * y[2] - helper[2] * y[1], helper[2] * y[0] - helper[0] * y[2], helper[0] * y[1] - helper[1] * y[0]];
  x = norm(x);
  const z: V3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return [dot(p, x), dot(p, y), dot(p, z)];
}

/** Signed distance (negative inside) for one primitive. */
export function shapeDistance(s: ShapeSpec, p: V3): number {
  const q = sub(p, s.center);
  switch (s.shape) {
    case "sphere":
      return len(q) - s.radius;
    case "ellipsoid": {
      // Inigo Quilez's bound-corrected ellipsoid approximation.
      const r = s.radii ?? [s.radius, s.radius, s.radius];
      const k0 = len([q[0] / r[0], q[1] / r[1], q[2] / r[2]]);
      const k1 = len([q[0] / (r[0] * r[0]), q[1] / (r[1] * r[1]), q[2] / (r[2] * r[2])]);
      return k1 === 0 ? -Math.min(...r) : (k0 * (k0 - 1)) / k1;
    }
    case "box": {
      const r = s.radii ?? [s.radius, s.radius, s.radius];
      const round = Math.min(0.06, Math.min(...r) * 0.3);
      const d: V3 = [Math.abs(q[0]) - r[0] + round, Math.abs(q[1]) - r[1] + round, Math.abs(q[2]) - r[2] + round];
      const outside = len([Math.max(d[0], 0), Math.max(d[1], 0), Math.max(d[2], 0)]);
      return outside + Math.min(Math.max(d[0], d[1], d[2]), 0) - round;
    }
    case "capsule": {
      const a = s.center, b = s.end ?? [s.center[0], s.center[1] + s.radius * 2, s.center[2]];
      const pa = sub(p, a), ba = sub(b, a);
      const h = Math.min(1, Math.max(0, dot(pa, ba) / Math.max(dot(ba, ba), 1e-9)));
      return len([pa[0] - ba[0] * h, pa[1] - ba[1] * h, pa[2] - ba[2] * h]) - s.radius;
    }
    case "cylinder": {
      const l = toAxisFrame(q, s.axis ?? [0, 1, 0]);
      const half = s.minor ?? s.radius;
      const d = [Math.hypot(l[0], l[2]) - s.radius, Math.abs(l[1]) - half];
      return Math.min(Math.max(d[0], d[1]), 0) + Math.hypot(Math.max(d[0], 0), Math.max(d[1], 0));
    }
    case "cone": {
      // Capped cone: base radius `radius` at -half, tip at +half along the axis.
      const l = toAxisFrame(q, s.axis ?? [0, 1, 0]);
      const half = s.minor ?? s.radius;
      const t = Math.min(1, Math.max(0, (l[1] + half) / (2 * half)));
      const r = s.radius * (1 - t);
      const radial = Math.hypot(l[0], l[2]) - r;
      const cap = Math.abs(l[1]) - half;
      const slope = s.radius / (2 * half);
      return Math.max(radial / Math.sqrt(1 + slope * slope), cap);
    }
    case "torus": {
      const l = toAxisFrame(q, s.axis ?? [0, 1, 0]);
      const ring = Math.hypot(l[0], l[2]) - s.radius;
      return Math.hypot(ring, l[1]) - (s.minor ?? s.radius * 0.3);
    }
  }
}

function smoothUnion(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function smoothSubtract(a: number, b: number, k: number): number {
  // Carve b out of a.
  return -smoothUnion(-a, b, k);
}

function shapeBounds(s: ShapeSpec): number {
  const reach = Math.max(s.radius, ...(s.radii ?? [0]), s.minor ?? 0) + s.blend;
  const extra = s.end ? len(sub(s.end, s.center)) : 0;
  return Math.max(...s.center.map(Math.abs)) + reach + extra + (s.shape === "torus" ? s.radius : 0);
}

export interface RemeshResult {
  positions: Float32Array;
  index: Uint32Array;
  ms: number;
}

export function remesh(mesh: SculptMesh, shapes: ShapeSpec[], resolution = DEFAULT_RESOLUTION): RemeshResult {
  const started = performance.now();
  const N = resolution;
  const p = mesh.positions;

  // A cube domain centred on the origin, so X symmetry survives the remesh.
  let reach = 0;
  for (let i = 0; i < p.length; i++) reach = Math.max(reach, Math.abs(p[i]));
  for (const s of shapes) if (s.mode === "add") reach = Math.max(reach, shapeBounds(s));
  const D = Math.min(4, reach * 1.08 + 0.12) * (N / (N - 6)); // MC skips the outer cells
  const h = (2 * D) / N;
  const coord = (i: number) => (i - N / 2) * h;
  const N2 = N * N;
  const sdf = new Float32Array(N * N2);
  const inside = new Uint8Array(N * N2);
  const far = 3 * h;

  // 1. Inside/outside by ray parity along +Y, one ray per (x, z) column.
  const ray = new THREE.Ray();
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      ray.origin.set(coord(x) + h * 1e-3, -D - 1, coord(z) + h * 1.7e-3); // tiny offsets dodge edge-on hits
      ray.direction.set(0, 1, 0);
      const hits = mesh.bvh.raycast(ray, THREE.DoubleSide).map((hit) => hit.point.y).sort((a, b) => a - b);
      const ys: number[] = [];
      for (const y of hits) if (ys.length === 0 || y - ys[ys.length - 1] > 1e-6) ys.push(y);
      let k = 0;
      for (let y = 0; y < N; y++) {
        const wy = coord(y);
        while (k < ys.length && ys[k] < wy) k++;
        const idx = z * N2 + y * N + x;
        inside[idx] = k % 2;
        sdf[idx] = inside[idx] ? -far : far;
      }
    }
  }

  // 2. Exact distance in a two-cell band around the surface.
  const band = new Uint8Array(N * N2);
  for (let z = 1; z < N - 1; z++) {
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const idx = z * N2 + y * N + x;
        const v = inside[idx];
        if (v !== inside[idx + 1] || v !== inside[idx - 1] || v !== inside[idx + N] || v !== inside[idx - N] || v !== inside[idx + N2] || v !== inside[idx - N2]) {
          for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) band[idx + dz * N2 + dy * N + dx] = 1;
        }
      }
    }
  }
  const point = new THREE.Vector3();
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 } as { point: THREE.Vector3; distance: number; faceIndex: number };
  for (let idx = 0; idx < band.length; idx++) {
    if (!band[idx]) continue;
    const x = idx % N, y = Math.floor(idx / N) % N, z = Math.floor(idx / N2);
    point.set(coord(x), coord(y), coord(z));
    const hit = mesh.bvh.closestPointToPoint(point, target as never, 0, far);
    if (hit) sdf[idx] = Math.min(far, hit.distance) * (inside[idx] ? -1 : 1);
  }

  // 3. Blend the primitives in.
  for (const s of shapes) {
    const k = Math.max(0, s.blend);
    const r = shapeBounds(s) + h * 2;
    const lo = (v: number) => Math.max(0, Math.floor((v - r) / h + N / 2));
    const hi = (v: number) => Math.min(N - 1, Math.ceil((v + r) / h + N / 2));
    // Bounding box in grid space (shape centre ± reach, generous for capsules and tori).
    const cx = s.center[0], cy = s.center[1], cz = s.center[2];
    const ex = s.end ?? s.center;
    const [x0, x1] = [lo(Math.min(cx, ex[0])), hi(Math.max(cx, ex[0]))];
    const [y0, y1] = [lo(Math.min(cy, ex[1])), hi(Math.max(cy, ex[1]))];
    const [z0, z1] = [lo(Math.min(cz, ex[2])), hi(Math.max(cz, ex[2]))];
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const idx = z * N2 + y * N + x;
          const d = shapeDistance(s, [coord(x), coord(y), coord(z)]);
          sdf[idx] = s.mode === "add" ? smoothUnion(sdf[idx], d, k) : smoothSubtract(sdf[idx], d, k);
        }
      }
    }
  }

  // 4. Marching cubes: the addon wants "inside" as field > isolation.
  const mc = new MarchingCubes(N, new THREE.MeshBasicMaterial(), false, false, 600_000);
  for (let i = 0; i < sdf.length; i++) mc.field[i] = -sdf[i];
  mc.isolation = 0;
  mc.update();
  const vertexCount = mc.count;
  const raw = mc.positionArray;

  // 5. Weld identical vertices (marching cubes emits a triangle soup).
  const quant = h * 1e-3;
  const map = new Map<string, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  for (let v = 0; v < vertexCount; v++) {
    const x = raw[v * 3] * D, y = raw[v * 3 + 1] * D, z = raw[v * 3 + 2] * D;
    const key = `${Math.round(x / quant)},${Math.round(y / quant)},${Math.round(z / quant)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = pos.length / 3;
      map.set(key, id);
      pos.push(x, y, z);
    }
    idx.push(id);
  }
  const tris: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  const positions = new Float32Array(pos);
  const index = new Uint32Array(tris);
  mc.geometry.dispose();

  // 6. Outward winding: flip everything if the signed volume is negative.
  let volume = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    volume +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  if (volume < 0) for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];

  taubin(positions, index, 3);
  return { positions, index, ms: Math.round(performance.now() - started) };
}

/** Taubin smoothing (lambda/mu): takes off voxel steps without shrinking the form. */
function taubin(positions: Float32Array, index: Uint32Array, iterations: number) {
  const n = positions.length / 3;
  const neighbors: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    neighbors[a].add(b).add(c);
    neighbors[b].add(a).add(c);
    neighbors[c].add(a).add(b);
  }
  const lists = neighbors.map((s) => [...s]);
  const tmp = new Float32Array(positions.length);
  const step = (factor: number) => {
    for (let v = 0; v < n; v++) {
      const list = lists[v];
      if (list.length === 0) {
        tmp[v * 3] = positions[v * 3]; tmp[v * 3 + 1] = positions[v * 3 + 1]; tmp[v * 3 + 2] = positions[v * 3 + 2];
        continue;
      }
      let x = 0, y = 0, z = 0;
      for (const u of list) { x += positions[u * 3]; y += positions[u * 3 + 1]; z += positions[u * 3 + 2]; }
      const c = list.length;
      tmp[v * 3] = positions[v * 3] + (x / c - positions[v * 3]) * factor;
      tmp[v * 3 + 1] = positions[v * 3 + 1] + (y / c - positions[v * 3 + 1]) * factor;
      tmp[v * 3 + 2] = positions[v * 3 + 2] + (z / c - positions[v * 3 + 2]) * factor;
    }
    positions.set(tmp);
  };
  for (let i = 0; i < iterations; i++) {
    step(0.5);
    step(-0.53);
  }
}
