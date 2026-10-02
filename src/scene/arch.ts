/** Proscenium shape of the curtain: longest and brightest on the axis, shorter towards the sides. */
function edge(u: number): number {
  const d = Math.abs(2 * u - 1);
  return 1 - d * d;
}

/** Fraction of the full curtain length at horizontal position `u` in [0, 1]. */
export function archReach(u: number): number {
  return 0.42 + 0.58 * edge(u);
}

/** Brightness multiplier at horizontal position `u` in [0, 1]. */
export function archGain(u: number): number {
  return 0.62 + 0.38 * edge(u);
}
