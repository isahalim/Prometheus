// r = albedo variation, gb = tangent-space normal XY, a = roughness.
import { plasterHeight } from "./bake-common.wgsl";

struct BakeParams {
  size: vec2f,
}
@group(0) @binding(0) var<uniform> params: BakeParams;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let epsilon = 1.0 / max(params.size.x, params.size.y);
  let heightX = plasterHeight(uv + vec2f(epsilon, 0.0))
    - plasterHeight(uv - vec2f(epsilon, 0.0));
  let heightY = plasterHeight(uv + vec2f(0.0, epsilon))
    - plasterHeight(uv - vec2f(0.0, epsilon));
  let variation = plasterHeight(uv) - 0.5;
  return vec4f(
    0.8 + variation * 0.06,
    0.5 - heightX * 1.8,
    0.5 - heightY * 1.8,
    0.86 + variation * 0.12,
  );
}
