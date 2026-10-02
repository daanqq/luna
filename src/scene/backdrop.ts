import { BAYER_4 } from '../lib/dither';
import { archGain, archReach } from './arch';

type Rgb = readonly [number, number, number];

/** Everything is drawn into a low-res pixel buffer and scaled up without smoothing. */
const INK: readonly Rgb[] = [
  [0, 0, 0],
  [5, 10, 12],
  [12, 22, 26],
  [28, 44, 50],
  [62, 84, 90],
  [120, 140, 144],
  [200, 212, 210],
  [246, 248, 240],
];

/** Faint aurora body behind the glyphs: black, deep teal, green. */
const GLOW: readonly Rgb[] = [
  [0, 0, 0],
  [4, 26, 26],
  [8, 48, 40],
  [20, 84, 52],
  [52, 128, 56],
];

/** A finer ramp for the lunar surface so maria, highlands and rays separate cleanly. */
const MOON_INK: readonly Rgb[] = [
  [14, 24, 28],
  [34, 50, 56],
  [62, 82, 88],
  [92, 112, 116],
  [124, 142, 144],
  [158, 172, 170],
  [192, 204, 200],
  [224, 232, 226],
  [250, 252, 244],
];

const BLACK = 0xff000000;

function pack([r, g, b]: Rgb): number {
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

const INK_PACKED = Uint32Array.from(INK.map(pack));
const MOON_PACKED = Uint32Array.from(MOON_INK.map(pack));
const GLOW_PACKED = Uint32Array.from(GLOW.map(pack));

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Maps `value` in [0, 1] onto a ramp, choosing between neighbours by Bayer threshold. */
function shade(ramp: Uint32Array, value: number, x: number, y: number): number {
  const s = clamp(value, 0, 1) * (ramp.length - 1);
  const lo = Math.floor(s);
  const threshold = BAYER_4[(y & 3) * 4 + (x & 3)] ?? 0.5;
  return ramp[lo + (s - lo > threshold ? 1 : 0)] ?? BLACK;
}

function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Square luminance map of the full Moon disc (orthographic, near side), normalised to [0, 1].
 * Source: NASA SVS 4720 "CGI Moon Kit" LRO colour map (public domain), resampled to a
 * 256x256 disc in public/moon/moon.png.
 */
export interface MoonMap {
  size: number;
  data: Float32Array;
}

const MOON_LOW = 0.19;
const MOON_HIGH = 0.96;

function sampleMoon(map: MoonMap, u: number, v: number): number {
  const { size, data } = map;
  const fx = clamp(u * size - 0.5, 0, size - 1.001);
  const fy = clamp(v * size - 0.5, 0, size - 1.001);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (x: number, y: number) => data[y * size + x] ?? 0;
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

interface Star {
  x: number;
  y: number;
  level: number;
  speed: number;
  phase: number;
  cross: boolean;
}

/** Per-frame inputs that couple the backdrop to the curtain and the pointer. */
export interface BackdropInput {
  time: number;
  /** Horizontal curtain displacement per buffer column, in buffer pixels. */
  shift: Float32Array;
  /** Aurora ray brightness per buffer column, in [0, 1]. */
  ray: Float32Array;
  /** Fold brightness per buffer column, roughly in [0, 1]. */
  fold: Float32Array;
  /** Pointer in buffer pixels and its smoothed presence in [0, 1]. */
  pointerX: number;
  pointerY: number;
  pointerLight: number;
}

/**
 * Sky and sea as one dithered pixel picture: gradient horizon haze, a starfield,
 * a huge full Moon rising behind the horizon with a soft halo, an aurora glow that
 * follows the curtain, and a perspective wave field lit by a wide glitter path.
 */
export class Backdrop {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly horizon: number;

  private readonly image: ImageData;
  private readonly pixels: Uint32Array;
  private readonly sky: Uint32Array;
  private readonly stars: Star[] = [];
  private readonly reach: Float32Array;
  private readonly gain: Float32Array;
  readonly moonX: number;
  readonly moonY: number;
  readonly moonR: number;
  /** Continuous sky brightness before dithering, per buffer pixel above the horizon. */
  private readonly level: Float32Array;
  private readonly moon: MoonMap | null;
  private readonly g: CanvasRenderingContext2D;

  constructor(width: number, height: number, horizonRatio: number, compact: boolean, moon: MoonMap | null) {
    this.width = width;
    this.height = height;
    this.horizon = Math.round(height * horizonRatio);
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const g = this.canvas.getContext('2d');
    if (!g) throw new Error('2D canvas context is unavailable');
    this.g = g;
    this.image = g.createImageData(width, height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.sky = new Uint32Array(width * height);
    this.moonX = Math.round(width / 2);
    this.moon = moon;
    const fitHeight = (this.horizon - height * 0.09) / 1.12;
    this.moonR = Math.round(Math.min(width * (compact ? 0.44 : 0.36), fitHeight));
    // The centre sits just above the horizon, so the sea hides the lower part of the disc.
    this.moonY = Math.round(this.horizon - this.moonR * 0.12);
    this.level = new Float32Array(width * this.horizon);
    this.reach = Float32Array.from({ length: width }, (_, x) => archReach((x + 0.5) / width));
    this.gain = Float32Array.from({ length: width }, (_, x) => archGain((x + 0.5) / width));
    this.buildSky();
  }

  private buildSky(): void {
    const { width: w, height: h, horizon: hy, sky, level, moon } = this;
    const { moonX, moonY, moonR } = this;

    for (let y = 0; y < hy; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        // Horizon haze: the sky glows where it meets the water.
        let value = 0.34 * Math.exp(-(hy - y) / (h * 0.045));
        const mx = x - moonX;
        const my = y - moonY;
        const dist = Math.hypot(mx, my);
        const out = Math.max(dist - moonR, 0);
        value += 0.34 * Math.exp(-out / (moonR * 0.05)) + 0.26 * Math.exp(-out / (moonR * 0.25)) + 0.16 * Math.exp(-out / (moonR * 0.9));
        const cover = clamp(moonR - dist + 0.5, 0, 1);
        if (cover >= 0.5) {
          const rr = dist / moonR;
          const lum = moon ? sampleMoon(moon, (mx / moonR + 1) / 2, (my / moonR + 1) / 2) : 0.7;
          const n = clamp((lum - MOON_LOW) / (MOON_HIGH - MOON_LOW), 0, 1);
          const stretched = clamp((n - 0.08) / 0.7, 0, 1);
          value = (0.34 + 0.66 * stretched ** 0.75) * (1 - 0.1 * rr ** 3);
        }
        level[i] = value;
        sky[i] = shade(cover >= 0.5 ? MOON_PACKED : INK_PACKED, value, x, y);
      }
    }
    sky.fill(BLACK, w * hy);

    const random = mulberry(5);
    const count = Math.round((w * hy) / 240);
    for (let n = 0; n < count; n++) {
      const x = Math.floor(random() * w);
      const y = Math.floor(random() * hy * 0.95);
      if ((level[y * w + x] ?? 0) > 0.1) continue;
      const roll = random();
      const haze = Math.exp(-(hy - y) / (h * 0.08));
      this.stars.push({
        x,
        y,
        level: (roll > 0.94 ? 0.95 : roll > 0.7 ? 0.62 : 0.36) * (1 - 0.8 * haze),
        speed: random() < 0.35 ? 0.6 + random() * 1.8 : 0,
        phase: random() * 6.28,
        cross: roll > 0.97,
      });
    }
  }

  /** Continuous sky brightness in [0, 1] at a buffer pixel; the sea reads as dark. */
  brightness(x: number, y: number): number {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || px >= this.width || py < 0 || py >= this.horizon) return 0;
    return this.level[py * this.width + px] ?? 0;
  }

  private plot(x: number, y: number, level: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = Math.round(clamp(level, 0, 1) * (INK_PACKED.length - 1));
    this.pixels[y * this.width + x] = INK_PACKED[index] ?? BLACK;
  }

  draw(input: BackdropInput): void {
    const { width: w, height: h, horizon: hy, pixels } = this;
    const t = input.time;
    pixels.set(this.sky);
    this.drawGlow(input);
    this.drawStars(input);
    this.drawSea(input, t, w, h, hy);
    this.g.putImageData(this.image, 0, 0);
  }

  private drawGlow(input: BackdropInput): void {
    const { width: w, horizon: hy, pixels, sky } = this;
    const { ray, fold } = input;
    const rows = Math.floor(hy * 0.96);
    for (let y = 0; y < rows; y++) {
      const yn = y / hy;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (sky[row + x] !== BLACK) continue;
        const yr = yn / (this.reach[x] ?? 1);
        if (yr >= 1) continue;
        const profile = smoothstep(0, 0.14, yr) * (1 - yr) ** 1.4 * 1.15 * (this.gain[x] ?? 1);
        const value = profile * (ray[x] ?? 0) * (0.7 + (fold[x] ?? 0));
        if (value > 0.04) pixels[row + x] = shade(GLOW_PACKED, value, x, y);
      }
    }
  }

  private drawStars(input: BackdropInput): void {
    const t = input.time;
    for (const star of this.stars) {
      let level = star.level;
      if (star.speed > 0) level *= 0.7 + 0.3 * Math.sin(t * star.speed + star.phase);
      if (input.pointerLight > 0) {
        const near = Math.hypot(star.x - input.pointerX, star.y - input.pointerY);
        level += input.pointerLight * 0.7 * Math.exp(-((near / 22) ** 2));
      }
      this.plot(star.x, star.y, level);
      if (star.cross || level > 0.9) {
        const arm = level * 0.45;
        this.plot(star.x - 1, star.y, arm);
        this.plot(star.x + 1, star.y, arm);
        this.plot(star.x, star.y - 1, arm);
        this.plot(star.x, star.y + 1, arm);
      }
    }
  }

  private drawSea(input: BackdropInput, t: number, w: number, h: number, hy: number): void {
    const { pixels } = this;
    const depth = h - hy;
    const cx = w / 2;
    const light = input.pointerLight;
    const seaScale = 12 / w;
    const moonR = this.moonR;

    // The horizon line itself: a thin, uneven glint.
    for (let x = 0; x < w; x++) {
      pixels[hy * w + x] = shade(INK_PACKED, 0.3 + 0.12 * hash(x, hy) + 0.55 * Math.exp(-(((x - cx) / this.moonR) ** 2)), x, hy);
    }

    for (let y = hy + 1; y < h; y++) {
      const d = (y - hy) / depth;
      const z = 1 / (0.06 + 0.94 * d);
      const v = z * 12;
      const far = smoothstep(0.1, 0.42, d);
      // The Moon lights the water: the haze, the swell and the glitter all gather on the axis.
      const haze = 0.3 * Math.exp(-d * 14);
      const glitterWidth = moonR * (0.2 + 0.2 * d);
      const lightSpread = moonR * (0.7 + 0.6 * d);
      const lightFall = 1 - 0.45 * d;
      const warpScale = 1 + 15 * d;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const wx = (x - cx) * seaScale * z + 0.6 * Math.sin(v * 0.45 + t * 0.3 + (x - cx) * 0.02);
        const a1 = wx * 0.8 + v * 0.9 + t * 0.55;
        const a2 = -wx * 1.5 + v * 0.65 + t * 0.9;
        const a3 = wx * 2.7 + v * 1.9 + t * 1.35;
        const eta = 0.55 * Math.sin(a1) + 0.3 * Math.sin(a2) + 0.2 * Math.sin(a3);
        const slope = 0.55 * Math.cos(a1) * 0.9 + 0.3 * Math.cos(a2) * 0.65 + 0.2 * Math.cos(a3) * 1.9;

        const lit = Math.exp(-(((x - this.moonX) / lightSpread) ** 2)) * lightFall;
        let value = 0.06 + 0.4 * smoothstep(-0.3, 1.0, slope) * far * (1 + 1.1 * lit) + 0.14 * far * lit;

        // Moon glitter: a column that the swell breaks into dashes.
        const q = (x - this.moonX + eta * warpScale * 0.8) / glitterWidth;
        if (q > -3 && q < 3) {
          const sparkle = smoothstep(0, 0.6, slope * 0.6 + eta * 0.55);
          value += Math.exp(-q * q) * sparkle * (0.35 + 0.65 * smoothstep(0, 0.1, d)) * (1 - 0.3 * d) * 1.4;
        }

        // Foam on the steepest crests, grainy like film.
        const crest = smoothstep(0.66, 0.98, eta);
        if (crest > 0 && hash(x, y) > 0.5) value += crest * far * 0.5;

        value += haze + 0.95 * Math.exp(-d * 7) * Math.exp(-(((x - this.moonX) / (moonR * 0.95)) ** 2));

        if (light > 0) {
          const near = Math.hypot(x - input.pointerX, (y - input.pointerY) * 1.6);
          if (near < 30) value += light * 0.45 * Math.exp(-((near / 12) ** 2)) * (0.4 + 0.6 * far);
        }

        pixels[row + x] = shade(INK_PACKED, value, x, y);
      }
    }
  }
}
