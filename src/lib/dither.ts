/** Ordered-dithering helpers for pixel effects. */

/** 4x4 Bayer matrix normalised to thresholds in [0, 1). */
export const BAYER_4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
].map((value) => (value + 0.5) / 16);
