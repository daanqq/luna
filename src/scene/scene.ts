import { onTick } from '../lib/ticker';
import { layoutCode } from './code-layout';
import { archGain, archReach } from './arch';
import { EraTimeline, LAST_STAGE, lookAt, pixelFor, type EraLook, type EraStage } from './era';
import { Ocean } from './ocean';
import { CurtainField, STEP_MS, type Pointer } from './field';
import { advanceRatio, buildAtlas, type Atlas } from './glyphs';
import {
  bindTexture, createLightTarget, createProgramAsync, createTarget, createTexture, deleteTarget, type Program, type Target,
} from './gl';
import {
  COMPOSITE_FS, COMPOSITE_UNIFORMS, FULLSCREEN_VS, GLYPH_FS, GLYPH_UNIFORMS, GLYPH_VS, SCENE_UNIFORMS, sceneFs,
} from './shaders';
import { AGC_FAMOUS_LINE, AGC_LINES, SITE_CODE_LINES } from './text';

export interface EraState {
  stage: number;
  /** The stage the timeline travels to. */
  target: EraStage;
  /** Glitch burst in [0, 1]. */
  flicker: number;
  settled: boolean;
}

export interface SceneOptions {
  reducedMotion: boolean;
  /** Called when the GL context is lost; the caller falls back to the 2D renderer. */
  onLost: () => void;
}

export interface SceneApi {
  destroy(): void;
  /** Travels stage by stage to `stage` (0..LAST_STAGE); ignored until `ready` resolves to true: before that only 1997 can be drawn. */
  setStage(stage: EraStage): void;
  readonly target: EraStage;
  /** Resolves when the 2026 programs have compiled (false if they failed); 1997 shows meanwhile. */
  readonly ready: Promise<boolean>;
  /** Share of the 2026 programs compiled so far, in [0, 1]. */
  readonly compiled: number;
  onEra(listener: (state: EraState) => void): () => void;
}

const FONT_DEPARTURE = '"Departure Mono", ui-monospace, monospace';
const FONT_MODERN = '"Space Mono", ui-monospace, monospace';
const FONT_SIZE = 11;
const LINE_HEIGHT = 13;
const HORIZON = 0.66;
const HORIZON_CURVE = 0.0015;
/** Lens colour fringes at the 2026 frame corners, CSS px. */
const LENS_FRINGE = 3;
const MOON_LOW_URL = '/moon/moon.png';
const MOON_ALBEDO_URL = '/moon/moon-albedo.webp';
const MOON_NORMAL_URL = '/moon/moon-normal.webp';
const STILL_TIME = 11;
const REFLECTION_SCALE = 0.5;
/** CSS px per texel of the aurora map (the light is soft-focused anyway) and of the sky map the sea reflects. */
const AURORA_TEXEL = 2;
const SKY_TEXEL = 4;
const MIN_SCALE = 0.5;
const MAX_BASE_PIXEL = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Wide drifting aurora rays with finer streaks inside; mirrors `rayAt` in the shader. */
function rayAt(column: number, t: number, frequency: number): number {
  const col = column * frequency;
  const band = 0.5 + 0.5 * Math.sin(col * 0.085 + 2.4 * Math.sin(col * 0.037 + t * 0.15) + t * 0.22);
  const streak = 0.5 + 0.5 * Math.sin(col * 0.31 - t * 0.35);
  return 0.06 + band ** 1.7 * (0.65 + 0.35 * streak);
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = 'async';
  image.src = src;
  await image.decode();
  return image;
}

interface GlyphGrid {
  slots: Int16Array;
  accent: Uint8Array;
  chars: string[];
}

function toGlyphGrid(grid: string[]): GlyphGrid {
  const chars = [...new Set(grid)].filter((char) => char !== ' ');
  const index = new Map(chars.map((char, n) => [char, n]));
  const slots = new Int16Array(grid.length);
  const accent = new Uint8Array(grid.length);
  grid.forEach((char, n) => {
    slots[n] = index.get(char) ?? -1;
    const h = Math.imul(n + 1, 2654435761) >>> 0;
    accent[n] = char !== ' ' && h % 53 === 0 ? 1 : 0;
  });
  return { slots, accent, chars };
}

interface Layout {
  width: number;
  height: number;
  dpr: number;
  basePixel: number;
  horizon: number;
  moonX: number;
  moonY: number;
  moonR: number;
  cols: number;
  rows: number;
  cellWidth: number;
  field: CurtainField;
  /** Glyph slots per text: agc (Departure atlas, 1997) and site code (Space Mono atlas, 2026). */
  agc: GlyphGrid;
  code: GlyphGrid;
  instances: Float32Array;
  columns: Float32Array;
  departure: Atlas;
  modern: Atlas | null;
  reflection: Target;
  /** Coarse light maps the scene samples instead of tracing the aurora and the reflected sky per pixel. */
  auroraMap: Target;
  skyMap: Target;
  rayFrequency: number;
  modernRatio: number;
  /** Static per-cell height profile of the curtain (0 where it never shows) and per-column arch gain. */
  profile: Float64Array;
  archGains: Float64Array;
  /** Ray brightness per column, refreshed once per frame. */
  rays: Float64Array;
  /** The reduced-motion still: whether the cloth has been fast-forwarded, and whether that is under way. */
  still: 'raw' | 'settling' | 'settled';
}

/**
 * WebGL2 night scene. Passes per frame: curtain glyphs into a half-resolution
 * reflection map, the aurora and sky light maps, the scene shader at era resolution,
 * a composite with CRT effects, then the glyph curtain over the picture.
 * Returns null when WebGL2 is unavailable.
 */
export async function createScene(canvas: HTMLCanvasElement, options: SceneOptions): Promise<SceneApi | null> {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;

  const params = new URLSearchParams(window.location.search);
  const fftOff = params.has('nofft');
  const fftLog = params.has('fftlog');
  const stillTime = params.has('time') ? Number(params.get('time')) || STILL_TIME : STILL_TIME;
  const pinnedEra = params.has('era') ? clamp(Number(params.get('era')) || 0, 0, 1) : null;
  let renderScale = params.has('scale') ? clamp(Number(params.get('scale')) || 1, MIN_SCALE, 1) : 1;
  const scalePinned = params.has('scale');
  // `?gpuload=N` repeats every GPU pass N times: a stand-in for a graphics card N times slower.
  const gpuLoad = params.has('gpuload') ? clamp(Math.round(Number(params.get('gpuload')) || 1), 1, 8) : 1;
  // How far the horizon drops at the screen edges in 2026, as a share of the screen width; `?curve=N` sets it in %.
  const curveShare = params.has('curve') ? clamp(Number(params.get('curve')) || 0, 0, 5) / 100 : HORIZON_CURVE;
  const hdrMaps = gl.getExtension('EXT_color_buffer_float') !== null || gl.getExtension('EXT_color_buffer_half_float') !== null;
  // A shooting star every ~40 s on average; `?meteor=1` makes one come every few seconds for review.
  const meteorSlot = params.has('meteor') ? 5 : 15;
  const meteorChance = params.has('meteor') ? 1 : 0.4;

  type SceneProgram = Program<(typeof SCENE_UNIFORMS)[number]>;
  interface RealPrograms {
    scene: SceneProgram;
    aurora: SceneProgram;
    sky: SceneProgram;
  }
  let retroProgram: SceneProgram;
  let glyphProgram: Program<(typeof GLYPH_UNIFORMS)[number]>;
  let compositeProgram: Program<(typeof COMPOSITE_UNIFORMS)[number]>;
  /** The 2026 programs; until they compile the scene stays in 1997. */
  let real: RealPrograms | null = null;
  // The small moon and the 1997 font load while the first programs compile.
  const firstAssets = Promise.all([
    loadImage(MOON_LOW_URL).catch(() => null),
    document.fonts.load(`${FONT_SIZE}px ${FONT_DEPARTURE}`),
  ]);
  try {
    // With KHR_parallel_shader_compile the programs compile in parallel, off the main thread.
    [retroProgram, glyphProgram, compositeProgram] = await Promise.all([
      createProgramAsync(gl, FULLSCREEN_VS, sceneFs(3), SCENE_UNIFORMS),
      createProgramAsync(gl, GLYPH_VS, GLYPH_FS, GLYPH_UNIFORMS, { aPos: 0, aData: 1 }),
      createProgramAsync(gl, FULLSCREEN_VS, COMPOSITE_FS, COMPOSITE_UNIFORMS),
    ]);
  } catch (error) {
    console.warn('[scene] WebGL2 scene unavailable, using the 2D renderer', error);
    return null;
  }

  const [moonLow] = await firstAssets;

  const emptyVao = gl.createVertexArray();
  const glyphVao = gl.createVertexArray();
  const glyphBuffer = gl.createBuffer();
  gl.bindVertexArray(glyphVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, glyphBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
  gl.vertexAttribDivisor(0, 1);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
  gl.vertexAttribDivisor(1, 1);
  gl.bindVertexArray(null);

  const moonTexture = createTexture(gl, gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
  const moonTexels = 256;
  gl.bindTexture(gl.TEXTURE_2D, moonTexture);
  if (moonLow) {
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, moonLow);
    gl.generateMipmap(gl.TEXTURE_2D);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([160, 168, 170, 255]));
  }
  // Surface maps for the 2026 moon (equirectangular, near side); loaded lazily.
  const albedoTexture = createTexture(gl, gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
  const normalTexture = createTexture(gl, gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
  let moonMaps = 0;
  const uploadMap = (texture: WebGLTexture, image: HTMLImageElement): void => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
  };

  const columnTexture = createTexture(gl, gl.LINEAR, gl.LINEAR);
  // Cloth displacement (dx, dy per glyph cell) for the aurora, so it moves with the same physics.
  let columnWidth = 0;

  const pointer: Pointer = { x: 0, y: 0, vx: 0, vy: 0, active: false, pressed: false };
  // The frame counter is a review aid: `?fps=1` shows it.
  const statusFps = params.has('fps') ? document.querySelector<HTMLElement>('[data-scene-fps]') : null;
  if (statusFps) statusFps.hidden = false;

  const timeline = new EraTimeline();
  if (pinnedEra !== null) {
    timeline.target = Math.round(pinnedEra * LAST_STAGE);
    timeline.jump(pinnedEra * LAST_STAGE);
  }
  const listeners = new Set<(state: EraState) => void>();
  let lastEmitted = '';
  const emit = (force = false): void => {
    const state: EraState = {
      stage: timeline.stage,
      target: timeline.target,
      flicker: timeline.flicker,
      settled: timeline.settled,
    };
    const key = `${state.stage}|${state.target}|${state.flicker > 0 ? 1 : 0}|${state.settled ? 1 : 0}`;
    if (!force && key === lastEmitted) return;
    lastEmitted = key;
    for (const listener of listeners) listener(state);
  };

  let reveal = new Float32Array(0);
  // Slowly following reveal spots for the latent words: [x, y, strength] for the pointer and the idle wanderer.
  const spots = [
    { x: 0, y: 0, gain: 0 },
    { x: 0, y: 0, gain: 0 },
  ];
  let lastPointerMs = 0;
  let ocean: Ocean | null = null;
  let oceanCompact: boolean | null = null;
  let fftFrames = 0;
  let layout: Layout | null = null;
  let sceneTarget: Target | null = null;
  let sceneNearest = false;
  let modernReady = false;
  let visible = true;
  let destroyed = false;
  let unsubscribe: (() => void) | null = null;
  let clock = 0;
  let accumulator = 0;
  let pointerLight = 0;
  let lastStatus = 0;
  let statusFrames = 0;
  let builtWidth = 0;
  let builtHeight = 0;
  let slowAverage = 16;
  let slowFrames = 0;
  let fastFrames = 0;
  let scaleCeiling = 1.01;
  let glitchShift = 0;

  let oceanJob = 0;
  /** Builds the FFT ocean in the background; the previous one keeps serving until the new one is ready. */
  async function prepareOcean(compact: boolean): Promise<void> {
    oceanCompact = compact;
    if (fftOff) return;
    const job = ++oceanJob;
    // Narrow screens use 128-point tiles and two cascades; desktops 256 points and three.
    const next = await Ocean.create(gl!, { size: compact ? 128 : 256, cascades: compact ? 2 : 3, wind: 5, windAngle: 1.0 });
    if (destroyed || job !== oceanJob) {
      next?.destroy();
      return;
    }
    ocean?.destroy();
    ocean = next;
  }

  function basePixelFor(width: number, height: number): number {
    return clamp(Math.ceil(Math.sqrt((width * height) / 90000)), 3, MAX_BASE_PIXEL);
  }

  function makeAtlases(grids: { agc: GlyphGrid; code: GlyphGrid }, cellWidth: number, dpr: number): { departure: Atlas; modern: Atlas | null; modernRatio: number } {
    const departure = buildAtlas(gl!, grids.agc.chars, {
      family: FONT_DEPARTURE,
      size: FONT_SIZE,
      cellWidth,
      lineHeight: LINE_HEIGHT,
      scale: dpr,
      pad: 0,
      glow: false,
      crisp: true,
      baseline: 0.74,
    });
    const modernRatio = advanceRatio(FONT_MODERN);
    let modern: Atlas | null = null;
    if (modernReady) {
      const scale = Math.min(3, Math.max(2, dpr * 1.5));
      // A wide code alphabet must still fit the texture width limit (4096 on many phones).
      const maxScale = (4000 / grids.code.chars.length - 8) / (cellWidth + 2);
      modern = buildAtlas(gl!, grids.code.chars, {
        family: FONT_MODERN,
        size: cellWidth / modernRatio,
        cellWidth,
        lineHeight: LINE_HEIGHT,
        scale: Math.min(scale, Math.max(1.5, maxScale)),
        pad: Math.ceil(4 * Math.min(scale, Math.max(1.5, maxScale))),
        glow: true,
        crisp: false,
        baseline: 0.74,
      });
    }
    return { departure, modern, modernRatio };
  }

  function build(width: number, height: number): void {
    if (layout) {
      gl!.deleteTexture(layout.departure.texture);
      if (layout.modern) gl!.deleteTexture(layout.modern.texture);
      deleteTarget(gl!, layout.reflection);
      deleteTarget(gl!, layout.auroraMap);
      deleteTarget(gl!, layout.skyMap);
    }
    const compact = width < 900;
    // The ocean is first prepared together with the 2026 programs; later it follows the layout.
    if (oceanCompact !== null && oceanCompact !== compact) void prepareOcean(compact);
    const dpr = Math.min(window.devicePixelRatio || 1, compact ? 1.5 : 2);
    const horizon = Math.round(height * HORIZON);
    const fitHeight = (horizon - height * 0.09) / 1.12;
    const moonR = Math.min(width * (compact ? 0.44 : 0.36), fitHeight);

    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) throw new Error('2D canvas context is unavailable');
    measure.font = `100px ${FONT_DEPARTURE}`;
    const cellWidth = FONT_SIZE * (measure.measureText('M').width / 100);
    const cols = Math.ceil(width / cellWidth) + 1;
    const top = -LINE_HEIGHT * 0.5;
    const rows = Math.ceil((horizon - top) / LINE_HEIGHT);
    const agcGrid = layoutCode(AGC_LINES, cols, rows, { starts: [AGC_FAMOUS_LINE, AGC_FAMOUS_LINE + rows] });
    const codeGrid = layoutCode(SITE_CODE_LINES, cols, rows);
    const grids = { agc: toGlyphGrid(agcGrid), code: toGlyphGrid(codeGrid) };
    const grid = agcGrid;
    const atlases = makeAtlases(grids, cellWidth, dpr);

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const reflection = createTarget(
      gl!,
      Math.max(1, Math.ceil(width * REFLECTION_SCALE)),
      Math.max(1, Math.ceil(horizon * REFLECTION_SCALE)),
      false,
    );
    // Without float targets the maps fall back to 8 bits: the reflected moon then clips and looks a bit dimmer.
    const auroraMap = createLightTarget(gl!, Math.ceil(width / AURORA_TEXEL), Math.ceil(horizon / AURORA_TEXEL), false, hdrMaps);
    const skyMap = createLightTarget(gl!, Math.ceil(width / SKY_TEXEL), Math.ceil(horizon / SKY_TEXEL), true, hdrMaps);
    const profile = new Float64Array(cols * rows);
    const archGains = new Float64Array(cols);
    for (let i = 0; i < cols; i++) {
      const u = clamp((i * cellWidth + cellWidth / 2) / width, 0, 1);
      archGains[i] = archGain(u);
      for (let j = 0; j < rows; j++) {
        const vr = j / (rows - 1) / archReach(u);
        const vertical = (0.3 + 0.7 * smoothstep(0, 0.2, vr)) * (1 - smoothstep(0.3, 1.08, vr)) ** 1.1;
        profile[j * cols + i] = vertical < 0.02 ? 0 : vertical;
      }
    }
    const instanceFloats = grid.length * 5;
    gl!.bindBuffer(gl!.ARRAY_BUFFER, glyphBuffer);
    gl!.bufferData(gl!.ARRAY_BUFFER, instanceFloats * 4, gl!.DYNAMIC_DRAW);

    layout = {
      width,
      height,
      dpr,
      basePixel: basePixelFor(width, height),
      horizon,
      moonX: width / 2,
      moonY: horizon - moonR * 0.12,
      moonR,
      cols,
      rows,
      cellWidth,
      field: new CurtainField(cols, rows, cellWidth, LINE_HEIGHT, top),
      agc: grids.agc,
      code: grids.code,
      instances: new Float32Array(instanceFloats),
      columns: new Float32Array(cols * 2),
      departure: atlases.departure,
      modern: atlases.modern,
      reflection,
      auroraMap,
      skyMap,
      rayFrequency: compact ? 2.4 : 1,
      modernRatio: atlases.modernRatio,
      profile,
      archGains,
      rays: new Float64Array(cols),
      still: 'raw',
    };
    if (columnWidth !== cols) {
      columnWidth = cols;
      gl!.bindTexture(gl!.TEXTURE_2D, columnTexture);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RG16F, cols, 1, 0, gl!.RG, gl!.FLOAT, new Float32Array(cols * 2));
    }
    reveal = new Float32Array(cols * rows);
    builtWidth = width;
    builtHeight = height;
  }

  /** Curtain displacement and fold per column, read by the aurora glow behind it. */
  function sampleColumns(l: Layout): void {
    const { field, cols, columns } = l;
    const row = Math.min(field.rows - 1, Math.floor(field.rows * 0.4)) * cols;
    for (let i = 0; i < cols; i++) {
      const c = clamp(i, 1, cols - 2);
      columns[i * 2] = field.dx[row + c]!;
      const squeeze = -(field.dx[row + c + 1]! - field.dx[row + c - 1]!) / (2 * field.cellWidth);
      columns[i * 2 + 1] = clamp(squeeze * 1.2, 0, 0.7);
    }
    gl!.bindTexture(gl!.TEXTURE_2D, columnTexture);
    gl!.texSubImage2D(gl!.TEXTURE_2D, 0, 0, 0, cols, 1, gl!.RG, gl!.FLOAT, columns);
  }

  /** Moves the reveal spots (pointer, idle wanderer) and eases every glyph toward its target. */
  function updateReveal(l: Layout, seconds: number): void {
    const { field, cols, rows, cellWidth, width, horizon } = l;
    const radius = width < 900 ? 100 : 140;
    const idle = performance.now() - lastPointerMs > 6000;
    const follow = 1 - Math.exp(-seconds / 0.25);
    const wander = spots[1]!;
    const tx = width * (0.5 + 0.3 * Math.sin(clock * 0.06 + 1));
    const ty = horizon * (0.25 + 0.15 * Math.sin(clock * 0.09 + 2));
    wander.x += (tx - wander.x) * follow * 0.3;
    wander.y += (ty - wander.y) * follow * 0.3;
    wander.gain += ((idle ? 0.55 : 0) - wander.gain) * (1 - Math.exp(-seconds / 1.5));
    const mouse = spots[0]!;
    if (pointer.active) {
      if (mouse.gain < 0.02) {
        mouse.x = pointer.x;
        mouse.y = pointer.y;
      }
      mouse.x += (pointer.x - mouse.x) * follow;
      mouse.y += (pointer.y - mouse.y) * follow;
    }
    mouse.gain += ((pointer.active ? 1 : 0) - mouse.gain) * (1 - Math.exp(-seconds / 0.3));
    const rise = 1 - Math.exp(-seconds / 0.35);
    const fall = 1 - Math.exp(-seconds / 0.55);
    // A spot lights nothing beyond 1.8 radii, so cells outside that box skip the distance.
    const reach = 1.8 * radius;
    for (let j = 0; j < rows; j++) {
      const y = field.top + j * field.lineHeight;
      for (let i = 0; i < cols; i++) {
        const n = j * cols + i;
        const x = i * cellWidth;
        let target = 0;
        for (const spot of spots) {
          if (spot.gain < 0.01 || Math.abs(x - spot.x) >= reach || Math.abs(y - spot.y) >= reach) continue;
          const d = Math.hypot(x - spot.x, y - spot.y) / radius;
          if (d < 1.8) target = Math.max(target, spot.gain * Math.exp(-d * d * 1.6));
        }
        const v = reveal[n]!;
        reveal[n] = v + (target - v) * (target > v ? rise : fall);
        if (reveal[n]! < 0.002) reveal[n] = 0;
      }
    }
  }

  /** Fills the instance buffer with one entry per visible glyph; returns their count. */
  function writeGlyphs(l: Layout, look: EraLook, useModern: boolean): number {
    const { field, cols, rows, cellWidth, instances, width, rayFrequency, profile, archGains, rays } = l;
    const { slots, accent } = useModern ? l.code : l.agc;
    const { lineHeight, top, dx, dy, vx } = field;
    const radius = width < 900 ? 90 : 130;
    // Code leaves gaps between words, so it needs more light than justified prose to read as a sheet.
    const gain = (width < 900 ? 1.9 : 1) * 1.5;
    // With the curtain itself switched off only the latent trace is left; skip cells it does not light.
    const latent = look.reveal && look.glyph === 0 && look.alphaLevels === 0;
    if (!latent) for (let i = 0; i < cols; i++) rays[i] = rayAt(i, clock, rayFrequency);
    let count = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const n = j * cols + i;
        const vertical = profile[n]!;
        if (vertical === 0) continue;
        const slot = slots[n]!;
        if (slot < 0) continue;
        if (latent && reveal[n]! * 0.9 * Math.min(1, vertical * 1.6) < 0.04) continue;
        const x = i * cellWidth + dx[n]!;
        const y = top + j * lineHeight + dy[n]!;
        const iL = i > 0 ? n - 1 : n;
        const iR = i < cols - 1 ? n + 1 : n;
        const squeeze = clamp(-(dx[iR]! - dx[iL]!) / (2 * cellWidth), -0.4, 0.9);
        const ray = latent ? 0 : rays[i]!;
        let alpha = gain * archGains[i]! * vertical * ray * (0.7 + 0.9 * squeeze + Math.min(0.3, Math.abs(vx[n]!) * 0.35));
        if (pointerLight > 0.01 && !look.reveal) {
          const near = Math.hypot(x - pointer.x, y - pointer.y) / radius;
          if (near < 1.6) alpha += pointerLight * 0.6 * Math.exp(-near * near * 1.6);
        }
        if (look.reveal) {
          // Aurora era: the curtain text is only a latent trace that shows around the reveal spots.
          const trace = reveal[n]! * 0.9 * Math.min(1, vertical * 1.6);
          alpha = Math.max(alpha * look.glyph, trace);
        } else {
          alpha *= look.glyph;
        }
        alpha = clamp(alpha, 0, 0.92);
        if (look.alphaLevels > 0) alpha = Math.round(alpha * look.alphaLevels) / look.alphaLevels;
        if (alpha < 0.04) continue;
        const o = count * 5;
        instances[o] = x;
        instances[o + 1] = y;
        instances[o + 2] = slot;
        instances[o + 3] = alpha;
        instances[o + 4] = squeeze > 0.28 || accent[n] === 1 ? 1 : 0;
        count++;
      }
    }
    gl!.bindBuffer(gl!.ARRAY_BUFFER, glyphBuffer);
    gl!.bufferSubData(gl!.ARRAY_BUFFER, 0, instances, 0, count * 5);
    return count;
  }

  function drawGlyphs(atlas: Atlas, count: number, mode: 0 | 1, view: readonly [number, number], extra: (u: typeof glyphProgram.u) => void): void {
    const u = glyphProgram.u;
    gl!.useProgram(glyphProgram.program);
    gl!.bindVertexArray(glyphVao);
    bindTexture(gl!, 0, atlas.texture);
    gl!.uniform1i(u.uAtlas, 0);
    gl!.uniform2f(u.uView, view[0], view[1]);
    gl!.uniform2f(u.uQuad, atlas.quadWidth, atlas.quadHeight);
    gl!.uniform2f(u.uPad, atlas.padX, atlas.padY);
    gl!.uniform1f(u.uSlots, atlas.slots);
    gl!.uniform1f(u.uRows, atlas.rows);
    gl!.uniform1i(u.uMode, mode);
    gl!.uniform1f(u.uGlow, atlas.glow ? 1 : 0);
    extra(u);
    gl!.drawArraysInstanced(gl!.TRIANGLE_STRIP, 0, 4, count);
    gl!.bindVertexArray(null);
  }

  function render(): void {
    const l = layout;
    if (!l) return;
    const g = gl!;
    const look = lookAt(real ? timeline.stage : 0);
    const { width, height, dpr, horizon } = l;
    const canvasW = canvas.width;
    const canvasH = canvas.height;
    const native = 1 / (dpr * renderScale);
    const pix = pixelFor(look, l.basePixel, native);
    const texW = Math.ceil(width / pix);
    const texH = Math.ceil(height / pix);
    // Only the pixel-art stages scale up with hard edges; a lowered render scale in 2026 stays smooth.
    const nearest = look.pixelShare > 0 && pix * dpr >= 1.5;
    if (!sceneTarget || sceneTarget.width !== texW || sceneTarget.height !== texH || sceneNearest !== nearest) {
      deleteTarget(g, sceneTarget);
      sceneTarget = createTarget(g, texW, texH, nearest);
      sceneNearest = nearest;
    }

    if (ocean && look.mode > 0) {
      ocean.measure = fftLog;
      for (let k = 0; k < gpuLoad; k++) ocean.update(clock);
      if (fftLog && ++fftFrames % 30 === 0) console.info(`[scene] fft ${ocean.lastMs.toFixed(2)} ms (cpu + finish), mss ${ocean.binding.lost[0]!.toFixed(4)}`);
    }
    sampleColumns(l);
    const useModern = look.modern && l.modern !== null;
    const atlas = useModern && l.modern ? l.modern : l.departure;
    const count = writeGlyphs(l, look, useModern);

    // Every pass rewrites its whole target (the additive ones after a clear or a composite), so
    // repeating them for `?gpuload` leaves the picture unchanged.
    for (let k = 0; k < gpuLoad; k++) {
      // 1. Reflection map: the curtain as plain light, half resolution, above the horizon only.
      g.bindFramebuffer(g.FRAMEBUFFER, l.reflection.framebuffer);
      g.viewport(0, 0, l.reflection.width, l.reflection.height);
      g.clearColor(0, 0, 0, 1);
      g.clear(g.COLOR_BUFFER_BIT);
      g.enable(g.BLEND);
      g.blendFunc(g.ONE, g.ONE);
      drawGlyphs(atlas, count, 1, [width, horizon], (u) => g.uniform1f(u.uShift, 0));

      // 2. The scene shader: coarse aurora and sky maps first, then the scene at era resolution.
      g.disable(g.BLEND);
      g.bindVertexArray(emptyVao);
      bindTexture(g, 0, moonTexture);
      bindTexture(g, 1, columnTexture);
      bindTexture(g, 2, l.reflection.texture);
      bindTexture(g, 3, albedoTexture);
      bindTexture(g, 4, normalTexture);
      if (ocean) {
        const t = ocean.textures;
        // With two cascades the unused third pair repeats the second so every sampler stays valid.
        for (let n = 0; n < 6; n++) bindTexture(g, 5 + n, t[n < t.length ? n : t.length - 2 + (n % 2)]!);
      }
      const { auroraMap, skyMap } = l;
      const drawPass = (program: SceneProgram, target: Target, pixel: number): void => {
        const s = program.u;
        g.useProgram(program.program);
        if (ocean) {
          const b = ocean.binding;
          g.uniform1i(s.uSeaA0, 5);
          g.uniform1i(s.uSeaB0, 6);
          g.uniform1i(s.uSeaA1, 7);
          g.uniform1i(s.uSeaB1, 8);
          g.uniform1i(s.uSeaA2, 9);
          g.uniform1i(s.uSeaB2, 10);
          g.uniform1f(s.uFft, 1);
          g.uniform3f(s.uSeaTile, b.tiles[0]!, b.tiles[1]!, b.tiles[2] ?? 0);
          g.uniform3f(s.uSeaTexel, b.texel[0]!, b.texel[1]!, b.texel[2] ?? 1);
          g.uniform3f(s.uSeaLam, b.lambda[0]!, b.lambda[1]!, b.lambda[2] ?? 0);
          g.uniform1f(s.uSeaHeight, 5 * Math.sqrt(Math.max(1, 1440 / width)));
          g.uniform1fv(s.uLost, b.lost);
        } else {
          g.uniform1f(s.uFft, 0);
        }
        g.uniform1i(s.uAlbedoMap, 3);
        g.uniform1i(s.uNormalMap, 4);
        g.uniform1i(s.uMoonTex, 0);
        g.uniform1i(s.uColumns, 1);
        g.uniform1i(s.uCurtain, 2);
        g.uniform2f(s.uCss, width, height);
        g.uniform1f(s.uHorizon, horizon);
        g.uniform3f(s.uMoon, l.moonX, l.moonY, l.moonR);
        g.uniform1f(s.uTime, clock);
        g.uniform1i(s.uMode, look.mode);
        g.uniform1f(s.uMix, look.mix);
        g.uniform1f(s.uAurora, look.aurora);
        g.uniform1f(s.uMotion, options.reducedMotion ? 0 : 1);
        g.uniform2f(s.uMeteor, meteorSlot, meteorChance);
        g.uniform1f(s.uLevels, look.levels);
        g.uniform1f(s.uDither, look.dither);
        g.uniform3f(s.uPointer, pointer.active ? pointer.x : -9999, pointer.y, pointerLight);
        g.uniform1f(s.uCell, l.cellWidth);
        g.uniform1f(s.uColsN, l.cols);
        g.uniform1f(s.uRayFreq, l.rayFrequency);
        g.uniform1f(s.uMoonMaps, moonMaps);
        g.uniform1f(s.uMoonTexels, moonTexels);
        g.uniform2f(s.uCurtainView, width, horizon);
        g.uniform1i(s.uAuroraTex, 12);
        g.uniform1i(s.uSkyTex, 13);
        g.uniform2f(s.uAuroraSpan, auroraMap.width * AURORA_TEXEL, auroraMap.height * AURORA_TEXEL);
        g.uniform2f(s.uSkySpan, skyMap.width * SKY_TEXEL, skyMap.height * SKY_TEXEL);
        g.uniform1f(s.uSkyTexel, SKY_TEXEL);
        g.bindFramebuffer(g.FRAMEBUFFER, target.framebuffer);
        g.viewport(0, 0, target.width, target.height);
        g.uniform1f(s.uPix, pixel);
        g.uniform2f(s.uTexSize, target.width, target.height);
        g.drawArrays(g.TRIANGLES, 0, 3);
      };
      // A map must never be bound while it is the render target, so both start as a stand-in.
      bindTexture(g, 12, moonTexture);
      bindTexture(g, 13, moonTexture);
      // 1997 has its own small program and never reads the maps.
      if (look.mode === 0 || !real) {
        drawPass(retroProgram, sceneTarget, pix);
      } else {
        if (look.aurora > 0) drawPass(real.aurora, auroraMap, AURORA_TEXEL);
        bindTexture(g, 12, auroraMap.texture);
        drawPass(real.sky, skyMap, SKY_TEXEL);
        bindTexture(g, 13, skyMap.texture);
        g.generateMipmap(g.TEXTURE_2D);
        drawPass(real.scene, sceneTarget, pix);
      }

      // 3. Composite into the canvas.
      g.bindFramebuffer(g.FRAMEBUFFER, null);
      g.viewport(0, 0, canvasW, canvasH);
      const c = compositeProgram.u;
      g.useProgram(compositeProgram.program);
      bindTexture(g, 0, sceneTarget.texture);
      g.uniform1i(c.uScene, 0);
      g.uniform2f(c.uCanvas, canvasW, canvasH);
      g.uniform1f(c.uDpr, dpr);
      g.uniform1f(c.uPix, pix);
      g.uniform2f(c.uTexSize, texW, texH);
      g.uniform1f(c.uFlick, timeline.flicker * look.flicker);
      g.uniform1f(c.uScan, look.scan);
      g.uniform1f(c.uGrain, look.grain);
      g.uniform1f(c.uVignette, look.vignette);
      g.uniform1f(c.uTime, clock);
      g.uniform1f(c.uShift, glitchShift);
      g.uniform1f(c.uHorizon, horizon);
      g.uniform1f(c.uCurve, look.camera * curveShare * width);
      g.uniform1f(c.uFringe, look.camera * LENS_FRINGE);
      g.drawArrays(g.TRIANGLES, 0, 3);
      g.bindVertexArray(null);

      // 4. The curtain over the picture; dark lace is decided from the scene brightness.
      g.enable(g.BLEND);
      g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
      bindTexture(g, 1, sceneTarget.texture);
      drawGlyphs(atlas, count, 0, [width, height], (u) => {
        g.uniform1i(u.uScene, 1);
        g.uniform4f(u.uSceneMap, pix * texW, pix * texH, 0, 0);
        g.uniform2f(u.uCanvas, canvasW, canvasH);
        g.uniform1f(u.uDpr, dpr);
        g.uniform1f(u.uShift, glitchShift);
        g.uniform1f(u.uLit, look.reveal ? 1 : 0);
      });
      g.disable(g.BLEND);
    }
  }

  function writeStatus(elapsedMs: number): void {
    if (statusFps && statusFrames > 0 && elapsedMs < 1000) {
      // Frame interval, not GPU time: rAF caps it at the display rate, so the render scale shows the rest.
      const frameMs = elapsedMs / statusFrames;
      statusFps.textContent = `FPS ${Math.round(1000 / frameMs)} ${frameMs.toFixed(1)}MS ×${renderScale.toFixed(1)}${gpuLoad > 1 ? ` LOAD ${gpuLoad}` : ''}`;
    }
    statusFrames = 0;
  }

  function adaptQuality(deltaMs: number): void {
    if (scalePinned || timeline.stage !== LAST_STAGE || !timeline.settled || deltaMs > 250) return;
    slowAverage += (deltaMs - slowAverage) * 0.05;
    // Aim at 60 fps: frames longer than ~19 ms (about 52 fps) on average lower the scale.
    slowFrames = slowAverage > 19 ? slowFrames + 1 : 0;
    fastFrames = slowAverage < 17.8 ? fastFrames + 1 : 0;
    if (slowFrames > 45 && renderScale > MIN_SCALE) {
      scaleCeiling = renderScale;
      renderScale = Math.max(MIN_SCALE, Math.round((renderScale - 0.1) * 10) / 10);
      slowFrames = 0;
      slowAverage = 16;
    } else if (fastFrames > 600 && renderScale + 0.1 < scaleCeiling) {
      renderScale = Math.min(1, Math.round((renderScale + 0.1) * 10) / 10);
      fastFrames = 0;
    }
  }

  function tick(_time: number, delta: number): void {
    const l = layout;
    if (!l) return;
    const dt = Math.min(delta, 50);
    clock += dt / 1000;
    accumulator += dt;
    let steps = 0;
    while (accumulator >= STEP_MS && steps < 4) {
      l.field.step();
      accumulator -= STEP_MS;
      steps++;
    }
    if (steps === 4) accumulator = 0;
    l.field.applyPointer(pointer, l.width < 900 ? 90 : 130, dt / STEP_MS);
    pointer.vx = 0;
    pointer.vy = 0;
    pointerLight += ((pointer.active ? 1 : 0) - pointerLight) * 0.08;

    if (pinnedEra === null) {
      timeline.update(Math.min(delta, 250) / 1000);
      emit();
    }
    const burst = timeline.flicker * lookAt(timeline.stage).flicker;
    if (lookAt(timeline.stage).reveal) updateReveal(l, dt / 1000);
    glitchShift = burst > 0.02 ? (Math.random() - 0.5) * 16 * burst : 0;
    render();
    adaptQuality(delta);

    statusFrames++;
    const now = performance.now();
    if (now - lastStatus > 250) {
      writeStatus(now - lastStatus);
      lastStatus = now;
    }
  }

  function updateLoop(): void {
    const shouldRun = visible && !options.reducedMotion && !destroyed;
    if (shouldRun && !unsubscribe) unsubscribe = onTick(tick);
    if (!shouldRun && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  function drawStill(): void {
    const l = layout;
    if (!l) return;
    // `?time=` picks the still frame's moment (review aid for comparing wave motion).
    clock = stillTime;
    pointerLight = 0;
    glitchShift = 0;
    render();
    writeStatus(0);
    // The cloth is fast-forwarded once per layout, in slices, and the still is redrawn when it is done.
    if (l.still !== 'raw') return;
    l.still = 'settling';
    void l.field.settleInSlices(Math.round(STILL_TIME * 60), () => !destroyed && layout === l).then((done) => {
      if (!done) return;
      l.still = 'settled';
      render();
    });
  }

  function resize(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const heightJump = Math.abs(height - builtHeight) > 160;
    if (!layout || width !== builtWidth || heightJump) {
      build(width, height);
      if (options.reducedMotion) drawStill();
    }
  }

  const onMove = (event: PointerEvent): void => {
    lastPointerMs = performance.now();
    if (pointer.active) {
      pointer.vx += event.clientX - pointer.x;
      pointer.vy += event.clientY - pointer.y;
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
    pointer.pressed = event.buttons > 0 || event.pointerType === 'touch';
  };
  const onDown = (event: PointerEvent): void => {
    onMove(event);
    pointer.pressed = true;
  };
  const onUp = (event: PointerEvent): void => {
    pointer.pressed = false;
    if (event.pointerType === 'touch') pointer.active = false;
  };
  const onLeave = (): void => {
    pointer.active = false;
    pointer.pressed = false;
  };
  const onContextLost = (event: Event): void => {
    event.preventDefault();
    options.onLost();
  };
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', onDown, { passive: true });
  window.addEventListener('pointerup', onUp, { passive: true });
  window.addEventListener('pointercancel', onUp, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('webglcontextlost', onContextLost);

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  const intersection = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    updateLoop();
  });
  intersection.observe(canvas);

  /** Heavier assets arrive after the first frame so the 1997 picture never waits for them. */
  let highRequested = false;
  const loadHeavyAssets = (): void => {
    if (highRequested || destroyed) return;
    highRequested = true;
    void Promise.all([loadImage(MOON_ALBEDO_URL), loadImage(MOON_NORMAL_URL)])
      .then(([albedo, normal]) => {
        if (destroyed) return;
        uploadMap(albedoTexture, albedo);
        uploadMap(normalTexture, normal);
        moonMaps = 1;
        if (options.reducedMotion) drawStill();
      })
      .catch(() => undefined);
    void document.fonts.load(`${FONT_SIZE}px ${FONT_MODERN}`, SITE_CODE_LINES.join('\n').slice(0, 600)).then(() => {
      if (destroyed) return;
      modernReady = true;
      if (layout) {
        layout.modern = makeAtlases({ agc: layout.agc, code: layout.code }, layout.cellWidth, layout.dpr).modern;
        if (options.reducedMotion) drawStill();
      }
    });
  };
  if (window.requestIdleCallback) window.requestIdleCallback(loadHeavyAssets, { timeout: 2500 });
  else window.setTimeout(loadHeavyAssets, 1200);

  resize();
  updateLoop();
  if (pinnedEra !== null) {
    loadHeavyAssets();
    emit(true);
  }

  // The 2026 programs start after the first 1997 frames: without KHR_parallel_shader_compile their
  // compile blocks the page, and the visitor should at least see the picture meanwhile.
  let compiled = 0;
  const count = <T>(promise: Promise<T>): Promise<T> => promise.then((value) => {
    compiled++;
    return value;
  });
  const ready = new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    .then(() => Promise.all([
      count(createProgramAsync(gl, FULLSCREEN_VS, sceneFs(0), SCENE_UNIFORMS)),
      count(createProgramAsync(gl, FULLSCREEN_VS, sceneFs(1), SCENE_UNIFORMS)),
      count(createProgramAsync(gl, FULLSCREEN_VS, sceneFs(2), SCENE_UNIFORMS)),
      // 1997 never uses the FFT sea, so it is built alongside and ready before the first 2026 frame.
      prepareOcean(canvas.clientWidth < 900),
    ]))
    .then(
    ([scene, aurora, sky]) => {
      if (destroyed) {
        for (const program of [scene, aurora, sky]) gl.deleteProgram(program.program);
        return false;
      }
      real = { scene, aurora, sky };
      if (options.reducedMotion) drawStill();
      return true;
    },
    (error: unknown) => {
      console.warn('[scene] 2026 scene unavailable, staying in 1997', error);
      return false;
    },
  );

  return {
    get target() {
      return timeline.target;
    },
    ready,
    get compiled() {
      return compiled / 3;
    },
    setStage(stage: EraStage): void {
      const target = clamp(Math.round(stage), 0, LAST_STAGE);
      if (!real || timeline.target === target) return;
      timeline.target = target;
      loadHeavyAssets();
      if (options.reducedMotion) {
        timeline.jump(target);
        drawStill();
      }
      emit(true);
    },
    onEra(listener) {
      listeners.add(listener);
      listener({ stage: timeline.stage, target: timeline.target, flicker: timeline.flicker, settled: timeline.settled });
      return () => listeners.delete(listener);
    },
    destroy() {
      destroyed = true;
      updateLoop();
      resizeObserver.disconnect();
      intersection.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      listeners.clear();
      gl.deleteProgram(retroProgram.program);
      if (real) for (const program of [real.scene, real.aurora, real.sky]) gl.deleteProgram(program.program);
      gl.deleteProgram(glyphProgram.program);
      gl.deleteProgram(compositeProgram.program);
      gl.deleteTexture(moonTexture);
      gl.deleteTexture(albedoTexture);
      gl.deleteTexture(normalTexture);
      ocean?.destroy();
      gl.deleteTexture(columnTexture);
      gl.deleteBuffer(glyphBuffer);
      gl.deleteVertexArray(glyphVao);
      gl.deleteVertexArray(emptyVao);
      deleteTarget(gl, sceneTarget);
      if (layout) {
        deleteTarget(gl, layout.reflection);
        deleteTarget(gl, layout.auroraMap);
        deleteTarget(gl, layout.skyMap);
        gl.deleteTexture(layout.departure.texture);
        if (layout.modern) gl.deleteTexture(layout.modern.texture);
      }
    },
  };
}
