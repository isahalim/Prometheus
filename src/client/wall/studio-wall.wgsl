// The studio wall: omnidynamics' lit plaster (wall-common.wgsl's evaluateWall,
// without the prism's grounding) plus two things that belong to this room:
//
//   * a soft cast shadow from the sculpture, thrown down-right because the key
//     light rakes in from the upper left (PRISM_WALL_LIGHT_DIRECTION);
//   * the ember: a warm pool of light behind the sculpture that breathes while
//     the agent is thinking and flares while it is sculpting.
//
// Rendered as one vgpu fullscreen effect; uv is y-down (0,0 = top-left).
import { srgbToLinear3, linearToSrgb3, tonemapAces } from "./color.wgsl";
import { overheadLight } from "./bake-common.wgsl";
import { evaluateWallNormalsFromMaterial } from "./wall-normal.wgsl";

const GLOBAL_LIGHT_MASK_ASPECT = 1.5;

struct StudioWall {
  wallHalfExtent: vec2f,
  objectCenter: vec2f,
  wallColor: vec3f,
  objectRadius: f32,
  lightDirection: vec3f,
  materialWorldScale: f32,
  emberColor: vec3f,
  ember: f32,
  normalStrength: f32,
  microNormalFrequency: f32,
  microNormalStrength: f32,
  ambient: f32,
  ambientLightStrength: f32,
  globalLightTransfer: f32,
  shadowContrast: f32,
  shadowPivot: f32,
  shadowFloor: f32,
  highlightExposure: f32,
  useMask: f32,
  time: f32,
  shadowStrength: f32,
  exposure: f32,
}

@group(0) @binding(0) var<uniform> params: StudioWall;
@group(0) @binding(1) var wallMaterial: texture_2d<f32>;
@group(0) @binding(2) var lightMask: texture_2d<f32>;
@group(0) @binding(3) var materialSampler: sampler;
@group(0) @binding(4) var maskSampler: sampler;

fn shadowContrastCurve(value: f32, contrast: f32, pivot: f32) -> f32 {
  let safePivot = clamp(pivot, 0.001, 0.999);
  let safeContrast = max(contrast, 0.001);
  if (value < safePivot) {
    return safePivot * pow(value / safePivot, safeContrast);
  }
  return 1.0 - (1.0 - safePivot) * pow((1.0 - value) / (1.0 - safePivot), safeContrast);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let world = (uv - vec2f(0.5)) * vec2f(2.0, -2.0) * params.wallHalfExtent;
  let material = textureSample(wallMaterial, materialSampler, world / max(params.materialWorldScale, 0.001));
  let normals = evaluateWallNormalsFromMaterial(
    world,
    params.materialWorldScale,
    params.normalStrength,
    params.microNormalFrequency,
    params.microNormalStrength,
    material,
    wallMaterial,
    materialSampler,
  );
  let normal = normals.combined;

  // The window: authored mask, cover-fitted with its top edge anchored.
  let wallAspect = params.wallHalfExtent.x / max(params.wallHalfExtent.y, 0.001);
  var lightingUv = uv;
  if (wallAspect > GLOBAL_LIGHT_MASK_ASPECT) {
    lightingUv.y = uv.y * GLOBAL_LIGHT_MASK_ASPECT / wallAspect;
  } else {
    lightingUv.x = (uv.x - 0.5) * wallAspect / GLOBAL_LIGHT_MASK_ASPECT + 0.5;
  }
  lightingUv = clamp(lightingUv, vec2f(0.001), vec2f(0.999));
  let masked = textureSample(lightMask, maskSampler, lightingUv).r;
  let globalLight = select(overheadLight(lightingUv), masked, params.useMask > 0.5);
  let globalLightShaped = shadowContrastCurve(
    pow(clamp(globalLight, 0.0, 1.0), max(params.globalLightTransfer, 0.001)),
    params.shadowContrast,
    params.shadowPivot,
  );

  let lightDirection = normalize(params.lightDirection);
  let lightFacing = max(dot(normal, lightDirection), 0.0);
  let diffuse = mix(params.ambient, 1.0, lightFacing);
  let halfDirection = normalize(lightDirection + vec3f(0.0, 0.0, 1.0));
  let specular = pow(max(dot(normal, halfDirection), 0.0), mix(48.0, 4.0, material.a)) * mix(0.12, 0.025, material.a);
  let albedo = srgbToLinear3(params.wallColor) * material.r;
  let direct = albedo * diffuse + vec3f(specular);
  let exposure = mix(params.shadowFloor, params.highlightExposure, globalLightShaped);
  let globalIllumination = vec3f(globalLightShaped * params.ambientLightStrength * material.r * mix(0.25, 1.0, lightFacing));

  // Cast shadow of the sculpture: a soft ellipse offset away from the key light,
  // measured in screen-height units so it keeps its shape at any aspect.
  let aspectScale = vec2f(wallAspect, 1.0);
  let shadowCenter = params.objectCenter + vec2f(0.045, 0.06);
  let shadowDelta = (uv - shadowCenter) * aspectScale / max(params.objectRadius, 0.01);
  let shadowFalloff = exp(-dot(shadowDelta * vec2f(1.0, 1.25), shadowDelta * vec2f(1.0, 1.25)) * 1.6);
  let castShadow = 1.0 - shadowFalloff * params.shadowStrength;

  // The ember: warm light behind the sculpture. A slow breath plus a little
  // flicker while active; zero cost to the plaster when idle.
  let emberDelta = (uv - params.objectCenter) * aspectScale / max(params.objectRadius * 1.9, 0.01);
  let emberFalloff = exp(-dot(emberDelta, emberDelta) * 1.4);
  let flicker = 0.9 + 0.06 * sin(params.time * 7.3) + 0.04 * sin(params.time * 13.1 + 1.7);
  let breath = 0.75 + 0.25 * sin(params.time * 2.1);
  let emberLight = srgbToLinear3(params.emberColor) * emberFalloff * params.ember * flicker * breath * mix(0.6, 1.0, lightFacing);

  let composed = (direct * exposure + globalIllumination) * castShadow + emberLight * material.r * 1.4;
  let mapped = tonemapAces(max(composed * params.exposure, vec3f(0.0)));
  return vec4f(linearToSrgb3(mapped), 1.0);
}
