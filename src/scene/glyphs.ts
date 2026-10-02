import { createTexture } from './gl';

/**
 * Glyph atlases for the curtain: Departure Mono for the AGC listing (1997 look) and Space Mono
 * for the site's own code (2026). Each text has its own grid, and its slots index its own atlas.
 * Row 0 is the glyph mask, row 1 (Space Mono only) is a blurred copy used as glow.
 */
export interface Atlas {
  texture: WebGLTexture;
  slots: number;
  rows: number;
  /** Quad size and padding in CSS px, so atlas texels map 1:1 or finer onto the screen. */
  quadWidth: number;
  quadHeight: number;
  padX: number;
  padY: number;
  glow: boolean;
}

export interface AtlasSpec {
  family: string;
  /** Font size in CSS px that makes the advance equal to the grid cell. */
  size: number;
  cellWidth: number;
  lineHeight: number;
  /** Atlas texels per CSS px. */
  scale: number;
  /** Padding around each cell in atlas texels. */
  pad: number;
  glow: boolean;
  /** Pixel font: nearest sampling and no mipmaps. */
  crisp: boolean;
  baseline: number;
}

export function advanceRatio(family: string): number {
  const g = document.createElement('canvas').getContext('2d');
  if (!g) return 0.6;
  g.font = `100px ${family}`;
  return g.measureText('M').width / 100;
}

export function buildAtlas(gl: WebGL2RenderingContext, chars: readonly string[], spec: AtlasSpec): Atlas {
  const cw = Math.ceil(spec.cellWidth * spec.scale) + 2 * spec.pad;
  const ch = Math.ceil(spec.lineHeight * spec.scale) + 2 * spec.pad;
  const rows = spec.glow ? 2 : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, chars.length * cw);
  canvas.height = ch * rows;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas context is unavailable');
  g.font = `${spec.size * spec.scale}px ${spec.family}`;
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#fff';
  const baseline = spec.pad + spec.lineHeight * spec.scale * spec.baseline;
  chars.forEach((char, n) => g.fillText(char, n * cw + spec.pad, baseline));
  if (spec.glow) {
    g.shadowColor = '#fff';
    g.shadowBlur = spec.pad * 0.55;
    chars.forEach((char, n) => {
      g.fillText(char, n * cw + spec.pad, ch + baseline);
      g.fillText(char, n * cw + spec.pad, ch + baseline);
    });
  }

  const filter = spec.crisp ? gl.NEAREST : gl.LINEAR;
  const texture = createTexture(gl, spec.crisp ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR, filter);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  if (!spec.crisp) gl.generateMipmap(gl.TEXTURE_2D);
  return {
    texture,
    slots: chars.length,
    rows,
    quadWidth: (cw - 2 * spec.pad) / spec.scale,
    quadHeight: (ch - 2 * spec.pad) / spec.scale,
    padX: spec.pad / spec.scale,
    padY: spec.pad / spec.scale,
    glow: spec.glow,
  };
}
