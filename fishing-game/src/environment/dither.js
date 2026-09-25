// Output dither for the smooth, dark gradients (night sky, moon halo, mist, far fog): +-0.5 LSB of
// interleaved-gradient noise added after tone mapping + sRGB encoding, so 8-bit banding breaks up.
// Only on the screen pass (TONE_MAPPING is defined only when rendering to the canvas): the
// half-float reflection / environment targets keep clean linear values.
export const DITHER_GLSL = /* glsl */ `
#ifdef TONE_MAPPING
  gl_FragColor.rgb += ( fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) - 0.5 ) * ( 1.0 / 255.0 );
#endif
`;
