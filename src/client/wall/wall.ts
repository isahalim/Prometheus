/**
 * The studio wall, drawn by vgpu on a fixed full-viewport canvas behind
 * everything (DESIGN.md §12 of omnidynamics: "the page's wall, not a picture
 * hung on it"). The CSS gradient on <html> stands in until it is ready, and
 * forever on machines without WebGPU.
 *
 * Renders on demand: once on resize, and continuously only while the ember
 * is lit (the agent is thinking or sculpting) or fading out.
 */
import type { Gpu, Surface, Effect } from "vgpu";
import { effect, frame, init, sampler, surface, target } from "vgpu";
import type { Texture } from "vgpu/core";
import { createSampler } from "vgpu/core";

import bakeDownsampleWgsl from "./bake-downsample.wgsl";
import bakeWallMaterialWgsl from "./bake-wall-material.wgsl";
import studioWallWgsl from "./studio-wall.wgsl";

/** omnidynamics' numbers (src/lib/prism/constants.ts), so the two rooms match. */
const WALL_COLOR = [0xd2 / 255, 0xcc / 255, 0xc2 / 255];
const LIGHT_DIRECTION = [-0.48, 0.56, 0.68];
const MATERIAL_SIZE: [number, number] = [512, 512];
const WALL = {
  materialWorldScale: 0.57 * 2.4,
  normalStrength: 0.22 * 0.6,
  microNormalFrequency: 7,
  microNormalStrength: 1.05 * 0.6,
  ambient: 0.5,
  ambientLightStrength: 0.42,
  globalLightTransfer: 0.65,
  shadowContrast: 6.85,
  shadowPivot: 0.9,
  shadowFloor: 0.87,
  highlightExposure: 3.31,
};
/** Warm white with fire in it — the only "colour" the room adds. */
const EMBER_COLOR = [1.0, 0.62, 0.32];
const WALL_HALF_HEIGHT = 1.4;

export interface WallState {
  /** Sculpture centre on screen, 0..1, y-down. */
  objectCenter: [number, number];
  /** Sculpture radius as a fraction of the viewport height. */
  objectRadius: number;
}

export interface WallRenderer {
  readonly ready: Promise<void>;
  setObject(state: WallState): void;
  /** 0 = idle, ~0.5 = thinking, 1 = sculpting. Eased internally. */
  setEmber(level: number): void;
  dispose(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createWall(canvas: HTMLCanvasElement): WallRenderer {
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let wall: Effect | undefined;
  let material: Texture | undefined;
  let mask: Texture | undefined;
  let materialSampler: GPUSampler | undefined;
  let maskSampler: GPUSampler | undefined;
  let useMask = 0;
  let disposed = false;
  let raf = 0;
  let object: WallState = { objectCenter: [0.5, 0.5], objectRadius: 0.22 };
  let ember = 0;
  let emberTarget = 0;
  const t0 = performance.now();

  const draw = () => {
    if (!gpu || !canvasSurface || !wall || !material || !mask) return;
    const aspect = canvasSurface.size[0] / Math.max(1, canvasSurface.size[1]);
    wall.set({
      params: {
        wallHalfExtent: [WALL_HALF_HEIGHT * aspect, WALL_HALF_HEIGHT],
        objectCenter: object.objectCenter,
        wallColor: WALL_COLOR,
        objectRadius: object.objectRadius,
        lightDirection: LIGHT_DIRECTION,
        emberColor: EMBER_COLOR,
        ember,
        useMask,
        time: (performance.now() - t0) / 1000,
        shadowStrength: 0.2,
        exposure: 1,
        ...WALL,
      },
      wallMaterial: material,
      lightMask: mask,
      materialSampler,
      maskSampler,
    });
    const surf = canvasSurface;
    const fx = wall;
    frame(gpu, (current) => current.pass({ target: surf }, (pass) => pass.draw(fx)));
  };

  const tick = () => {
    raf = 0;
    if (disposed) return;
    ember += (emberTarget - ember) * 0.06;
    if (Math.abs(emberTarget - ember) < 0.002) ember = emberTarget;
    draw();
    if (ember > 0.001 || emberTarget > 0) request();
  };
  const request = () => {
    if (!raf && !disposed && !document.hidden) raf = requestAnimationFrame(tick);
  };

  const resize = () => {
    if (!canvasSurface) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvasSurface.resize([Math.round(rect.width * dpr), Math.round(rect.height * dpr)]);
    request();
  };

  const ready = (async () => {
    if (!("gpu" in navigator)) throw new Error("WebGPU unavailable");
    gpu = await init();
    if (disposed) return;
    canvasSurface = surface(gpu, canvas, { dpr: [1, 2] });
    material = await bakeMaterial(gpu);
    mask = await loadMask(gpu);
    useMask = mask ? 1 : 0;
    mask ??= gpu.device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: ["texture_binding", "copy_dst"], label: "wall.mask-placeholder" });
    materialSampler = sampler(gpu, { minFilter: "linear", magFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" });
    maskSampler = createSampler(gpu.device, { minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", label: "wall.mask-sampler" });
    wall = effect(gpu, studioWallWgsl, { label: "studio.wall" });
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", () => !document.hidden && request());
    resize();
    draw();
    await sleep(16);
  })();

  return {
    ready,
    setObject(state) {
      object = state;
      request();
    },
    setEmber(level) {
      emberTarget = Math.max(0, Math.min(1, level));
      request();
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      gpu?.dispose();
    },
  };
}

async function loadMask(gpu: Gpu): Promise<Texture | undefined> {
  try {
    const response = await fetch("/prism/wall-global-light-mask.webp");
    if (!response.ok) return undefined;
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const texture = gpu.device.createTexture({
        size: [bitmap.width, bitmap.height],
        format: "rgba8unorm",
        usage: ["texture_binding", "copy_dst", "render_attachment"],
        label: "wall.global-light-mask",
      });
      gpu.gpu.queue.copyExternalImageToTexture({ source: bitmap }, { texture: texture.gpu }, [bitmap.width, bitmap.height]);
      return texture;
    } finally {
      bitmap.close();
    }
  } catch {
    return undefined;
  }
}

/** The plaster material, baked on the GPU with its full mip chain (omnidynamics assets.ts' bakeMipped). */
async function bakeMaterial(gpu: Gpu): Promise<Texture> {
  const [w, h] = MATERIAL_SIZE;
  const mipLevelCount = Math.floor(Math.log2(Math.max(w, h))) + 1;
  const texture = gpu.device.createTexture({ size: [w, h], format: "rgba8unorm", mipLevelCount, usage: ["texture_binding", "copy_dst"], label: "wall.material" });
  const copyLevel = (source: ReturnType<typeof target>, level: number) => {
    const encoder = gpu.gpu.createCommandEncoder({ label: `wall.material.copy${level}` });
    encoder.copyTextureToTexture({ texture: source.color.gpu }, { texture: texture.gpu, mipLevel: level }, [source.size[0], source.size[1], 1]);
    gpu.gpu.queue.submit([encoder.finish()]);
  };
  const scratch = target(gpu, { size: [w, h], format: "rgba8unorm", label: "wall.material.level0" });
  const bake = effect(gpu, bakeWallMaterialWgsl, { label: "wall.material-bake" });
  bake.set({ params: { size: MATERIAL_SIZE } });
  await bake.compile(scratch);
  frame(gpu, (current) => current.pass({ target: scratch, clear: [0, 0, 0, 1] }, (pass) => pass.draw(bake)));
  copyLevel(scratch, 0);
  (scratch as { destroy?: () => void }).destroy?.();

  const downsample = effect(gpu, bakeDownsampleWgsl, { label: "wall.material-downsample" });
  let compiled = false;
  for (let level = 1; level < mipLevelCount; level++) {
    const next = target(gpu, { size: [Math.max(1, w >> level), Math.max(1, h >> level)], format: "rgba8unorm", label: `wall.material.level${level}` });
    downsample.set({ sourceTexture: texture.gpu.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) });
    if (!compiled) {
      await downsample.compile(next);
      compiled = true;
    }
    frame(gpu, (current) => current.pass({ target: next }, (pass) => pass.draw(downsample)));
    copyLevel(next, level);
    (next as { destroy?: () => void }).destroy?.();
  }
  return texture;
}
