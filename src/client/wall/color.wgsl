// vgpu's @vgpu/wgsl-std colour helpers, as the prism pipeline uses them.

export fn luminance(value: vec3f) -> f32 {
  return dot(value, vec3f(0.2126, 0.7152, 0.0722));
}

fn srgbToLinear(value: f32) -> f32 {
  if (value <= 0.04045) {
    return value / 12.92;
  }
  return pow((value + 0.055) / 1.055, 2.4);
}

export fn srgbToLinear3(value: vec3f) -> vec3f {
  return vec3f(srgbToLinear(value.r), srgbToLinear(value.g), srgbToLinear(value.b));
}

fn linearToSrgb(value: f32) -> f32 {
  if (value <= 0.0031308) {
    return value * 12.92;
  }
  return 1.055 * pow(value, 1.0 / 2.4) - 0.055;
}

export fn linearToSrgb3(value: vec3f) -> vec3f {
  return vec3f(linearToSrgb(value.r), linearToSrgb(value.g), linearToSrgb(value.b));
}

export fn tonemapAces(value: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp(
    (value * (a * value + b)) / (value * (c * value + d) + e),
    vec3f(0.0),
    vec3f(1.0),
  );
}

export fn tonemapReinhard(value: vec3f) -> vec3f {
  return value / (1.0 + luminance(value));
}
