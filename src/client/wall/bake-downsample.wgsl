// Box mip chain for the baked light assets, matching vgpu's own reducer.
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let sourceSize = vec2i(textureDimensions(sourceTexture));
  let origin = vec2i(position.xy) * 2;
  var color = vec4f(0.0);
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      color += textureLoad(sourceTexture, min(origin + vec2i(x, y), sourceSize - 1), 0);
    }
  }
  return color * 0.25;
}
