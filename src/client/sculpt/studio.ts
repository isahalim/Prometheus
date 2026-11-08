/**
 * The studio viewport: one three.js canvas over the vgpu wall (transparent
 * clear), the clay mesh, the human's brush and the agent's ghost brush.
 *
 * Human and agent sculpt the same Float32Array at the same time; both write
 * on the main thread, so there is nothing to merge — the mesh is simply the
 * sum of both hands.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { acceleratedRaycast } from "three-mesh-bvh";
import type { ActionResult, BrushName, GeometrySummary, StrokeAction, StrokeSummary, ViewName } from "../../shared/protocol.ts";
import { VIEWS } from "../../shared/protocol.ts";
import { applyDab, Grab, mirrorX, type Vec3 } from "./brushes.ts";
import { SculptMesh } from "./mesh.ts";
import { frameHalfExtent, panelRay, viewCamera } from "./views.ts";

THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface BrushSettings {
  brush: BrushName;
  radius: number;
  strength: number;
  symmetry: boolean;
}

export interface Capture {
  sheet: string;
  thumb: string;
  half: number;
  /** data: URL of the thumbnail, for the memory strip in the UI. */
  thumbUrl: string;
}

const UNDO_DEPTH = 40;
const PANEL = 256;
const CLAY = new THREE.Color("#b8a693");
const SHEET_BG = "#d6d0c6";

const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
const sleepFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export class Studio {
  readonly mesh = new SculptMesh();
  readonly settings: BrushSettings = { brush: "draw", radius: 0.22, strength: 0.5, symmetry: true };
  /** Called whenever the model changes or the agent cursor moves (wall glow, UI). */
  onFrame: (info: { center: [number, number]; radius: number }) => void = () => {};
  onHistory: (canUndo: boolean, canRedo: boolean) => void = () => {};

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly clay: THREE.Mesh;
  private readonly cursor: THREE.Mesh;
  private readonly ghost: THREE.Group;
  private readonly raycaster = new THREE.Raycaster();
  private readonly captureTarget = new THREE.WebGLRenderTarget(PANEL, PANEL, { samples: 4 });
  private undo: Float32Array[] = [];
  private redo: Float32Array[] = [];
  private strokeLog: StrokeSummary[] = [];
  private lastObserved: Float32Array;
  private lastHumanActivity = performance.now();
  private readonly t0 = performance.now();
  private stroking: null | {
    pointerId: number;
    last: THREE.Vector3;
    from: THREE.Vector3;
    sum: THREE.Vector3;
    dabs: number;
    invert: boolean;
    brush: BrushName;
    grabs?: Grab[];
    plane?: THREE.Plane;
    pressure: number;
  } = null;
  private agentBusy = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
    this.camera.position.set(4.4, 3.1, 6.8);

    const material = new THREE.MeshMatcapMaterial({ matcap: clayMatcap(), color: 0xffffff });
    this.clay = new THREE.Mesh(this.mesh.geometry, material);
    this.scene.add(this.clay);

    this.cursor = brushRing(0x16130f, 0.55);
    this.scene.add(this.cursor);
    this.ghost = emberCursor();
    this.scene.add(this.ghost);

    this.lastObserved = this.mesh.positions.slice();

    // Registered before OrbitControls so a press on the clay can switch orbiting off first.
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", () => (this.cursor.visible = false));
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 2.2;
    this.controls.maxDistance = 16;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.renderer.setAnimationLoop(this.tick);
  }

  // ---------- frame loop ----------

  private tick = () => {
    this.controls.update();
    this.mesh.flush();
    this.renderer.render(this.scene, this.camera);
    this.reportProjection();
  };

  private lastProjection = "";
  private reportProjection() {
    const sphere = this.mesh.geometry.boundingSphere;
    if (!sphere) return;
    const rect = this.canvas.getBoundingClientRect();
    const c = sphere.center.clone().project(this.camera);
    const distance = this.camera.position.distanceTo(sphere.center);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const radiusPx = (sphere.radius * 0.72 / (distance * Math.tan(fovRad / 2))) * (rect.height / 2);
    const cx = (rect.left + ((c.x + 1) / 2) * rect.width) / window.innerWidth;
    const cy = (rect.top + ((1 - c.y) / 2) * rect.height) / window.innerHeight;
    const info = { center: [cx, cy] as [number, number], radius: radiusPx / window.innerHeight };
    const key = `${cx.toFixed(3)},${cy.toFixed(3)},${info.radius.toFixed(3)}`;
    if (key !== this.lastProjection) {
      this.lastProjection = key;
      this.onFrame(info);
    }
  }

  private resize() {
    const { width, height } = this.canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  // ---------- human input ----------

  private pick(event: PointerEvent): THREE.Intersection | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.firstHitOnly = true;
    return this.raycaster.intersectObject(this.clay, false)[0] ?? null;
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.stroking) return;
    const hit = this.pick(event);
    if (!hit) return; // empty space: OrbitControls orbits
    this.controls.enabled = false;
    this.canvas.setPointerCapture(event.pointerId);
    this.pushUndo();
    const brush: BrushName = event.shiftKey ? "smooth" : this.settings.brush;
    const invert = event.ctrlKey || event.metaKey || event.altKey;
    const pressure = event.pointerType === "pen" ? Math.max(0.1, event.pressure || 0.5) * 1.6 : 1;
    this.stroking = { pointerId: event.pointerId, last: hit.point.clone(), from: hit.point.clone(), sum: new THREE.Vector3(), dabs: 0, invert, brush, pressure };
    if (brush === "grab") {
      const s = this.settings;
      this.stroking.grabs = [new Grab(this.mesh, v3(hit.point), s.radius, s.strength)];
      if (s.symmetry) this.stroking.grabs.push(new Grab(this.mesh, mirrorX(v3(hit.point)), s.radius, s.strength));
      const normal = new THREE.Vector3();
      this.camera.getWorldDirection(normal);
      this.stroking.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
    } else {
      this.dab(brush, hit.point, invert, this.settings.strength * pressure, this.settings.radius, this.settings.symmetry);
      this.stroking.sum.add(hit.point);
      this.stroking.dabs = 1;
    }
    this.lastHumanActivity = performance.now();
  };

  private onPointerMove = (event: PointerEvent) => {
    const s = this.stroking;
    if (s && event.pointerId === s.pointerId) {
      this.lastHumanActivity = performance.now();
      if (event.pointerType === "pen") s.pressure = Math.max(0.1, event.pressure || 0.5) * 1.6;
      if (s.grabs && s.plane) {
        const rect = this.canvas.getBoundingClientRect();
        const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        this.raycaster.setFromCamera(ndc, this.camera);
        const point = this.raycaster.ray.intersectPlane(s.plane, new THREE.Vector3());
        if (point) {
          const delta = v3(point.clone().sub(s.last));
          this.mesh.markDirty(s.grabs[0].move(delta));
          if (s.grabs[1]) this.mesh.markDirty(s.grabs[1].move(mirrorX(delta)));
          s.last.copy(point);
          s.dabs++;
          s.sum.add(point);
          this.placeCursor(point, null);
        }
        return;
      }
      const hit = this.pick(event);
      if (!hit) return;
      const spacing = this.settings.radius * 0.28;
      const segment = hit.point.clone().sub(s.last);
      const length = segment.length();
      if (length < spacing) return;
      const steps = Math.floor(length / spacing);
      for (let i = 1; i <= steps; i++) {
        const p = s.last.clone().addScaledVector(segment, (i * spacing) / length);
        this.dab(s.brush, p, s.invert, this.settings.strength * s.pressure, this.settings.radius, this.settings.symmetry);
        s.sum.add(p);
        s.dabs++;
      }
      s.last.addScaledVector(segment, (steps * spacing) / length);
      this.placeCursor(hit.point, hit.face?.normal ?? null);
      return;
    }
    const hit = this.pick(event);
    if (hit) this.placeCursor(hit.point, hit.face?.normal ?? null);
    this.cursor.visible = hit !== null;
  };

  private onPointerUp = (event: PointerEvent) => {
    const s = this.stroking;
    if (!s || event.pointerId !== s.pointerId) return;
    this.stroking = null;
    this.controls.enabled = true;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    const center = s.dabs > 0 ? s.sum.clone().divideScalar(s.dabs) : s.from;
    this.strokeLog.push({
      by: "human",
      brush: s.brush,
      invert: s.invert,
      center: round3(v3(center)),
      from: round3(v3(s.from)),
      to: round3(v3(s.last)),
      radius: round(this.settings.radius),
      strength: round(this.settings.strength),
      dabs: s.dabs,
      symmetry: this.settings.symmetry,
      t: round((performance.now() - this.t0) / 1000),
    });
    this.lastHumanActivity = performance.now();
  };

  private dab(brush: BrushName, point: THREE.Vector3, invert: boolean, strength: number, radius: number, symmetry: boolean) {
    if (brush === "grab") return;
    const center = v3(point);
    this.mesh.markDirty(applyDab(this.mesh, { brush, center, radius, strength: Math.min(1, strength), invert }));
    if (symmetry && Math.abs(center[0]) > radius * 0.05) {
      this.mesh.markDirty(applyDab(this.mesh, { brush, center: mirrorX(center), radius, strength: Math.min(1, strength), invert }));
    }
  }

  private placeCursor(point: THREE.Vector3, normal: THREE.Vector3 | null) {
    this.cursor.position.copy(point);
    if (normal) this.cursor.lookAt(point.clone().add(normal));
    this.cursor.scale.setScalar(this.settings.radius);
    this.cursor.visible = true;
  }

  // ---------- agent hand ----------

  /** Replays one agent stroke, animated, with the ember cursor. Resolves when the stroke is done. */
  async agentStroke(action: StrokeAction, half: number): Promise<ActionResult> {
    const hits: THREE.Vector3[] = [];
    const rays: THREE.Ray[] = [];
    for (const [x, y] of action.points) {
      const ray = panelRay(action.view, half, x, y);
      this.raycaster.ray.copy(ray);
      this.raycaster.firstHitOnly = true;
      const hit = this.raycaster.intersectObject(this.clay, false)[0];
      if (hit) {
        hits.push(hit.point.clone());
        rays.push(ray);
      }
    }
    const hitRatio = action.points.length ? hits.length / action.points.length : 0;
    if (hits.length === 0) return { id: action.id, ok: false, hitRatio: 0, note: "every point missed the surface" };

    this.ghost.visible = true;
    this.ghost.scale.setScalar(action.radius);
    let dabs = 0;
    const sum = new THREE.Vector3();

    if (action.brush === "grab") {
      // Grab the surface under the first point, then drag it along the panel path (in the view plane).
      const grabs = [new Grab(this.mesh, v3(hits[0]), action.radius, action.strength)];
      if (action.symmetry) grabs.push(new Grab(this.mesh, mirrorX(v3(hits[0])), action.radius, action.strength));
      const origins = action.points.map(([x, y]) => panelRay(action.view, half, x, y).origin);
      const position = hits[0].clone();
      for (let i = 1; i < origins.length; i++) {
        const delta = origins[i].clone().sub(origins[i - 1]);
        const steps = Math.max(1, Math.ceil(delta.length() / (action.radius * 0.1)));
        const step = delta.divideScalar(steps);
        for (let k = 0; k < steps; k++) {
          this.mesh.markDirty(grabs[0].move(v3(step)));
          if (grabs[1]) this.mesh.markDirty(grabs[1].move(mirrorX(v3(step))));
          position.add(step);
          this.ghost.position.copy(position);
          sum.add(position);
          dabs++;
          if (k % 2 === 1) await sleepFrame();
        }
      }
    } else {
      const spacing = action.radius * 0.28;
      const path = hits.length === 1 ? [hits[0], hits[0]] : hits;
      for (let i = 1; i < path.length || dabs === 0; i++) {
        const a = path[i - 1] ?? path[0], b = path[i] ?? path[0];
        const segment = b.clone().sub(a);
        const steps = Math.max(1, Math.ceil(segment.length() / spacing));
        for (let k = 0; k < steps; k++) {
          const p = a.clone().addScaledVector(segment, k / steps);
          // Re-project onto the current surface: the human may have moved it since the capture.
          const surface = this.surfaceNear(p, action.view);
          this.dab(action.brush, surface, action.invert, action.strength, action.radius, action.symmetry);
          this.ghost.position.copy(surface);
          sum.add(surface);
          dabs++;
          if (dabs % 2 === 0) await sleepFrame();
        }
        if (hits.length === 1) break;
      }
    }

    this.strokeLog.push({
      by: "agent",
      brush: action.brush,
      invert: action.invert,
      center: round3(v3(sum.divideScalar(Math.max(1, dabs)))),
      from: round3(v3(hits[0])),
      to: round3(v3(hits[hits.length - 1])),
      radius: round(action.radius),
      strength: round(action.strength),
      dabs,
      symmetry: action.symmetry,
      t: round((performance.now() - this.t0) / 1000),
    });
    return { id: action.id, ok: true, hitRatio: round(hitRatio) };
  }

  private surfaceNear(p: THREE.Vector3, view: ViewName): THREE.Vector3 {
    const dir = new THREE.Vector3();
    viewCamera(view, 2).getWorldDirection(dir);
    this.raycaster.ray.set(p.clone().addScaledVector(dir, -1.5), dir);
    this.raycaster.firstHitOnly = true;
    const hit = this.raycaster.intersectObject(this.clay, false)[0];
    return hit && hit.point.distanceTo(p) < 1.2 ? hit.point : p;
  }

  setAgentBusy(busy: boolean) {
    this.agentBusy = busy;
    if (!busy) this.ghost.visible = false;
  }
  get isAgentBusy() {
    return this.agentBusy;
  }

  // ---------- history ----------

  pushUndo() {
    this.undo.push(this.mesh.positions.slice());
    if (this.undo.length > UNDO_DEPTH) this.undo.shift();
    this.redo = [];
    this.onHistory(true, false);
  }

  undoStep() {
    const prev = this.undo.pop();
    if (!prev) return;
    this.redo.push(this.mesh.positions.slice());
    this.mesh.restore(prev);
    this.onHistory(this.undo.length > 0, true);
  }

  redoStep() {
    const next = this.redo.pop();
    if (!next) return;
    this.undo.push(this.mesh.positions.slice());
    this.mesh.restore(next);
    this.onHistory(true, this.redo.length > 0);
  }

  resetCube() {
    this.pushUndo();
    this.mesh.restore(this.mesh.rest);
  }

  // ---------- observation ----------

  get isStroking() {
    return this.stroking !== null;
  }
  get idleSeconds() {
    return (performance.now() - this.lastHumanActivity) / 1000;
  }
  get pendingHumanStrokes() {
    return this.strokeLog.filter((s) => s.by === "human").length;
  }

  /** Strokes since the last observation; clears the log. */
  takeStrokes(): StrokeSummary[] {
    const out = this.strokeLog;
    this.strokeLog = [];
    return out;
  }

  /** Puts strokes back when the turn that took them never reached the agent. */
  returnStrokes(strokes: StrokeSummary[]) {
    this.strokeLog = [...strokes, ...this.strokeLog].slice(-48);
  }

  summary(): GeometrySummary {
    const m = this.mesh;
    const p = m.positions;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let radius = 0, displacement = 0, asym = 0;
    const cells = new Map<number, { x: number; y: number; z: number; mag: number; n: number }>();
    for (let v = 0, o = 0; v < m.vertexCount; v++, o += 3) {
      const x = p[o], y = p[o + 1], z = p[o + 2];
      if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
      radius += Math.hypot(x, y, z);
      displacement += Math.hypot(x - m.rest[o], y - m.rest[o + 1], z - m.rest[o + 2]);
      const q = m.mirror[v] * 3;
      asym += Math.hypot(x + p[q], y - p[q + 1], z - p[q + 2]);
      const change = Math.hypot(x - this.lastObserved[o], y - this.lastObserved[o + 1], z - this.lastObserved[o + 2]);
      if (change > 1e-4) {
        const key = (Math.floor((x + 3) * 1.5) * 16 + Math.floor((y + 3) * 1.5)) * 16 + Math.floor((z + 3) * 1.5);
        const cell = cells.get(key) ?? { x: 0, y: 0, z: 0, mag: 0, n: 0 };
        cell.x += x * change; cell.y += y * change; cell.z += z * change; cell.mag += change; cell.n++;
        cells.set(key, cell);
      }
    }
    const hotspots = [...cells.values()]
      .sort((a, b) => b.mag - a.mag)
      .slice(0, 4)
      .map((c) => ({ center: round3([c.x / c.mag, c.y / c.mag, c.z / c.mag]), magnitude: round(c.mag / Math.max(1, c.n) * 10) }));
    this.lastObserved = p.slice();
    return {
      vertices: m.vertexCount,
      triangles: m.faceCount,
      bboxMin: round3(min as Vec3),
      bboxMax: round3(max as Vec3),
      meanRadius: round(radius / m.vertexCount),
      displacementFromCube: round(displacement / m.vertexCount),
      hotspots,
      symmetryError: round(asym / m.vertexCount),
    };
  }

  /** Renders the six fixed views into one labelled 3x2 sheet (and a half-size thumbnail). */
  capture(): Capture {
    const box = new THREE.Box3().setFromBufferAttribute(this.mesh.geometry.attributes.position as THREE.BufferAttribute);
    const half = frameHalfExtent(box.min, box.max);
    const sheet = document.createElement("canvas");
    sheet.width = PANEL * 3;
    sheet.height = PANEL * 2;
    const ctx = sheet.getContext("2d")!;
    ctx.fillStyle = SHEET_BG;
    ctx.fillRect(0, 0, sheet.width, sheet.height);

    const cursorVisible = this.cursor.visible, ghostVisible = this.ghost.visible;
    this.cursor.visible = this.ghost.visible = false;
    const pixels = new Uint8Array(PANEL * PANEL * 4);
    const image = ctx.createImageData(PANEL, PANEL);
    const panel = document.createElement("canvas");
    panel.width = panel.height = PANEL;
    const pctx = panel.getContext("2d")!;

    VIEWS.forEach((view, i) => {
      const camera = viewCamera(view, half);
      this.renderer.setRenderTarget(this.captureTarget);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear();
      this.renderer.render(this.scene, camera);
      this.renderer.readRenderTargetPixels(this.captureTarget, 0, 0, PANEL, PANEL, pixels);
      for (let row = 0; row < PANEL; row++) {
        image.data.set(pixels.subarray((PANEL - 1 - row) * PANEL * 4, (PANEL - row) * PANEL * 4), row * PANEL * 4);
      }
      pctx.putImageData(image, 0, 0);
      const ox = (i % 3) * PANEL, oy = Math.floor(i / 3) * PANEL;
      ctx.drawImage(panel, ox, oy);
      drawPanelChrome(ctx, ox, oy, view);
    });
    this.renderer.setRenderTarget(null);
    this.cursor.visible = cursorVisible;
    this.ghost.visible = ghostVisible;

    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = PANEL * 1.5;
    thumbCanvas.height = PANEL;
    thumbCanvas.getContext("2d")!.drawImage(sheet, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const sheetUrl = sheet.toDataURL("image/jpeg", 0.82);
    const thumbUrl = thumbCanvas.toDataURL("image/jpeg", 0.7);
    return { sheet: sheetUrl.slice(sheetUrl.indexOf(",") + 1), thumb: thumbUrl.slice(thumbUrl.indexOf(",") + 1), half, thumbUrl };
  }

  // ---------- export (download only; nothing is stored anywhere) ----------

  async export(format: "glb" | "obj" | "stl"): Promise<Blob> {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.mesh.positions.slice(), 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(this.mesh.normals.slice(), 3));
    geometry.setIndex(new THREE.BufferAttribute(this.mesh.index.slice(), 1));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: CLAY, roughness: 0.85 }));
    mesh.name = "prometheus_sculpt";
    if (format === "glb") {
      const buffer = (await new GLTFExporter().parseAsync(mesh, { binary: true })) as ArrayBuffer;
      return new Blob([buffer], { type: "model/gltf-binary" });
    }
    if (format === "obj") return new Blob([new OBJExporter().parse(mesh)], { type: "text/plain" });
    const stl = new STLExporter().parse(mesh, { binary: true }) as DataView;
    return new Blob([new Uint8Array(stl.buffer as ArrayBuffer, stl.byteOffset, stl.byteLength)], { type: "model/stl" });
  }
}

// ---------- helpers ----------

const round = (n: number) => Math.round(n * 1000) / 1000;
const round3 = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

function drawPanelChrome(ctx: CanvasRenderingContext2D, ox: number, oy: number, view: ViewName) {
  ctx.save();
  ctx.strokeStyle = "rgba(22,19,15,0.16)";
  ctx.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(ox + f * PANEL + 0.5, oy);
    ctx.lineTo(ox + f * PANEL + 0.5, oy + PANEL);
    ctx.moveTo(ox, oy + f * PANEL + 0.5);
    ctx.lineTo(ox + PANEL, oy + f * PANEL + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(22,19,15,0.5)";
  ctx.strokeRect(ox + 0.5, oy + 0.5, PANEL - 1, PANEL - 1);
  ctx.fillStyle = "rgba(22,19,15,0.85)";
  ctx.font = "600 13px system-ui, sans-serif";
  ctx.fillText(view.replace("_", " ").toUpperCase(), ox + 6, oy + 16);
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = "rgba(22,19,15,0.55)";
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.fillText(String(f), ox + f * PANEL + 2, oy + PANEL - 4);
    ctx.fillText(String(f), ox + 2, oy + f * PANEL - 2);
  }
  ctx.restore();
}

/** Warm clay matcap, generated (no image asset): key light upper-left like the wall's. */
function clayMatcap(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(size, size);
  const light = new THREE.Vector3(-0.48, 0.56, 0.68).normalize();
  const fill = new THREE.Vector3(0.6, -0.2, 0.5).normalize();
  const base = new THREE.Color("#e6d6c3");
  const shadow = new THREE.Color("#6f5a48");
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1, ny = 1 - (y / (size - 1)) * 2;
      const r2 = nx * nx + ny * ny;
      const o = (y * size + x) * 4;
      if (r2 > 1) {
        image.data[o + 3] = 0;
        continue;
      }
      const n = new THREE.Vector3(nx, ny, Math.sqrt(1 - r2));
      const diffuse = Math.max(0, n.dot(light));
      const fillLight = Math.max(0, n.dot(fill)) * 0.18;
      const wrap = Math.pow(diffuse, 0.9) * 0.88 + 0.12 + fillLight;
      const h = new THREE.Vector3().addVectors(light, new THREE.Vector3(0, 0, 1)).normalize();
      const spec = Math.pow(Math.max(0, n.dot(h)), 36) * 0.18;
      const rim = Math.pow(1 - n.z, 3) * 0.12;
      const c = shadow.clone().lerp(base, Math.min(1, wrap));
      image.data[o] = Math.min(255, (c.r + spec + rim) * 255);
      image.data[o + 1] = Math.min(255, (c.g + spec + rim * 0.9) * 255);
      image.data[o + 2] = Math.min(255, (c.b + spec + rim * 0.8) * 255);
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function brushRing(color: number, opacity: number): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.94, 1, 64),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, side: THREE.DoubleSide }),
  );
  ring.renderOrder = 10;
  ring.visible = false;
  return ring;
}

/** The agent's hand: a warm ring and a small glowing core. */
function emberCursor(): THREE.Group {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.16, depthTest: false }),
  );
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffb070, depthTest: false }));
  ring.renderOrder = core.renderOrder = 11;
  group.add(ring, core);
  group.visible = false;
  return group;
}
