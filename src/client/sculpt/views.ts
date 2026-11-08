/**
 * The six fixed orthographic views shared by capture (what the agent sees)
 * and action replay (where the agent's panel coordinates land). Both sides
 * must build exactly the same camera, so it lives in one place.
 */
import * as THREE from "three";
import type { ViewName } from "../../shared/protocol.ts";

interface ViewSpec {
  /** Direction from the target to the camera. */
  eye: [number, number, number];
  up: [number, number, number];
}

export const VIEW_SPECS: Record<ViewName, ViewSpec> = {
  front: { eye: [0, 0, 1], up: [0, 1, 0] },
  right: { eye: [1, 0, 0], up: [0, 1, 0] },
  back: { eye: [0, 0, -1], up: [0, 1, 0] },
  left: { eye: [-1, 0, 0], up: [0, 1, 0] },
  // Looking down with -Z as panel-up, so the model's front sits at the bottom of the panel.
  top: { eye: [0, 1, 0], up: [0, 0, -1] },
  three_quarter: { eye: [0.62, 0.48, 0.62], up: [0, 1, 0] },
};

/** Orthographic half-extent that frames the model with a margin; recorded per capture. */
export function frameHalfExtent(bboxMin: THREE.Vector3, bboxMax: THREE.Vector3): number {
  const m = Math.max(Math.abs(bboxMin.x), Math.abs(bboxMin.y), Math.abs(bboxMin.z), Math.abs(bboxMax.x), Math.abs(bboxMax.y), Math.abs(bboxMax.z));
  return Math.max(1.25, m * 1.18);
}

export function viewCamera(view: ViewName, half: number): THREE.OrthographicCamera {
  const spec = VIEW_SPECS[view];
  // The three-quarter view sees the bbox diagonal, so give it more room.
  const h = view === "three_quarter" ? half * 1.25 : half;
  const camera = new THREE.OrthographicCamera(-h, h, h, -h, 0.01, 100);
  const eye = new THREE.Vector3(...spec.eye).normalize().multiplyScalar(20);
  camera.position.copy(eye);
  camera.up.set(...spec.up);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

/** A ray through panel point (x, y) — 0..1, origin top-left — of the given view. */
export function panelRay(view: ViewName, half: number, x: number, y: number): THREE.Ray {
  const camera = viewCamera(view, half);
  const ndc = new THREE.Vector3(x * 2 - 1, 1 - y * 2, -1);
  const origin = ndc.clone().unproject(camera);
  const direction = new THREE.Vector3();
  camera.getWorldDirection(direction);
  return new THREE.Ray(origin, direction);
}
