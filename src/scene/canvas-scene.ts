import { onTick } from '../lib/ticker';
import { layoutSheet } from './layout';
import { archGain, archReach } from './arch';
import { Backdrop, type BackdropInput, type MoonMap } from './backdrop';
import { CurtainField, STEP_MS, type Pointer } from './field';
import { CURTAIN_TEXT } from './text';

export interface AuroraOptions {
  reducedMotion: boolean;
}

export interface AuroraApi {
  destroy(): void;
}

const FONT_FAMILY = '"Departure Mono", ui-monospace, monospace';
const FONT_SIZE = 11;
const LINE_HEIGHT = 13;
/** Share of the viewport height taken by the sky; the sea fills the rest. */
const HORIZON = 0.66;
const MOON_URL = '/moon/moon.png';
/** The reflection compresses the sky by this factor when mapped onto the sea. */
const REFLECTION_STRETCH = 1.5;
const GLYPH_WHITE = '#dfe8e6';
const GLYPH_ACCENT = '#a1caf1';
/** Glyphs in front of the bright Moon are drawn as dark lace instead. */
const GLYPH_DARK = '#03060a';
const MAX_PIXEL = 6;
/** [width share, extra alpha share] of each nested reflection slice, widest first. */
const REFLECTION_LENS: readonly (readonly [number, number])[] = [
  [1, 1],
  [0.6, 0.4],
  [0.42, 0.4],
  [0.28, 0.4],
];
const STILL_TIME = 11;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Vertical bands of the aurora: wide drifting rays with finer streaks inside. */
/** Narrow screens show few columns, so the bands are made narrower to fit several in view. */
let rayFrequency = 1;

function rayAt(column: number, t: number): number {
  const col = column * rayFrequency;
  const band = 0.5 + 0.5 * Math.sin(col * 0.085 + 2.4 * Math.sin(col * 0.037 + t * 0.15) + t * 0.22);
  const streak = 0.5 + 0.5 * Math.sin(col * 0.31 - t * 0.35);
  return 0.06 + band ** 1.7 * (0.65 + 0.35 * streak);
}

interface Atlas {
  canvas: HTMLCanvasElement;
  index: Map<string, number>;
  cellWidth: number;
  cellHeight: number;
}

function buildAtlas(grid: readonly string[], font: string, cellWidth: number, dpr: number): Atlas {
  const chars = [...new Set(grid)].filter((char) => char !== ' ');
  const index = new Map(chars.map((char, n) => [char, n]));
  const cw = Math.ceil(cellWidth * dpr);
  const ch = Math.ceil(LINE_HEIGHT * dpr);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, chars.length * cw);
  canvas.height = ch * 3;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas context is unavailable');
  g.font = font.replace(/^\d+px/, `${FONT_SIZE * dpr}px`);
  g.textBaseline = 'alphabetic';
  [GLYPH_WHITE, GLYPH_ACCENT, GLYPH_DARK].forEach((color, row) => {
    g.fillStyle = color;
    chars.forEach((char, n) => g.fillText(char, n * cw, row * ch + ch * 0.74));
  });
  return { canvas, index, cellWidth: cw, cellHeight: ch };
}

interface Scene {
  width: number;
  height: number;
  dpr: number;
  pixel: number;
  backdrop: Backdrop;
  field: CurtainField;
  atlas: Atlas;
  slots: Int16Array;
  accent: Uint8Array;
  layer: HTMLCanvasElement;
  layerCtx: CanvasRenderingContext2D;
  shift: Float32Array;
  fold: Float32Array;
  ray: Float32Array;
}

/**
 * Wires the scene to a canvas: sky and sea backdrop, the glyph curtain, its
 * reflection, fixed-step physics on the shared ticker and pointer input.
 */
/** Loads the Moon disc as a luminance map; the scene falls back to a plain disc if it fails. */
async function loadMoon(): Promise<MoonMap | null> {
  try {
    const image = new Image();
    image.src = MOON_URL;
    await image.decode();
    const size = Math.min(image.naturalWidth, image.naturalHeight);
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const cg = c.getContext('2d', { willReadFrequently: true });
    if (!cg) return null;
    cg.drawImage(image, 0, 0, size, size);
    const rgba = cg.getImageData(0, 0, size, size).data;
    const data = new Float32Array(size * size);
    for (let n = 0; n < data.length; n++) data[n] = (rgba[n * 4] ?? 0) / 255;
    return { size, data };
  } catch {
    return null;
  }
}

export async function createAurora(
  canvas: HTMLCanvasElement,
  options: AuroraOptions,
): Promise<AuroraApi> {
  const g = canvas.getContext('2d', { alpha: false });
  if (!g) throw new Error('2D canvas context is unavailable');
  const [, moon] = await Promise.all([document.fonts.load(`${FONT_SIZE}px ${FONT_FAMILY}`), loadMoon()]);

  const pointer: Pointer = { x: 0, y: 0, vx: 0, vy: 0, active: false, pressed: false };

  let scene: Scene | null = null;
  let pixelOverride = 0;
  let visible = true;
  let destroyed = false;
  let unsubscribe: (() => void) | null = null;
  let clock = 0;
  let accumulator = 0;
  let pointerLight = 0;
  let cost = 8;
  let slowFrames = 0;
  let builtWidth = 0;
  let builtHeight = 0;

  function basePixel(width: number, height: number): number {
    return clamp(Math.ceil(Math.sqrt((width * height) / 90000)), 3, MAX_PIXEL);
  }

  function build(width: number, height: number): void {
    const compact = width < 900;
    rayFrequency = compact ? 2.4 : 1;
    const dpr = Math.min(window.devicePixelRatio || 1, compact ? 1.5 : 2);
    const pixel = Math.max(pixelOverride, basePixel(width, height));
    const backdrop = new Backdrop(Math.ceil(width / pixel), Math.ceil(height / pixel), HORIZON, compact, moon);

    g!.font = `100px ${FONT_FAMILY}`;
    const cellRatio = g!.measureText('M').width / 100;
    const cellWidth = FONT_SIZE * cellRatio;
    const font = `${FONT_SIZE}px ${FONT_FAMILY}`;
    const cols = Math.ceil(width / cellWidth) + 1;
    const skyHeight = backdrop.horizon * pixel;
    const top = -LINE_HEIGHT * 0.5;
    const rows = Math.ceil((skyHeight - top) / LINE_HEIGHT);

    const grid = layoutSheet(CURTAIN_TEXT, font, cellWidth, cols, rows);
    const atlas = buildAtlas(grid, font, cellWidth, dpr);
    const slots = new Int16Array(grid.length);
    const accent = new Uint8Array(grid.length);
    grid.forEach((char, n) => {
      slots[n] = atlas.index.get(char) ?? -1;
      const h = Math.imul(n + 1, 2654435761) >>> 0;
      accent[n] = char !== ' ' && h % 53 === 0 ? 1 : 0;
    });

    const layer = document.createElement('canvas');
    layer.width = Math.round(width * dpr);
    layer.height = Math.round(height * dpr);
    const layerCtx = layer.getContext('2d');
    if (!layerCtx) throw new Error('2D canvas context is unavailable');

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    scene = {
      width,
      height,
      dpr,
      pixel,
      backdrop,
      field: new CurtainField(cols, rows, cellWidth, LINE_HEIGHT, top),
      atlas,
      slots,
      accent,
      layer,
      layerCtx,
      shift: new Float32Array(backdrop.width),
      fold: new Float32Array(backdrop.width),
      ray: new Float32Array(backdrop.width),
    };
    builtWidth = width;
    builtHeight = height;
  }

  /** Samples the curtain once per frame for the glow behind it. */
  function sampleColumns(s: Scene): void {
    const { field, backdrop, pixel, shift, fold, ray } = s;
    const row = Math.min(field.rows - 1, Math.floor(field.rows * 0.4)) * field.cols;
    for (let x = 0; x < backdrop.width; x++) {
      const col = clamp(Math.round((x * pixel) / field.cellWidth), 1, field.cols - 2);
      shift[x] = field.dx[row + col]! / pixel;
      const squeeze = -(field.dx[row + col + 1]! - field.dx[row + col - 1]!) / (2 * field.cellWidth);
      fold[x] = clamp(squeeze * 1.2, 0, 0.7);
      ray[x] = rayAt((x * pixel - shift[x]! * pixel) / field.cellWidth, clock);
    }
  }

  function drawGlyphs(s: Scene): void {
    const { field, layerCtx: lg, atlas, slots, accent, dpr, backdrop } = s;
    const { cols, rows, cellWidth, lineHeight, top, dx, dy, vx } = field;
    lg.setTransform(1, 0, 0, 1, 0, 0);
    lg.clearRect(0, 0, s.layer.width, s.layer.height);
    lg.setTransform(dpr, 0, 0, dpr, 0, 0);
    const radius = s.width < 900 ? 90 : 130;
    // Narrow screens show few columns, so each glyph carries more light.
    const gain = s.width < 900 ? 1.9 : 1;
    const t = clock;
    const px = pointer.x;
    const py = pointer.y;

    const blit = (row: number, a: number, x: number, y: number, slot: number): void => {
      const q = Math.round(a * 14) / 14;
      if (q < 0.04) return;
      lg.globalAlpha = q;
      lg.drawImage(atlas.canvas, slot * atlas.cellWidth, row * atlas.cellHeight, atlas.cellWidth, atlas.cellHeight, x, y, cellWidth, lineHeight);
    };

    for (let j = 0; j < rows; j++) {
      const v = j / (rows - 1);
      for (let i = 0; i < cols; i++) {
        const u = clamp((i * cellWidth + cellWidth / 2) / s.width, 0, 1);
        const vr = v / archReach(u);
        const vertical = (0.3 + 0.7 * smoothstep(0, 0.2, vr)) * (1 - smoothstep(0.3, 1.08, vr)) ** 1.1;
        if (vertical < 0.02) continue;
        const n = j * cols + i;
        const slot = slots[n]!;
        if (slot < 0) continue;
        const x = i * cellWidth + dx[n]!;
        const y = top + j * lineHeight + dy[n]!;
        const iL = i > 0 ? n - 1 : n;
        const iR = i < cols - 1 ? n + 1 : n;
        const squeeze = clamp(-(dx[iR]! - dx[iL]!) / (2 * cellWidth), -0.4, 0.9);
        const ray = rayAt(i, t);
        let alpha = gain * archGain(u) * vertical * ray * (0.7 + 0.9 * squeeze + Math.min(0.3, Math.abs(vx[n]!) * 0.35));
        if (pointerLight > 0.01) {
          const near = Math.hypot(x - px, y - py) / radius;
          if (near < 1.6) alpha += pointerLight * 0.6 * Math.exp(-near * near * 1.6);
        }
        alpha = clamp(alpha, 0, 0.92);
        // Over the lit Moon and its halo the curtain turns into dark lace.
        const bright = backdrop.brightness((x + cellWidth / 2) / s.pixel, (y + lineHeight / 2) / s.pixel);
        const dark = smoothstep(0.36, 0.56, bright);
        const light = 1 - smoothstep(0.3, 0.5, bright);
        const green = squeeze > 0.28 || accent[n] === 1;
        blit(green ? 1 : 0, alpha * light, x, y, slot);
        blit(2, Math.min(0.95, alpha * 1.15 + 0.12 * Math.min(1, alpha * 3)) * dark, x, y, slot);
      }
    }
    lg.globalAlpha = 1;
  }

  /** Mirrors the curtain into the sea in wobbling pixel-high strips. */
  function drawReflection(s: Scene): void {
    const { backdrop, pixel, layer, dpr, width } = s;
    const horizon = backdrop.horizon * pixel;
    const span = backdrop.height - backdrop.horizon;
    g!.globalCompositeOperation = 'lighter';
    for (let y = backdrop.horizon + 1; y < backdrop.height; y++) {
      const d = (y - backdrop.horizon) / span;
      const dstY = y * pixel;
      const srcHeight = pixel * REFLECTION_STRETCH;
      const srcY = horizon - (dstY + pixel - horizon) * REFLECTION_STRETCH;
      if (srcY + srcHeight <= 0) break;
      const wobble = Math.sin(y * 0.55 + clock * 1.3 + Math.sin(y * 0.17 + clock * 0.4) * 2);
      const offset = Math.round(wobble * (0.8 + 3.2 * d)) * pixel;
      const base = 0.5 * smoothstep(0, 0.12, d) * (1 - 0.45 * d);
      // Nested slices around the axis stack up into a soft lens: the Moon's path reflects the curtain best.
      for (const [half, extra] of REFLECTION_LENS) {
        const span = width * half;
        const x0 = (width - span) / 2;
        g!.globalAlpha = half === 1 ? base : base * extra;
        g!.drawImage(
          layer,
          x0 * dpr,
          Math.max(0, srcY) * dpr,
          span * dpr,
          srcHeight * dpr,
          x0 + offset,
          dstY,
          span,
          pixel,
        );
      }
    }
    g!.globalAlpha = 1;
    g!.globalCompositeOperation = 'source-over';
  }

  function render(): void {
    const s = scene;
    if (!s) return;
    sampleColumns(s);
    const input: BackdropInput = {
      time: clock,
      shift: s.shift,
      fold: s.fold,
      ray: s.ray,
      pointerX: pointer.x / s.pixel,
      pointerY: pointer.y / s.pixel,
      pointerLight,
    };
    s.backdrop.draw(input);
    drawGlyphs(s);

    g!.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    g!.imageSmoothingEnabled = false;
    g!.drawImage(s.backdrop.canvas, 0, 0, s.backdrop.width * s.pixel, s.backdrop.height * s.pixel);
    g!.imageSmoothingEnabled = true;
    drawReflection(s);
    g!.drawImage(s.layer, 0, 0, s.layer.width / s.dpr, s.layer.height / s.dpr);
  }

  function adaptQuality(): void {
    if (!scene) return;
    slowFrames = cost > 15 ? slowFrames + 1 : 0;
    if (slowFrames > 90 && scene.pixel < MAX_PIXEL) {
      slowFrames = 0;
      pixelOverride = scene.pixel + 1;
      build(builtWidth, builtHeight);
    }
  }

  function tick(_time: number, delta: number): void {
    const s = scene;
    if (!s) return;
    const dt = Math.min(delta, 50);
    clock += dt / 1000;
    accumulator += dt;
    let steps = 0;
    while (accumulator >= STEP_MS && steps < 4) {
      s.field.step();
      accumulator -= STEP_MS;
      steps++;
    }
    if (steps === 4) accumulator = 0;
    s.field.applyPointer(pointer, s.width < 900 ? 90 : 130, dt / STEP_MS);
    pointer.vx = 0;
    pointer.vy = 0;
    pointerLight += ((pointer.active ? 1 : 0) - pointerLight) * 0.08;

    const start = performance.now();
    render();
    cost += (performance.now() - start - cost) * 0.05;
    adaptQuality();
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
    const s = scene;
    if (!s) return;
    clock = STILL_TIME;
    pointerLight = 0;
    render();
    // The cloth is fast-forwarded in slices so a large screen does not freeze; the still is redrawn after.
    void s.field.settleInSlices(Math.round(STILL_TIME * 60), () => !destroyed && scene === s).then((done) => {
      if (done) render();
    });
  }

  function resize(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const heightJump = Math.abs(height - builtHeight) > 160;
    if (!scene || width !== builtWidth || heightJump) {
      build(width, height);
      if (options.reducedMotion) drawStill();
    }
  }

  const onMove = (event: PointerEvent): void => {
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
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', onDown, { passive: true });
  window.addEventListener('pointerup', onUp, { passive: true });
  window.addEventListener('pointercancel', onUp, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  const intersection = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    updateLoop();
  });
  intersection.observe(canvas);

  resize();
  updateLoop();

  return {
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
    },
  };
}
