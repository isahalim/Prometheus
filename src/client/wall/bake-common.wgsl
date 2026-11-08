// Ported from omnidynamics src/lib/prism/bake-common.wgsl (vgpu light pipeline,
// MIT, see LICENSE-vgpu); prism grounding and spectral helpers removed.
// The generators behind vgpu's light-pipeline assets. Each bake entry is its
// own fullscreen pass; everything they share lives here.

fn hash2(point: vec2f) -> f32 {
  return fract(sin(dot(point, vec2f(127.1, 311.7))) * 43758.5453123);
}

fn valueNoise(point: vec2f) -> f32 {
  let cell = floor(point);
  let local = fract(point);
  let blend = local * local * (3.0 - 2.0 * local);
  let top = mix(hash2(cell), hash2(cell + vec2f(1.0, 0.0)), blend.x);
  let bottom = mix(
    hash2(cell + vec2f(0.0, 1.0)),
    hash2(cell + vec2f(1.0, 1.0)),
    blend.x,
  );
  return mix(top, bottom, blend.y);
}

export fn fbm(point: vec2f, octaves: u32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  var weight = 0.0;
  for (var octave = 0u; octave < octaves; octave++) {
    value += valueNoise(point * frequency) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  return value / weight;
}

export fn plasterHeight(uv: vec2f) -> f32 {
  return fbm(uv * 34.0, 5u) * 0.65 + fbm(uv * 117.0, 2u) * 0.35;
}

/** Stand-in window pools for when the authored mask cannot be loaded. */
export fn overheadLight(uv: vec2f) -> f32 {
  let upperLeft = exp(-dot((uv - vec2f(-0.08)) / vec2f(0.58, 0.64), (uv - vec2f(-0.08)) / vec2f(0.58, 0.64)) * 1.8) * 0.75;
  let center = exp(-dot((uv - vec2f(0.42, 0.22)) / vec2f(0.15, 0.17), (uv - vec2f(0.42, 0.22)) / vec2f(0.15, 0.17)) * 1.8) * 0.7;
  let right = exp(-dot((uv - vec2f(0.83, 0.3)) / vec2f(0.16, 0.18), (uv - vec2f(0.83, 0.3)) / vec2f(0.16, 0.18)) * 1.8) * 0.6;
  return clamp(upperLeft + center + right, 0.0, 1.0);
}
