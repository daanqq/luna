/**
 * The curtain as a damped wave field: every glyph keeps a displacement from its
 * rest cell. Neighbours pull on each other (so ripples travel), a weak spring
 * brings every glyph back home (so a torn gap closes) and the top row is pinned.
 */
export interface Pointer {
  x: number;
  y: number;
  /** Movement since the previous frame, CSS px. */
  vx: number;
  vy: number;
  active: boolean;
  pressed: boolean;
}

export const STEP_MS = 1000 / 60;

/** Neighbour coupling per step; must stay below 0.5 to remain stable. */
const COUPLING = 0.16;
const SPRING = 0.0045;
const DAMPING = 0.028;
const MAX_OFFSET = 420;
/** Line height the pointer impulses were tuned for; smaller glyphs get proportionally gentler pushes. */
const REFERENCE_LINE = 26;

export class CurtainField {
  readonly cols: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly lineHeight: number;
  readonly top: number;
  readonly dx: Float32Array;
  readonly dy: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  private time = 0;

  constructor(cols: number, rows: number, cellWidth: number, lineHeight: number, top: number) {
    this.cols = cols;
    this.rows = rows;
    this.cellWidth = cellWidth;
    this.lineHeight = lineHeight;
    this.top = top;
    const size = cols * rows;
    this.dx = new Float32Array(size);
    this.dy = new Float32Array(size);
    this.vx = new Float32Array(size);
    this.vy = new Float32Array(size);
  }

  /** One fixed physics step. */
  step(): void {
    const { cols, rows, dx, dy, vx, vy } = this;
    const t = (this.time += 1 / 60);
    const gust = 0.65 + 0.35 * Math.sin(t * 0.17) + 0.25 * Math.sin(t * 0.43 + 1.1);
    const amp = 0.0125 * gust;

    for (let j = 1; j < rows; j++) {
      // The hem swings more than the rail the curtain hangs from.
      const weight = (j / rows) ** 0.9;
      const row = j * cols;
      for (let i = 0; i < cols; i++) {
        const n = row + i;
        const l = i > 0 ? n - 1 : n;
        const r = i < cols - 1 ? n + 1 : n;
        const u = n - cols;
        const d = j < rows - 1 ? n + cols : n;
        const wave =
          0.55 * Math.sin(i * 0.052 - t * 0.62 + j * 0.035) +
          0.35 * Math.sin(i * 0.021 + t * 0.23 + 1.3) +
          0.22 * Math.sin(i * 0.13 - t * 1.05 + j * 0.08);
        const lapX = dx[l]! + dx[r]! + dx[u]! + dx[d]! - 4 * dx[n]!;
        const lapY = dy[l]! + dy[r]! + dy[u]! + dy[d]! - 4 * dy[n]!;
        vx[n] = vx[n]! + COUPLING * lapX - SPRING * dx[n]! - DAMPING * vx[n]! + amp * weight * wave;
        vy[n] =
          vy[n]! +
          COUPLING * lapY -
          SPRING * dy[n]! -
          DAMPING * vy[n]! +
          amp * 0.35 * weight * Math.cos(i * 0.043 - t * 0.5 + j * 0.06);
      }
    }
    for (let n = cols; n < dx.length; n++) {
      dx[n] = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, dx[n]! + vx[n]!));
      dy[n] = Math.max(-MAX_OFFSET * 0.5, Math.min(MAX_OFFSET * 0.5, dy[n]! + vy[n]!));
    }
  }

  /** Called once per frame: the pointer is a light breeze, a press parts the cloth. */
  applyPointer(pointer: Pointer, radius: number, frameScale: number): void {
    if (!pointer.active) return;
    const { cols, rows, cellWidth, lineHeight, top, dx, dy, vx, vy } = this;
    const reach = radius + 120;
    // The same push in px moves small glyphs much further relative to their size.
    const gain = Math.min(1, lineHeight / REFERENCE_LINE);
    const i0 = Math.max(0, Math.floor((pointer.x - reach) / cellWidth));
    const i1 = Math.min(cols - 1, Math.ceil((pointer.x + reach) / cellWidth));
    const j0 = Math.max(1, Math.floor((pointer.y - reach - top) / lineHeight));
    const j1 = Math.min(rows - 1, Math.ceil((pointer.y + reach - top) / lineHeight));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const n = j * cols + i;
        const ox = i * cellWidth + dx[n]! - pointer.x;
        const oy = top + j * lineHeight + dy[n]! - pointer.y;
        const dist = Math.hypot(ox, oy);
        if (dist >= radius) continue;
        const f = (1 - dist / radius) ** 2 * gain;
        const nx = dist > 0.001 ? ox / dist : 0;
        const ny = dist > 0.001 ? oy / dist : 0;
        // Moving the cursor stirs the air; keep it gentle.
        vx[n] = vx[n]! + pointer.vx * 0.014 * f + nx * 0.02 * f * frameScale;
        vy[n] = vy[n]! + pointer.vy * 0.01 * f + ny * 0.012 * f * frameScale;
        if (pointer.pressed) {
          vx[n] = vx[n]! + nx * 1.5 * f * frameScale;
          vy[n] = vy[n]! + ny * 0.4 * f * frameScale;
        }
      }
    }
  }

  /**
   * Fast-forwards the wind without a pointer for the reduced-motion still, in ~8 ms slices between
   * tasks: a 4K field takes seconds and would otherwise freeze the page. Resolves false when `alive`
   * turns false before the end.
   */
  async settleInSlices(steps: number, alive: () => boolean): Promise<boolean> {
    let left = steps;
    while (left > 0) {
      if (!alive()) return false;
      const end = performance.now() + 8;
      while (left > 0 && performance.now() < end) {
        this.step();
        left--;
      }
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return alive();
  }
}
