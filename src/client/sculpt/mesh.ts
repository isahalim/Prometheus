/**
 * The clay: Blender's default cube (2 units, centred, Y up), subdivided into a
 * welded grid so it can be pushed around without tearing at the edges.
 *
 * Topology never changes after creation (no dyntopo), so neighbours and
 * vertex->face incidence are built once into flat CSR arrays.
 */
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

export const CUBE_SUBDIVISIONS = 80;

export class SculptMesh {
  readonly geometry: THREE.BufferGeometry;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly rest: Float32Array;
  readonly index: Uint32Array;
  readonly vertexCount: number;
  readonly faceCount: number;
  readonly neighborStart: Uint32Array;
  readonly neighbors: Uint32Array;
  readonly faceStart: Uint32Array;
  readonly vertexFaces: Uint32Array;
  readonly faceNormals: Float32Array;
  /** For each vertex, the vertex at its X-mirrored rest position (the lattice is symmetric). */
  readonly mirror: Uint32Array;
  bvh: MeshBVH;
  /** Vertices touched since the last frame; normals + BVH are refreshed lazily. */
  private dirty = new Set<number>();
  private topologyDirty = false;

  constructor(subdivisions = CUBE_SUBDIVISIONS) {
    const { positions, index } = buildCube(subdivisions);
    this.positions = positions;
    this.rest = positions.slice();
    this.vertexCount = positions.length / 3;
    this.normals = new Float32Array(positions.length);

    // The BVH is built FIRST: three-mesh-bvh reorders the triangle index in
    // place for spatial locality, so every face-indexed table below has to be
    // derived from the order it leaves behind, not the order buildCube wrote.
    this.geometry = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(this.positions, 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    const nor = new THREE.BufferAttribute(this.normals, 3);
    nor.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", pos);
    this.geometry.setAttribute("normal", nor);
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.bvh = new MeshBVH(this.geometry, { maxLeafSize: 12 });
    this.geometry.boundsTree = this.bvh;
    this.index = this.geometry.index!.array as Uint32Array;
    this.faceCount = this.index.length / 3;
    this.faceNormals = new Float32Array(this.faceCount * 3);

    const lattice = (x: number) => Math.round(((x + 1) / 2) * subdivisions);
    const keyOf = (o: number, flip: boolean) =>
      ((flip ? subdivisions - lattice(positions[o]) : lattice(positions[o])) * (subdivisions + 1) + lattice(positions[o + 1])) * (subdivisions + 1) + lattice(positions[o + 2]);
    const byKey = new Map<number, number>();
    for (let v = 0; v < this.vertexCount; v++) byKey.set(keyOf(v * 3, false), v);
    this.mirror = new Uint32Array(this.vertexCount);
    for (let v = 0; v < this.vertexCount; v++) this.mirror[v] = byKey.get(keyOf(v * 3, true)) ?? v;

    // vertex -> faces
    const idx = this.index;
    const faceCounts = new Uint32Array(this.vertexCount + 1);
    for (const v of idx) faceCounts[v + 1]++;
    for (let i = 0; i < this.vertexCount; i++) faceCounts[i + 1] += faceCounts[i];
    this.faceStart = faceCounts.slice();
    this.vertexFaces = new Uint32Array(idx.length);
    const fill = faceCounts.slice();
    for (let f = 0; f < this.faceCount; f++) for (let k = 0; k < 3; k++) this.vertexFaces[fill[idx[f * 3 + k]]++] = f;

    // vertex -> neighbours (unique edges)
    const sets: Set<number>[] = Array.from({ length: this.vertexCount }, () => new Set<number>());
    for (let f = 0; f < this.faceCount; f++) {
      const a = idx[f * 3], b = idx[f * 3 + 1], c = idx[f * 3 + 2];
      sets[a].add(b).add(c);
      sets[b].add(a).add(c);
      sets[c].add(a).add(b);
    }
    this.neighborStart = new Uint32Array(this.vertexCount + 1);
    for (let i = 0; i < this.vertexCount; i++) this.neighborStart[i + 1] = this.neighborStart[i] + sets[i].size;
    this.neighbors = new Uint32Array(this.neighborStart[this.vertexCount]);
    for (let i = 0; i < this.vertexCount; i++) {
      let o = this.neighborStart[i];
      for (const n of sets[i]) this.neighbors[o++] = n;
    }

    this.recomputeAllNormals();
    this.geometry.computeBoundingSphere();
  }

  markDirty(indices: Iterable<number>) {
    for (const i of indices) this.dirty.add(i);
  }

  /** Call once per frame: refresh normals around edited vertices, refit the BVH, upload. */
  flush(): boolean {
    if (this.dirty.size === 0 && !this.topologyDirty) return false;
    if (this.topologyDirty) {
      this.recomputeAllNormals();
      this.topologyDirty = false;
    } else {
      const faces = new Set<number>();
      for (const v of this.dirty) for (let k = this.faceStart[v]; k < this.faceStart[v + 1]; k++) faces.add(this.vertexFaces[k]);
      const verts = new Set<number>();
      for (const f of faces) {
        this.computeFaceNormal(f);
        verts.add(this.index[f * 3]).add(this.index[f * 3 + 1]).add(this.index[f * 3 + 2]);
      }
      for (const v of verts) this.computeVertexNormal(v);
    }
    this.dirty.clear();
    this.bvh.refit();
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.computeBoundingSphere();
    return true;
  }

  /** Replace every position (undo/redo/reset). */
  restore(snapshot: Float32Array) {
    this.positions.set(snapshot);
    this.topologyDirty = true;
    this.flush();
  }

  private computeFaceNormal(f: number) {
    const p = this.positions, i = this.index;
    const a = i[f * 3] * 3, b = i[f * 3 + 1] * 3, c = i[f * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    // Unnormalised: area-weighted when summed into vertex normals.
    this.faceNormals[f * 3] = uy * vz - uz * vy;
    this.faceNormals[f * 3 + 1] = uz * vx - ux * vz;
    this.faceNormals[f * 3 + 2] = ux * vy - uy * vx;
  }

  private computeVertexNormal(v: number) {
    let x = 0, y = 0, z = 0;
    for (let k = this.faceStart[v]; k < this.faceStart[v + 1]; k++) {
      const f = this.vertexFaces[k] * 3;
      x += this.faceNormals[f];
      y += this.faceNormals[f + 1];
      z += this.faceNormals[f + 2];
    }
    const len = Math.hypot(x, y, z) || 1;
    this.normals[v * 3] = x / len;
    this.normals[v * 3 + 1] = y / len;
    this.normals[v * 3 + 2] = z / len;
  }

  private recomputeAllNormals() {
    for (let f = 0; f < this.faceCount; f++) this.computeFaceNormal(f);
    for (let v = 0; v < this.vertexCount; v++) this.computeVertexNormal(v);
  }
}

/** Six N x N face grids on the cube [-1,1]^3, welded on integer lattice keys, wound outward. */
function buildCube(n: number): { positions: Float32Array; index: Uint32Array } {
  const keyOf = (ix: number, iy: number, iz: number) => (ix * (n + 1) + iy) * (n + 1) + iz;
  const lookup = new Map<number, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  const vertex = (ix: number, iy: number, iz: number) => {
    const key = keyOf(ix, iy, iz);
    let v = lookup.get(key);
    if (v === undefined) {
      v = pos.length / 3;
      lookup.set(key, v);
      pos.push((ix / n) * 2 - 1, (iy / n) * 2 - 1, (iz / n) * 2 - 1);
    }
    return v;
  };
  // For each face: fixed axis/value and two in-plane axes (u, v) ordered so u x v points outward.
  const faces: { axis: 0 | 1 | 2; value: number; u: 0 | 1 | 2; v: 0 | 1 | 2 }[] = [
    { axis: 0, value: n, u: 1, v: 2 }, // +X: y x z = +x
    { axis: 0, value: 0, u: 2, v: 1 }, // -X
    { axis: 1, value: n, u: 2, v: 0 }, // +Y: z x x = +y
    { axis: 1, value: 0, u: 0, v: 2 }, // -Y
    { axis: 2, value: n, u: 0, v: 1 }, // +Z: x x y = +z
    { axis: 2, value: 0, u: 1, v: 0 }, // -Z
  ];
  for (const face of faces) {
    const at = (a: number, b: number) => {
      const c = [0, 0, 0];
      c[face.axis] = face.value;
      c[face.u] = a;
      c[face.v] = b;
      return vertex(c[0], c[1], c[2]);
    };
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        const v00 = at(a, b), v10 = at(a + 1, b), v11 = at(a + 1, b + 1), v01 = at(a, b + 1);
        // Alternate the diagonal so the triangulation has no directional bias.
        if ((a + b) % 2 === 0) idx.push(v00, v10, v11, v00, v11, v01);
        else idx.push(v00, v10, v01, v10, v11, v01);
      }
    }
  }
  return { positions: new Float32Array(pos), index: new Uint32Array(idx) };
}
