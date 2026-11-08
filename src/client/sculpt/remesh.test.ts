import { describe, expect, it } from "vitest";
import { SculptMesh } from "./mesh.ts";
import { remesh, shapeDistance } from "./remesh.ts";

const extent = (p: Float32Array, axis: number) => {
  let lo = Infinity, hi = -Infinity;
  for (let i = axis; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
  return [lo, hi];
};

describe("remesh", () => {
  const cube = SculptMesh.cube(24);

  it("rebuilds the cube as a closed surface of about the same size", () => {
    const out = remesh(cube, [], 48);
    expect(out.index.length).toBeGreaterThan(1000);
    const [lo, hi] = extent(out.positions, 0);
    expect(lo).toBeLessThan(-0.9);
    expect(hi).toBeGreaterThan(0.9);
    expect(hi).toBeLessThan(1.1);
  });

  it("adds mass where a primitive is blended in, on both sides when mirrored", () => {
    const left = { shape: "sphere" as const, center: [-1, 0, 0] as [number, number, number], radius: 0.5, mode: "add" as const, blend: 0.1 };
    const right = { ...left, center: [1, 0, 0] as [number, number, number] };
    const out = remesh(cube, [left, right], 64);
    const [lo, hi] = extent(out.positions, 0);
    expect(lo).toBeLessThan(-1.4);
    expect(hi).toBeGreaterThan(1.4);
  });

  it("carves with subtract", () => {
    const hole = { shape: "sphere" as const, center: [0, 0, 1] as [number, number, number], radius: 0.5, mode: "subtract" as const, blend: 0.05 };
    const out = remesh(cube, [hole], 64);
    // No vertex should remain near the original centre of the front face.
    let near = 0;
    for (let i = 0; i < out.positions.length; i += 3) {
      if (Math.hypot(out.positions[i], out.positions[i + 1], out.positions[i + 2] - 1) < 0.35) near++;
    }
    expect(near).toBe(0);
  });

  it("keeps outward winding", () => {
    const out = remesh(cube, [], 40);
    let volume = 0;
    const p = out.positions, t = out.index;
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
      volume += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    expect(volume / 6).toBeGreaterThan(6);
  });
});

describe("shapeDistance", () => {
  it("is negative inside and positive outside each primitive", () => {
    const base = { center: [0, 0, 0] as [number, number, number], radius: 0.5, mode: "add" as const, blend: 0 };
    for (const shape of ["sphere", "ellipsoid", "box", "capsule", "cylinder", "cone", "torus"] as const) {
      const s = { ...base, shape, radii: [0.5, 0.5, 0.5] as [number, number, number], minor: shape === "torus" ? 0.15 : 0.5 };
      const inside = shape === "torus" ? [0.5, 0, 0] : [0, shape === "capsule" ? 0.3 : 0, 0];
      expect(shapeDistance(s, inside as [number, number, number]), shape).toBeLessThan(0);
      expect(shapeDistance(s, [3, 3, 3]), shape).toBeGreaterThan(0);
    }
  });
});
