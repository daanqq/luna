/**
 * Time travel: seven discrete "graphics eras", and every step changes one thing.
 *   0  1997: stylised scene, hand-made ramps (~8 levels), pixel 1, Bayer dither
 *   1  content 50%: realistic forms dissolve in (ordered mask), same ramps and pixels
 *   2  content 100%: realistic forms fully, still in the 1997 ramps
 *   3  shades: the same teal-grey tint with 24 levels, pixel ~0.8
 *   4  colour arrives: 4 levels per channel (~64 colours), dithered, pixel 0.5
 *   5  ~216 colours, light dither, pixel 0.34
 *   6  2026: continuous colour, native resolution
 * The text curtain belongs to 1997: from stage 3 it fades while a real aurora grows in its place
 * (stage 3 halves the words, stage 4 leaves only a trace); later the words show only near the pointer.
 */
/** A stage on the ladder, 0 (1997 look) to LAST_STAGE (2026). */
export type EraStage = number;

/** How the scene shader colours a stage: 0 palette, 1 ramps + content mix, 2 fine tinted ramps, 3 colour. */
export type EraMode = 0 | 1 | 2 | 3;

export interface EraLook {
  /** Scene pixel size as a share of the base 1997 pixel; 0 means native resolution. */
  pixelShare: number;
  mode: EraMode;
  /** Share of cells showing the realistic scene (mode 1). */
  mix: number;
  /** Levels per channel (mode 3) or tint shades (mode 2); 0 is continuous. */
  levels: number;
  /** Bayer dither amplitude in [0, 1]. */
  dither: number;
  /** Quantisation steps of glyph alpha; 0 is continuous. */
  alphaLevels: number;
  /** Which glyph atlas is used. */
  modern: boolean;
  scan: number;
  grain: number;
  vignette: number;
  /** Strength of the CRT / glitch burst on entering this stage. */
  flicker: number;
  /** Aurora emission strength in the scene shader. */
  aurora: number;
  /** Multiplier of the always-visible glyph curtain. */
  glyph: number;
  /** Words appear only around the pointer, lit by the aurora. */
  reveal: boolean;
}

export const LAST_STAGE = 6;
/** Stage at which glyphs and overlay switch to Space Mono: when colour arrives. */
export const FONT_STAGE = 4;
const TRAVEL_SECONDS = 2.8;
const FLICKER_SECONDS = 0.3;

const STAGES: readonly EraLook[] = [
  { pixelShare: 1, mode: 0, mix: 0, levels: 0, dither: 1, alphaLevels: 14, modern: false, scan: 0, grain: 0, vignette: 0, flicker: 0.3, aurora: 0, glyph: 1, reveal: false },
  { pixelShare: 1, mode: 1, mix: 0.5, levels: 0, dither: 1, alphaLevels: 14, modern: false, scan: 0, grain: 0, vignette: 0, flicker: 0.3, aurora: 0, glyph: 1, reveal: false },
  { pixelShare: 1, mode: 1, mix: 1, levels: 0, dither: 1, alphaLevels: 14, modern: false, scan: 0, grain: 0, vignette: 0, flicker: 0.4, aurora: 0, glyph: 1, reveal: false },
  { pixelShare: 0.8, mode: 2, mix: 1, levels: 24, dither: 0.8, alphaLevels: 14, modern: false, scan: 0.08, grain: 0, vignette: 0.1, flicker: 0.5, aurora: 0.5, glyph: 0.5, reveal: false },
  { pixelShare: 0.5, mode: 3, mix: 1, levels: 4, dither: 1, alphaLevels: 0, modern: true, scan: 0.12, grain: 0.01, vignette: 0.25, flicker: 1, aurora: 1, glyph: 0.12, reveal: true },
  { pixelShare: 0.34, mode: 3, mix: 1, levels: 6, dither: 0.35, alphaLevels: 0, modern: true, scan: 0.06, grain: 0.02, vignette: 0.35, flicker: 0.8, aurora: 1, glyph: 0, reveal: true },
  { pixelShare: 0, mode: 3, mix: 1, levels: 0, dither: 0, alphaLevels: 0, modern: true, scan: 0, grain: 0.03, vignette: 0.4, flicker: 0.6, aurora: 1, glyph: 0, reveal: true },
];

export function lookAt(stage: number): EraLook {
  return STAGES[Math.max(0, Math.min(LAST_STAGE, stage))] ?? STAGES[0]!;
}

/** Scene pixel size in CSS px for a stage; `native` is the finest size the render scale allows. */
export function pixelFor(look: EraLook, basePixel: number, native: number): number {
  if (look.pixelShare === 0) return native;
  return Math.max(native, Math.round(basePixel * look.pixelShare));
}

/** Position on the stage ladder that moves toward the target stage in real time, one stage at a time. */
export class EraTimeline {
  position = 0;
  target: EraStage = 0;
  /** CRT / glitch burst in [0, 1], restarted on every stage change. */
  flicker = 0;
  private lastStage = 0;

  get stage(): number {
    return Math.round(this.position);
  }

  get settled(): boolean {
    return this.position === this.target;
  }

  /** Jumps without animation. */
  jump(position: number): void {
    this.position = Math.max(0, Math.min(LAST_STAGE, position));
    this.lastStage = this.stage;
    this.flicker = 0;
  }

  /** Advances by `seconds`; returns true when the visible state changed. */
  update(seconds: number): boolean {
    const goal = this.target;
    let changed = false;
    if (this.position !== goal) {
      // The early, content-changing steps linger a little longer than the later ones.
      const pace = this.position < 2.5 ? 0.8 : 1.1;
      const step = (LAST_STAGE / TRAVEL_SECONDS) * pace * seconds;
      this.position = this.position < goal ? Math.min(goal, this.position + step) : Math.max(goal, this.position - step);
      changed = true;
    }
    if (this.stage !== this.lastStage) {
      this.lastStage = this.stage;
      this.flicker = 1;
    } else if (this.flicker > 0) {
      this.flicker = Math.max(0, this.flicker - seconds / FLICKER_SECONDS);
      changed = true;
    }
    return changed;
  }
}
