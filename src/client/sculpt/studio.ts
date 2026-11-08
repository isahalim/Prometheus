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
import type { ActionResult, AgentAction, BrushName, FormAction, GeometrySummary, GlobalAction, ShapeAction, ShapeKind, StrokeAction, StrokeSummary, ViewName } from "../../shared/protocol.ts";
import { VIEWS } from "../../shared/protocol.ts";
import { applyDab, applyForm, globalTarget, Grab, mirrorX, smoothAll, type Vec3 } from "./brushes.ts";
import { SculptMesh } from "./mesh.ts";
import { remesh, type ShapeSpec } from "./remesh.ts";
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
const STROKE_GRACE_MS = 180;
const TAP_MS = 280;
const TAP_SLOP_PX = 12;
const DOUBLE_TAP_MS = 320;
const MAX_PANEL = 320;
const CLAY = new THREE.Color("#b8a693");
const SHEET_BG = "#d6d0c6";

interface MeshState {
  positions: Float32Array;
  index: Uint32Array;
}

const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
const sleepFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export class Studio {
  mesh = SculptMesh.cube();
  /** Fires when a remesh replaces the topology (UI shows vertex count, etc.). */
  onTopology: (vertices: number) => void = () => {};
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
  private readonly captureTarget = new THREE.WebGLRenderTarget(MAX_PANEL, MAX_PANEL, { samples: 4 });
  /** Undo entries carry the index too, so a remesh can be undone like any stroke. */
  private undo: MeshState[] = [];
  private redo: MeshState[] = [];
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
  /** A primitive waiting for the human to click where it goes. */
  private armed: { shape: ShapeKind; mode: "add" | "subtract"; onPlaced: (ms: number) => void } | null = null;

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
    canvas.addEventListener("pointerleave", (e) => e.pointerType !== "touch" && (this.cursor.visible = false));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // long-press must not open a menu over the clay
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
    // Touch is handled entirely by the gesture layer below, never by OrbitControls
    // (stopImmediatePropagation keeps its listener, registered after this one, out).
    if (event.pointerType === "touch") {
      event.stopImmediatePropagation();
      event.preventDefault();
      this.touchDown(event);
      return;
    }
    if (event.button !== 0 || this.stroking) return;
    const hit = this.pick(event);
    if (!hit) return; // empty space: OrbitControls orbits
    if (this.placeArmed(hit)) return;
    this.controls.enabled = false;
    this.beginStroke(event, hit);
  };

  /** If a shape is armed, places it at this hit and reports true. */
  private placeArmed(hit: THREE.Intersection): boolean {
    if (!this.armed) return false;
    const { shape, mode, onPlaced } = this.armed;
    this.armed = null;
    this.canvas.style.cursor = "";
    this.placeCursor(hit.point, hit.face?.normal ?? null);
    onPlaced(this.placeShape(shape, mode));
    return true;
  }

  private beginStroke(event: PointerEvent, hit: THREE.Intersection) {
    this.capturePointer(event.pointerId);
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
  }

  private onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      this.touchMove(event);
      return;
    }
    this.continueStroke(event);
    if (this.stroking) return;
    const hit = this.pick(event);
    if (hit) this.placeCursor(hit.point, hit.face?.normal ?? null);
    this.cursor.visible = hit !== null;
  };

  private continueStroke(event: PointerEvent) {
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
    }
  }

  private onPointerUp = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      this.touchUp(event);
      return;
    }
    this.endStroke(event);
  };

  private endStroke(event: PointerEvent) {
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
  }

  /** Abandons the current stroke as if it never happened (a second finger landed: it was a gesture). */
  private cancelStroke() {
    const s = this.stroking;
    if (!s) return;
    this.stroking = null;
    if (this.canvas.hasPointerCapture(s.pointerId)) this.canvas.releasePointerCapture(s.pointerId);
    const before = this.undo.pop();
    if (before) this.apply(before);
    this.onHistory(this.undo.length > 0, this.redo.length > 0);
    this.cursor.visible = false;
  }

  // ---------- touch ----------
  //
  // After Nomad Sculpt / ZBrush for iPad conventions, and MDN's multi-touch
  // guidance (cache every active pointer; handle pointercancel; touch-action
  // none only on the canvas):
  //   1 finger on the clay ......... sculpt with the current brush
  //   1 finger on empty space ...... orbit
  //   2 fingers .................... pinch to zoom, drag to pan
  //   2-finger tap ................. undo        3-finger tap ... redo
  //   double-tap empty space ....... reset the view
  // A second finger arriving within STROKE_GRACE_MS of a stroke cancels that
  // stroke, so starting a pinch never leaves a dent.

  /** Pointer capture can throw for a pointer that has already gone (or a synthetic one); losing it is harmless. */
  private capturePointer(pointerId: number) {
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {
      /* not capturable: the stroke still works while the pointer stays over the canvas */
    }
  }

  /** Reports a touch gesture that did something (for a toast). */
  onGesture: (name: string) => void = () => {};
  private readonly touches = new Map<number, { x: number; y: number; sx: number; sy: number }>();
  private gesture: null | { start: number; maxTouches: number; moved: boolean; mode: "idle" | "sculpt" | "orbit" | "nav"; strokeAt: number; prevDist: number; prevMid: [number, number] } = null;
  private lastTap = { t: 0, x: 0, y: 0 };

  private touchDown(event: PointerEvent) {
    this.capturePointer(event.pointerId);
    this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY });
    const now = performance.now();
    if (this.touches.size === 1) {
      this.gesture = { start: now, maxTouches: 1, moved: false, mode: "idle", strokeAt: 0, prevDist: 0, prevMid: [0, 0] };
      const hit = this.pick(event);
      if (hit && this.placeArmed(hit)) return;
      if (hit) {
        this.beginStroke(event, hit);
        this.placeCursor(hit.point, hit.face?.normal ?? null);
        this.gesture.mode = "sculpt";
        this.gesture.strokeAt = now;
      } else {
        this.gesture.mode = "orbit";
      }
      return;
    }
    const g = this.gesture;
    if (!g) return;
    g.maxTouches = Math.max(g.maxTouches, this.touches.size);
    if (g.mode === "sculpt") {
      if (now - g.strokeAt < STROKE_GRACE_MS || (this.stroking?.dabs ?? 0) < 4) this.cancelStroke();
      else this.finishTouchStroke();
    }
    g.mode = "nav";
    const [a, b] = [...this.touches.values()];
    g.prevDist = Math.hypot(a.x - b.x, a.y - b.y);
    g.prevMid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
  }

  private touchMove(event: PointerEvent) {
    const t = this.touches.get(event.pointerId);
    const g = this.gesture;
    if (!t || !g) return;
    const dx = event.clientX - t.x, dy = event.clientY - t.y;
    t.x = event.clientX;
    t.y = event.clientY;
    if (Math.hypot(t.x - t.sx, t.y - t.sy) > TAP_SLOP_PX) g.moved = true;
    if (g.mode === "sculpt" && this.stroking?.pointerId === event.pointerId) {
      this.continueStroke(event);
    } else if (g.mode === "orbit" && this.touches.size === 1) {
      this.orbitBy(dx, dy);
    } else if (g.mode === "nav" && this.touches.size >= 2) {
      const [a, b] = [...this.touches.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      if (g.prevDist > 0 && dist > 0) this.dollyBy(g.prevDist / dist);
      this.panBy(mid[0] - g.prevMid[0], mid[1] - g.prevMid[1]);
      g.prevDist = dist;
      g.prevMid = mid;
    }
  }

  private touchUp(event: PointerEvent) {
    const g = this.gesture;
    if (this.stroking?.pointerId === event.pointerId) this.finishTouchStroke(event);
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.touches.delete(event.pointerId);
    if (!g) return;
    if (this.touches.size > 0) {
      // Fingers lifting out of a pinch: stop navigating rather than jump into an orbit.
      if (g.mode === "nav") g.mode = "idle";
      return;
    }
    const now = performance.now();
    const quick = !g.moved && now - g.start < TAP_MS;
    if (quick && g.maxTouches === 2) {
      this.undoStep();
      this.onGesture("Undo");
    } else if (quick && g.maxTouches >= 3) {
      this.redoStep();
      this.onGesture("Redo");
    } else if (quick && g.maxTouches === 1 && g.mode === "orbit") {
      if (now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(event.clientX - this.lastTap.x, event.clientY - this.lastTap.y) < 40) {
        this.resetView();
        this.onGesture("View reset");
        this.lastTap.t = 0;
      } else {
        this.lastTap = { t: now, x: event.clientX, y: event.clientY };
      }
    }
    this.gesture = null;
  }

  private finishTouchStroke(event?: PointerEvent) {
    const s = this.stroking;
    if (!s) return;
    this.endStroke(event ?? ({ pointerId: s.pointerId } as PointerEvent));
    this.cursor.visible = false; // no hover on touch: the ring shows only while a finger is down
  }

  private orbitBy(dx: number, dy: number) {
    const height = this.canvas.clientHeight || 1;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= (2 * Math.PI * dx) / height;
    spherical.phi = Math.min(Math.PI - 0.05, Math.max(0.05, spherical.phi - (2 * Math.PI * dy) / height));
    offset.setFromSpherical(spherical);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.lookAt(this.controls.target);
  }

  private dollyBy(scale: number) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const length = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, offset.length() * scale));
    offset.setLength(length);
    this.camera.position.copy(this.controls.target).add(offset);
  }

  private panBy(dx: number, dy: number) {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const perPixel = (2 * distance * Math.tan((this.camera.fov * Math.PI) / 360)) / (this.canvas.clientHeight || 1);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const move = right.multiplyScalar(-dx * perPixel).add(up.multiplyScalar(dy * perPixel));
    this.camera.position.add(move);
    this.controls.target.add(move);
  }

  resetView() {
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(4.4, 3.1, 6.8);
    this.camera.lookAt(0, 0, 0);
  }

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

  /**
   * Applies one agent action, animated. Consecutive shape actions should be
   * batched by the caller into one `agentShapes` call (one remesh for all).
   */
  async agentAction(action: AgentAction, half: number): Promise<ActionResult> {
    switch (action.kind) {
      case "stroke": {
        let result: ActionResult = { id: action.id, ok: false, hitRatio: 0 };
        for (let pass = 0; pass < Math.max(1, Math.min(4, action.passes || 1)); pass++) result = await this.agentStroke(action, half);
        return result;
      }
      case "form":
        return this.agentForm(action);
      case "global":
        return this.agentGlobal(action);
      case "shape":
        return (await this.agentShapes([action]))[0];
      case "remesh": {
        await sleepFrame();
        const ms = this.remeshWith([]);
        return { id: action.id, ok: true, hitRatio: 1, note: `remeshed in ${ms} ms, ${this.mesh.vertexCount} verts` };
      }
    }
  }

  /** Several primitives in one remesh; the ember visits each centre first. */
  async agentShapes(actions: ShapeAction[]): Promise<ActionResult[]> {
    const specs: ShapeSpec[] = [];
    for (const a of actions) {
      const spec: ShapeSpec = { shape: a.shape, center: a.center, radius: a.radius, radii: a.radii, end: a.end, axis: a.axis, minor: a.minor, mode: a.mode, blend: a.blend };
      specs.push(spec);
      if (a.symmetry && Math.abs(a.center[0]) > a.radius * 0.3) specs.push(mirrorShape(spec));
      this.ghost.visible = true;
      this.ghost.scale.setScalar(Math.max(a.radius, ...(a.radii ?? [0])));
      this.ghost.position.set(...a.center);
      for (let i = 0; i < 8; i++) await sleepFrame();
    }
    await sleepFrame();
    const ms = this.remeshWith(specs);
    for (const a of actions) {
      this.strokeLog.push({ by: "agent", brush: "clay", invert: a.mode === "subtract", center: round3(a.center), from: round3(a.center), to: round3(a.end ?? a.center), radius: round(a.radius), strength: 1, dabs: 1, symmetry: a.symmetry, t: round((performance.now() - this.t0) / 1000) });
    }
    return actions.map((a) => ({ id: a.id, ok: true, hitRatio: 1, note: `${a.mode} ${a.shape}; remeshed in ${ms} ms` }));
  }

  private snapToSurface(point: Vec3): THREE.Vector3 {
    const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
    const hit = this.mesh.bvh.closestPointToPoint(new THREE.Vector3(...point), target as never);
    return hit ? hit.point.clone() : new THREE.Vector3(...point);
  }

  private async agentForm(a: FormAction): Promise<ActionResult> {
    const steps = 12;
    const centers: Vec3[] = [v3(this.snapToSurface(a.center))];
    if (a.symmetry && Math.abs(centers[0][0]) > a.radius * 0.1) centers.push(mirrorX(centers[0]));
    this.ghost.visible = true;
    this.ghost.scale.setScalar(a.radius);
    this.ghost.position.set(...centers[0]);
    const displace = a.op === "add" || a.op === "carve" || a.op === "pull" || a.op === "push";
    for (let i = 0; i < steps; i++) {
      centers.forEach((c, k) => {
        const dir = a.direction && k === 1 ? mirrorX(a.direction) : a.direction;
        // Displacements are split across the animation; intensity ops run their passes once at the end.
        if (displace) this.mesh.markDirty(applyForm(this.mesh, a.op, c, a.radius, a.amount / steps, dir));
        else if (i === steps - 1) this.mesh.markDirty(applyForm(this.mesh, a.op, c, a.radius, a.amount, dir));
      });
      if (a.op === "pull" && a.direction) {
        const d = new THREE.Vector3(...a.direction).normalize().multiplyScalar(a.amount / steps);
        this.ghost.position.add(d);
      }
      await sleepFrame();
    }
    this.strokeLog.push({ by: "agent", brush: a.op === "pull" || a.op === "push" ? "grab" : a.op === "add" ? "clay" : a.op === "carve" ? "draw" : a.op, invert: a.op === "carve" || a.op === "push", center: round3(centers[0]), from: round3(centers[0]), to: round3(centers[0]), radius: round(a.radius), strength: round(a.amount), dabs: steps, symmetry: a.symmetry, t: round((performance.now() - this.t0) / 1000) });
    return { id: a.id, ok: true, hitRatio: 1 };
  }

  private async agentGlobal(a: GlobalAction): Promise<ActionResult> {
    const all = Array.from({ length: this.mesh.vertexCount }, (_, i) => i);
    if (a.op === "smooth") {
      const iterations = Math.max(1, Math.round(a.amount * 10));
      for (let i = 0; i < iterations; i++) {
        smoothAll(this.mesh, 1);
        this.mesh.markDirty(all);
        await sleepFrame();
      }
    } else {
      const start = this.mesh.positions.slice();
      const target = globalTarget(this.mesh, a.op, a.amount, a.scale);
      const frames = 20;
      for (let f = 1; f <= frames; f++) {
        const t = f / frames, e = t * t * (3 - 2 * t);
        const p = this.mesh.positions;
        for (let i = 0; i < p.length; i++) p[i] = start[i] + (target[i] - start[i]) * e;
        this.mesh.markDirty(all);
        await sleepFrame();
      }
    }
    return { id: a.id, ok: true, hitRatio: 1, note: `${a.op} ${a.amount}` };
  }

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

  private state(): MeshState {
    return { positions: this.mesh.positions.slice(), index: this.mesh.index };
  }

  private apply(state: MeshState) {
    if (state.index === this.mesh.index) this.mesh.restore(state.positions);
    else this.replaceMesh(new SculptMesh(state.positions.slice(), state.index));
  }

  /** Swap in a new topology (remesh, undo across a remesh, new cube). */
  private replaceMesh(mesh: SculptMesh) {
    const old = this.mesh;
    this.mesh = mesh;
    this.clay.geometry = mesh.geometry;
    old.geometry.dispose();
    this.lastObserved = mesh.positions.slice();
    this.onTopology(mesh.vertexCount);
  }

  pushUndo() {
    this.undo.push(this.state());
    if (this.undo.length > UNDO_DEPTH) this.undo.shift();
    this.redo = [];
    this.onHistory(true, false);
  }

  undoStep() {
    const prev = this.undo.pop();
    if (!prev) return;
    this.redo.push(this.state());
    this.apply(prev);
    this.onHistory(this.undo.length > 0, true);
  }

  redoStep() {
    const next = this.redo.pop();
    if (!next) return;
    this.undo.push(this.state());
    this.apply(next);
    this.onHistory(true, this.redo.length > 0);
  }

  resetCube() {
    this.pushUndo();
    this.replaceMesh(SculptMesh.cube());
  }

  /** Voxel remesh, optionally blending primitives in. Synchronous (~0.3-1.5 s); callers show a status first. */
  remeshWith(shapes: ShapeSpec[]): number {
    this.pushUndo();
    const result = remesh(this.mesh, shapes);
    if (result.index.length === 0) return result.ms; // nothing came back; keep the old surface
    this.replaceMesh(new SculptMesh(result.positions, result.index));
    return result.ms;
  }

  /** Human tool: the next click on the clay places this primitive there. */
  armShape(shape: ShapeKind, mode: "add" | "subtract", onPlaced: (ms: number) => void) {
    this.armed = { shape, mode, onPlaced };
    this.canvas.style.cursor = "copy";
  }

  /** Places a primitive at the brush cursor (where the clay was last touched). */
  placeShape(shape: ShapeKind, mode: "add" | "subtract") {
    const r = this.settings.radius * 1.6;
    const at = this.cursor.visible ? this.cursor.position.clone() : new THREE.Vector3(0, 0, 0);
    // Sink it a little into the surface so it fuses rather than touching at a point.
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(this.cursor.quaternion);
    if (this.cursor.visible && mode === "add") at.addScaledVector(normal, r * 0.35);
    const base: ShapeSpec = { shape, center: v3(at), radius: r, mode, blend: r * 0.35 };
    if (shape === "capsule") base.end = v3(at.clone().addScaledVector(normal, r * 2));
    if (shape === "cylinder" || shape === "cone" || shape === "torus") { base.axis = v3(normal); base.minor = shape === "torus" ? r * 0.3 : r; }
    if (shape === "box" || shape === "ellipsoid") base.radii = [r, r, r];
    const shapes = [base];
    if (this.settings.symmetry && Math.abs(base.center[0]) > r * 0.3) shapes.push(mirrorShape(base));
    return this.remeshWith(shapes);
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
      const change = this.lastObserved.length === p.length ? Math.hypot(x - this.lastObserved[o], y - this.lastObserved[o + 1], z - this.lastObserved[o + 2]) : 0;
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
    // Nine horizontal slices of the form, bottom to top.
    const slices: GeometrySummary["slices"] = [];
    const span = max[1] - min[1] || 1;
    const buckets = Array.from({ length: 9 }, () => ({ x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, n: 0 }));
    for (let o = 0; o < p.length; o += 3) {
      const b = buckets[Math.min(8, Math.floor(((p[o + 1] - min[1]) / span) * 9))];
      if (p[o] < b.x0) b.x0 = p[o]; if (p[o] > b.x1) b.x1 = p[o];
      if (p[o + 2] < b.z0) b.z0 = p[o + 2]; if (p[o + 2] > b.z1) b.z1 = p[o + 2];
      b.n++;
    }
    buckets.forEach((b, i) => {
      if (b.n) slices.push({ y: round(min[1] + ((i + 0.5) / 9) * span), x: [round(b.x0), round(b.x1)], z: [round(b.z0), round(b.z1)], n: b.n });
    });
    const half = frameHalfExtent(new THREE.Vector3(...min), new THREE.Vector3(...max));
    this.lastObserved = p.slice();
    return {
      slices,
      half: round(half),
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
  capture(PANEL = 256): Capture {
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
    this.captureTarget.setSize(PANEL, PANEL);
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
      drawPanelChrome(ctx, ox, oy, view, PANEL, camera, half);
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

function drawPanelChrome(ctx: CanvasRenderingContext2D, ox: number, oy: number, view: ViewName, PANEL: number, camera: THREE.Camera, half: number) {
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
  drawAxisGizmo(ctx, ox + PANEL - 34, oy + 34, camera);
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = "rgba(22,19,15,0.55)";
  ctx.fillText(`half ${half.toFixed(2)}`, ox + 6, oy + 30);
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = "rgba(22,19,15,0.55)";
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.fillText(String(f), ox + f * PANEL + 2, oy + PANEL - 4);
    ctx.fillText(String(f), ox + 2, oy + f * PANEL - 2);
  }
  ctx.restore();
}

/** A 3D axis gizmo (X red, Y green, Z blue) projected through the panel's camera — 3DAxisPrompt-style grounding. */
function drawAxisGizmo(ctx: CanvasRenderingContext2D, cx: number, cy: number, camera: THREE.Camera) {
  const axes: [string, THREE.Vector3, string][] = [
    ["X", new THREE.Vector3(1, 0, 0), "#c0281d"],
    ["Y", new THREE.Vector3(0, 1, 0), "#2f7d4f"],
    ["Z", new THREE.Vector3(0, 0, 1), "#2453a8"],
  ];
  const view = new THREE.Matrix4().extractRotation(camera.matrixWorldInverse);
  ctx.save();
  ctx.lineWidth = 2;
  ctx.font = "600 10px system-ui, sans-serif";
  for (const [label, dir, color] of axes) {
    const d = dir.clone().applyMatrix4(view);
    const ex = cx + d.x * 22, ey = cy - d.y * 22;
    ctx.strokeStyle = ctx.fillStyle = color;
    if (Math.hypot(d.x, d.y) < 0.2) {
      // Pointing at or away from the viewer.
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(d.z > 0 ? `+${label}·` : `+${label}×`, cx + 7, cy + 12);
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.fillText(`+${label}`, ex + (d.x >= 0 ? 2 : -16), ey + (d.y >= 0 ? -2 : 10));
  }
  ctx.restore();
}

function mirrorShape(s: ShapeSpec): ShapeSpec {
  const m = (v?: Vec3): Vec3 | undefined => (v ? [-v[0], v[1], v[2]] : undefined);
  return { ...s, center: m(s.center)!, end: m(s.end), axis: m(s.axis), radii: s.radii };
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
