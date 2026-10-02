import { bindTexture, createProgramAsync, createTexture, type Program } from './gl';
import { FULLSCREEN_VS } from './shaders';

/**
 * Spectral ocean (Tessendorf 2001): a JONSWAP wind sea plus a low swell, evolved with deep-water
 * dispersion and turned into height / slope / choppiness-derivative maps by a GPU inverse FFT
 * every frame. Several cascades (tiles of different size, each owning a band of wavenumbers)
 * hide the tiling. The sea shader samples the maps at real-world metres.
 */

const GRAVITY = 9.81;
const TWO_PI = Math.PI * 2;
/** Wavenumber band edges (rad/m) between cascades; the last one is open-ended up to its Nyquist. */
const BAND_EDGES = [0, 1.6, 10, 90];
/** Tile sizes in metres for N = 256; they scale with N so the texel size stays the same. */
const TILE_256 = [300, 47, 7.3];
const PERIOD = 200;
const RIPPLE_CUT = 14;
const LOST_BINS = 32;
const LOST_LOG_MIN = -6;
const LOST_LOG_MAX = 7;

export interface OceanSettings {
  size: number;
  cascades: number;
  /** Wind speed at 10 m (m/s) and its direction (radians, 0 = away from the camera). */
  wind: number;
  windAngle: number;
}

export interface OceanBinding {
  count: number;
  tiles: number[];
  texel: number[];
  lambda: number[];
  lost: Float32Array;
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

/** JONSWAP omega spectrum for a fetch-limited sea peaking at `peak` rad/s. */
function jonswap(omega: number, peak: number, alpha: number, gamma: number): number {
  if (omega <= 0) return 0;
  const sigma = omega <= peak ? 0.07 : 0.09;
  const r = Math.exp(-((omega - peak) ** 2) / (2 * sigma * sigma * peak * peak));
  return alpha * GRAVITY * GRAVITY * omega ** -5 * Math.exp(-1.25 * (peak / omega) ** 4) * gamma ** r;
}

/** cos-2s directional spreading, normalised numerically over the circle. */
function spreading(theta: number, mean: number, s: number, norm: number): number {
  const c = Math.cos((theta - mean) / 2);
  return norm * Math.abs(c) ** (2 * s);
}

function spreadNorm(s: number): number {
  let sum = 0;
  const steps = 720;
  for (let i = 0; i < steps; i++) sum += Math.abs(Math.cos(((i / steps) * TWO_PI) / 2)) ** (2 * s);
  return steps / (sum * TWO_PI);
}

interface Component {
  peak: number;
  alpha: number;
  gamma: number;
  direction: number;
  spread: number;
  norm: number;
}

/** Complex Gaussian amplitudes of one cascade, packed as (h0(k), conj(h0(-k))) per texel. */
function buildH0(size: number, tile: number, kMin: number, kMax: number, components: Component[], seed: number, lost: Float32Array): Float32Array {
  const random = mulberry(seed);
  const data = new Float32Array(size * size * 4);
  const dk = TWO_PI / tile;
  const raw = new Float32Array(size * size * 2);
  const gaussian = (): [number, number] => {
    const u = Math.max(random(), 1e-9);
    const r = Math.sqrt(-2 * Math.log(u));
    const a = TWO_PI * random();
    return [r * Math.cos(a), r * Math.sin(a)];
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = x < size / 2 ? x : x - size;
      const mz = y < size / 2 ? y : y - size;
      const kx = mx * dk;
      const kz = mz * dk;
      const k = Math.hypot(kx, kz);
      const n = (y * size + x) * 2;
      const [re, im] = gaussian();
      if (k < kMin || k >= kMax || k === 0) continue;
      const omega = Math.sqrt(GRAVITY * k);
      const theta = Math.atan2(kx, kz);
      let spectrum = 0;
      for (const c of components) {
        const sOmega = jonswap(omega, c.peak, c.alpha, c.gamma);
        // S(k) = S(omega) d omega / dk, and the polar density divides by k.
        spectrum += ((sOmega * GRAVITY) / (2 * omega) / k) * spreading(theta, c.direction, c.spread, c.norm);
      }
      // Capillary-scale ripples are damped so the total slope variance stays near a 5 m/s sea (mss ~0.03).
      const amp = Math.sqrt(2 * spectrum * Math.exp(-((k / RIPPLE_CUT) ** 2))) * dk;
      raw[n] = (re * amp) / Math.SQRT2;
      raw[n + 1] = (im * amp) / Math.SQRT2;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = (y * size + x) * 2;
      const m = (((size - y) % size) * size + ((size - x) % size)) * 2;
      const o = (y * size + x) * 4;
      data[o] = raw[n]!;
      data[o + 1] = raw[n + 1]!;
      data[o + 2] = raw[m]!;
      data[o + 3] = -raw[m + 1]!;
      const mx = x < size / 2 ? x : x - size;
      const mz = y < size / 2 ? y : y - size;
      const k = Math.hypot(mx * dk, mz * dk);
      if (k > 0) {
        const power = k * k * (raw[n]! ** 2 + raw[n + 1]! ** 2 + raw[m]! ** 2 + raw[m + 1]! ** 2);
        const b = Math.min(LOST_BINS - 1, Math.max(0, Math.floor(((Math.log2(k) - LOST_LOG_MIN) / (LOST_LOG_MAX - LOST_LOG_MIN)) * (LOST_BINS - 1) + 0.5)));
        lost[b] = lost[b]! + power;
      }
    }
  }
  return data;
}

const EVOLVE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
uniform sampler2D uH0;
uniform float uSize;
uniform float uTile;
uniform float uTime;
const float G = 9.81;
const float TAU = 6.28318530718;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  int n = int(uSize);
  vec2 m = vec2(id.x < n / 2 ? id.x : id.x - n, id.y < n / 2 ? id.y : id.y - n);
  vec2 k = TAU * m / uTile;
  float kl = length(k);
  if (kl < 1e-5) { o0 = vec4(0.); o1 = vec4(0.); return; }
  // Frequencies are snapped to a common period so the animation loops without a seam.
  float w0 = TAU / ${PERIOD}.;
  float omega = floor(sqrt(G * kl) / w0 + 0.5) * w0;
  float ph = omega * mod(uTime, ${PERIOD}.);
  vec2 e = vec2(cos(ph), sin(ph));
  vec4 h0 = texelFetch(uH0, id, 0);
  vec2 h = cmul(h0.xy, e) + cmul(h0.zw, vec2(e.x, -e.y));
  // Two real fields travel through one complex FFT: c = A + iB.
  vec2 c1 = cmul(h, vec2(1. - k.x, 0.));
  vec2 c2 = cmul(h, vec2(0., k.y - k.x * k.x / kl));
  vec2 c3 = cmul(h, vec2(-k.y * k.y / kl, -k.x * k.y / kl));
  o0 = vec4(c1, c2);
  o1 = vec4(c3, 0., 0.);
}`;

const FFT_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform float uSize;
uniform float uNs;
uniform float uVertical;
const float TAU = 6.28318530718;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  int n = int(uSize);
  int ns = int(uNs);
  int o = uVertical > 0.5 ? id.y : id.x;
  int group = o / (2 * ns);
  int r = o - group * 2 * ns;
  int k = r % ns;
  int j = group * ns + k;
  ivec2 a = uVertical > 0.5 ? ivec2(id.x, j) : ivec2(j, id.y);
  ivec2 b = uVertical > 0.5 ? ivec2(id.x, j + n / 2) : ivec2(j + n / 2, id.y);
  float ang = TAU * float(k) / float(2 * ns);
  vec2 w = vec2(cos(ang), sin(ang));
  float sgn = r < ns ? 1. : -1.;
  vec4 a0 = texelFetch(uIn0, a, 0);
  vec4 b0 = texelFetch(uIn0, b, 0);
  vec4 a1 = texelFetch(uIn1, a, 0);
  vec4 b1 = texelFetch(uIn1, b, 0);
  o0 = vec4(a0.xy + sgn * cmul(w, b0.xy), a0.zw + sgn * cmul(w, b0.zw));
  o1 = vec4(a1.xy + sgn * cmul(w, b1.xy), 0., 0.);
}`;

interface Spectrum {
  tile: number;
  /** Packed h0 amplitudes from buildH0. */
  data: Float32Array;
}

/** Wind sea and swell components plus the wavenumber band of every cascade. */
function planCascades(settings: OceanSettings): { components: Component[]; bands: { tile: number; kMin: number; kMax: number; seed: number }[] } {
  const scale = settings.size / 256;
  const wind = settings.wind;
  // Fetch-limited wind sea: JONSWAP peak and Phillips-like alpha from U10 and a fetch of ~30 km.
  const fetch = 30000;
  const peak = 22 * Math.cbrt((GRAVITY * GRAVITY) / (wind * fetch));
  const alpha = 0.076 * ((wind * wind) / (fetch * GRAVITY)) ** 0.22;
  const windSpread = 12;
  const swellSpread = 40;
  const components: Component[] = [
    { peak, alpha: alpha * 0.6, gamma: 3.3, direction: settings.windAngle, spread: windSpread, norm: spreadNorm(windSpread) },
    // A long low swell from another direction keeps the sea from looking like one train of waves.
    { peak: 0.78, alpha: 0.0021, gamma: 6, direction: settings.windAngle - 1.7, spread: swellSpread, norm: spreadNorm(swellSpread) },
  ];
  const bands = [];
  for (let i = 0; i < settings.cascades; i++) {
    const kMax = i === settings.cascades - 1 ? BAND_EDGES[i + 1]! * (settings.cascades === 2 ? 1.2 : 1) : BAND_EDGES[i + 1]!;
    bands.push({ tile: TILE_256[i]! * scale, kMin: BAND_EDGES[i]!, kMax, seed: 1234 + 77 * i });
  }
  return { components, bands };
}

interface Pair {
  t0: WebGLTexture;
  t1: WebGLTexture;
  fbo: WebGLFramebuffer;
}

interface Cascade {
  tile: number;
  h0: WebGLTexture;
  out: Pair;
  lambda: number;
}

export class Ocean {
  readonly binding: OceanBinding;
  /** Per cascade: height/slope texture and derivative texture. */
  readonly textures: WebGLTexture[] = [];
  /** CPU time of the last update in ms (GPU time too when `measure` is set). */
  lastMs = 0;
  measure = false;
  private readonly gl: WebGL2RenderingContext;
  private readonly size: number;
  private readonly cascades: Cascade[] = [];
  private readonly evolve: Program<'uH0' | 'uSize' | 'uTile' | 'uTime'>;
  private readonly fft: Program<'uIn0' | 'uIn1' | 'uSize' | 'uNs' | 'uVertical'>;
  private readonly ping: Pair[];
  private readonly drawBuffers: number[];

  private constructor(
    gl: WebGL2RenderingContext,
    settings: OceanSettings,
    float32: boolean,
    programs: { evolve: Ocean['evolve']; fft: Ocean['fft'] },
    spectra: Spectrum[],
    lost: Float32Array,
  ) {
    this.gl = gl;
    this.size = settings.size;
    this.drawBuffers = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1];
    this.evolve = programs.evolve;
    this.fft = programs.fft;
    const type = float32 ? gl.FLOAT : gl.HALF_FLOAT;
    const ping: [number, number] = float32 ? [gl.RGBA32F, gl.RG32F] : [gl.RGBA16F, gl.RG16F];
    this.ping = [this.makePair(ping, type, gl.NEAREST, false), this.makePair(ping, type, gl.NEAREST, false)];

    const tiles: number[] = [];
    const texel: number[] = [];
    const lambda: number[] = [];
    for (const [i, { tile, data }] of spectra.entries()) {
      const texture = createTexture(gl, gl.NEAREST, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, settings.size, settings.size, 0, gl.RGBA, gl.FLOAT, data);
      const out = this.makePair([gl.RGBA16F, gl.RG16F], gl.HALF_FLOAT, gl.LINEAR_MIPMAP_LINEAR, true);
      this.cascades.push({ tile, h0: texture, out, lambda: i === 0 ? 0.9 : i === 1 ? 0.7 : 0.5 });
      this.textures.push(out.t0, out.t1);
      tiles.push(tile);
      texel.push(tile / settings.size);
      lambda.push(this.cascades[i]!.lambda);
    }
    // Slope variance of everything above wavenumber k: what a footprint of size pi/k cannot resolve.
    for (let b = LOST_BINS - 2; b >= 0; b--) lost[b] = lost[b]! + lost[b + 1]!;
    this.binding = { count: settings.cascades, tiles, texel, lambda, lost };
  }

  /**
   * Resolves to null when the GPU cannot render to float textures. Compiles without blocking where the
   * driver allows it and builds one cascade spectrum per task, so the page keeps responding meanwhile.
   */
  static async create(gl: WebGL2RenderingContext, settings: OceanSettings): Promise<Ocean | null> {
    const float32 = gl.getExtension('EXT_color_buffer_float') !== null;
    if (!float32 && gl.getExtension('EXT_color_buffer_half_float') === null) return null;
    try {
      const [evolve, fft] = await Promise.all([
        createProgramAsync(gl, FULLSCREEN_VS, EVOLVE_FS, ['uH0', 'uSize', 'uTile', 'uTime'] as const),
        createProgramAsync(gl, FULLSCREEN_VS, FFT_FS, ['uIn0', 'uIn1', 'uSize', 'uNs', 'uVertical'] as const),
      ]);
      const { components, bands } = planCascades(settings);
      const lost = new Float32Array(LOST_BINS);
      const spectra: Spectrum[] = [];
      for (const band of bands) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        spectra.push({ tile: band.tile, data: buildH0(settings.size, band.tile, band.kMin, band.kMax, components, band.seed, lost) });
      }
      if (gl.isContextLost()) return null;
      const ocean = new Ocean(gl, settings, float32, { evolve, fft }, spectra, lost);
      if (ocean.checkComplete()) return ocean;
      ocean.destroy();
      return null;
    } catch (error) {
      console.warn('[scene] FFT ocean unavailable, using the sine sea', error);
      return null;
    }
  }

  /** Two targets drawn together; the second holds a single complex field (c3), so it only needs RG. */
  private makePair(internal: readonly [number, number], type: number, filter: number, repeat: boolean): Pair {
    const gl = this.gl;
    const min = filter;
    const mag = filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR;
    const make = (format: number, channels: number): WebGLTexture => {
      const t = createTexture(gl, min, mag);
      if (repeat) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, format, this.size, this.size, 0, channels, type, null);
      return t;
    };
    const t0 = make(internal[0], gl.RGBA);
    const t1 = make(internal[1], gl.RG);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('Cannot create a framebuffer');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t0, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, t1, 0);
    return { t0, t1, fbo };
  }

  private checkComplete(): boolean {
    const gl = this.gl;
    let ok = true;
    for (const pair of [...this.ping, ...this.cascades.map((c) => c.out)]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, pair.fbo);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) ok = false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok;
  }

  /** Evolves the spectrum to `time` seconds and runs the inverse FFTs of every cascade. */
  update(time: number): void {
    const gl = this.gl;
    const start = performance.now();
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, this.size, this.size);
    const stages = Math.log2(this.size);
    for (const cascade of this.cascades) {
      gl.useProgram(this.evolve.program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.ping[0]!.fbo);
      gl.drawBuffers(this.drawBuffers);
      bindTexture(gl, 0, cascade.h0);
      gl.uniform1i(this.evolve.u.uH0, 0);
      gl.uniform1f(this.evolve.u.uSize, this.size);
      gl.uniform1f(this.evolve.u.uTile, cascade.tile);
      gl.uniform1f(this.evolve.u.uTime, time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.useProgram(this.fft.program);
      gl.uniform1i(this.fft.u.uIn0, 0);
      gl.uniform1i(this.fft.u.uIn1, 1);
      gl.uniform1f(this.fft.u.uSize, this.size);
      let src = 0;
      for (let pass = 0; pass < stages * 2; pass++) {
        const last = pass === stages * 2 - 1;
        const from = this.ping[src]!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, last ? cascade.out.fbo : this.ping[1 - src]!.fbo);
        gl.drawBuffers(this.drawBuffers);
        bindTexture(gl, 0, from.t0);
        bindTexture(gl, 1, from.t1);
        gl.uniform1f(this.fft.u.uNs, 2 ** (pass % stages));
        gl.uniform1f(this.fft.u.uVertical, pass >= stages ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = 1 - src;
      }
      for (const texture of [cascade.out.t0, cascade.out.t1]) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.generateMipmap(gl.TEXTURE_2D);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (this.measure) gl.finish();
    this.lastMs = performance.now() - start;
  }

  destroy(): void {
    const gl = this.gl;
    for (const pair of [...this.ping, ...this.cascades.map((c) => c.out)]) {
      gl.deleteTexture(pair.t0);
      gl.deleteTexture(pair.t1);
      gl.deleteFramebuffer(pair.fbo);
    }
    for (const cascade of this.cascades) gl.deleteTexture(cascade.h0);
    gl.deleteProgram(this.evolve.program);
    gl.deleteProgram(this.fft.program);
  }
}
