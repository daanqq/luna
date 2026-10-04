import { prefersReducedMotion } from '../lib/reduced-motion';
import { onTick } from '../lib/ticker';
import { FONT_STAGE, LAST_STAGE } from './era';
import type { SceneApi } from './scene';

/** Set after the first automatic trip to 2026; later visits start in 2001 and wait for the visitor. */
const INTRO_KEY = 'scene-intro-seen';
/** How long the 2026 shaders took last time on this device; drives the estimated progress bar. */
const COMPILE_KEY = 'scene-compile-ms';
const BAR_CELLS = 12;
/** The first-visit trip starts no earlier than this after the page opened, so 2001 gets a moment on screen. */
const INTRO_DELAY_MS = 6_000;

function introSeen(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) === '1';
  } catch {
    return false;
  }
}

function lastCompileMs(): number {
  try {
    return Number(localStorage.getItem(COMPILE_KEY)) || 8000;
  } catch {
    return 8000;
  }
}

function storeCompileMs(ms: number): void {
  try {
    localStorage.setItem(COMPILE_KEY, String(Math.round(ms)));
  } catch {
    // Without storage the next estimate falls back to the default.
  }
}

function markIntroSeen(): void {
  try {
    localStorage.setItem(INTRO_KEY, '1');
  } catch {
    // Storage may be blocked; the intro then simply plays again next time.
  }
}

/** How far the overlay drops on the n-th stage change of a trip (n = 1..LAST_STAGE - 1), and how far it recovers. */
const dipAt = (n: number): number => 0.8 - 0.15 * n;
const ceilingAt = (n: number): number => 1 - 0.11 * n;
/** Recovery time constant, and how long the overlay stays gone after arriving at either end. */
const RECOVER_SECONDS = 0.35;
const ARRIVAL_HOLD_MS = 3000;

/**
 * Overlay opacity during time travel. A trip runs from where the scene stood to where it stops, in one
 * direction; its n-th stage change drops the overlay at once and lets it creep back toward a ceiling,
 * both lower with every change, so a one-stage trip dips once and a three-stage trip three times, the
 * same both ways. A full trip end to end makes LAST_STAGE changes: its last one hides the overlay for a
 * few seconds before it fades back in. When the trip stops the overlay returns in full. The level is a
 * CSS variable on <body>, so the entrance and glitch animations still apply on top.
 */
function createOverlayFade(body: HTMLElement) {
  let level = 1;
  let goal = 1;
  let holdUntil = 0;
  /** Stage changes so far in the current trip, and its direction (0 while standing). */
  let steps = 0;
  let direction = 0;
  let unsubscribe: (() => void) | null = null;

  const apply = (): void => {
    body.style.setProperty('--scene-ui', level.toFixed(3));
    // An invisible link or slider must not catch a stray click.
    body.toggleAttribute('data-ui-gone', level < 0.05);
  };
  const tick = (time: number, delta: number): void => {
    if (time < holdUntil) level = 0;
    else level += (goal - level) * (1 - Math.exp(-delta / 1000 / RECOVER_SECONDS));
    if (time >= holdUntil && Math.abs(goal - level) < 0.002) {
      level = goal;
      unsubscribe?.();
      unsubscribe = null;
    }
    apply();
  };
  const run = (): void => {
    apply();
    unsubscribe ??= onTick(tick);
  };

  return {
    /** The scene moved one stage up (dir 1) or down (dir -1); turning back starts a new trip. */
    step(dir: 1 | -1): void {
      if (dir !== direction) steps = 0;
      direction = dir;
      const n = ++steps;
      if (n >= LAST_STAGE) {
        level = 0;
        goal = 1;
        holdUntil = performance.now() + ARRIVAL_HOLD_MS;
      } else {
        holdUntil = 0;
        level = Math.min(level, dipAt(n));
        goal = ceilingAt(n);
      }
      run();
    },
    /** The trip is over; after a full trip the overlay still sits out its hold. */
    settle(): void {
      steps = 0;
      direction = 0;
      if (level === 1 && goal === 1) return;
      goal = 1;
      run();
    },
    destroy(): void {
      unsubscribe?.();
      unsubscribe = null;
      body.style.removeProperty('--scene-ui');
      body.removeAttribute('data-ui-gone');
    },
  };
}

/** Screen reader value of a stage: the end years, or the step between them. */
function stageText(stage: number): string {
  if (stage === 0) return '2001';
  if (stage === LAST_STAGE) return '2026';
  return `step ${stage} of ${LAST_STAGE}, between 2001 and 2026`;
}

/**
 * Wires the `2001 [-------] 2026` scale to the scene: the slider picks any stage, the end years
 * make the full trip. While the 2026 shaders compile a loader stands in its place. On the first
 * visit the scene then travels to 2026 by itself, 6 s after the tab was first visible at the
 * earliest (or when the compile is done, if later) and never while the tab is hidden; the scale
 * appears once it has arrived. Later visits get it as soon as 2026 is ready. `body[data-era]` swaps the overlay typeface;
 * `data-glitch` restarts a stepped glitch each time the era stage changes.
 */
export function bindEraUi(api: SceneApi): () => void {
  const control = document.querySelector<HTMLElement>('[data-scene-era]');
  const range = control?.querySelector<HTMLInputElement>('[data-scene-era-range]');
  const ends = [...(control?.querySelectorAll<HTMLButtonElement>('[data-scene-stage]') ?? [])];
  const ticks = [...(control?.querySelectorAll<HTMLElement>('.scene-era-ticks > span') ?? [])];
  const loader = document.querySelector<HTMLElement>('[data-scene-loading]');
  const bar = document.querySelector<HTMLElement>('[data-scene-progress]');
  const body = document.body;
  if (!control || !range) return () => undefined;
  if (loader) loader.hidden = false;
  let intro = false;
  let unbound = false;
  let introTimer = 0;
  /** The intro waits for the tab: a page opened in the background should still show 2001 first. */
  let introPending = false;
  let visibleSince = document.hidden ? null : 0;
  const startIntro = (): void => {
    if (!introPending || document.hidden) return;
    const since = (visibleSince ??= performance.now());
    clearTimeout(introTimer);
    introTimer = window.setTimeout(() => {
      // Hidden again before the delay ran out: the next visibilitychange starts the trip.
      if (document.hidden) return;
      introPending = false;
      markIntroSeen();
      intro = true;
      api.setStage(LAST_STAGE);
    }, Math.max(0, INTRO_DELAY_MS - (performance.now() - since)));
  };
  const onVisibility = (): void => {
    if (!document.hidden) visibleSince ??= performance.now();
    startIntro();
  };
  document.addEventListener('visibilitychange', onVisibility);
  // With reduced motion the stages are jumped over, so the overlay just stays.
  const fade = prefersReducedMotion() ? null : createOverlayFade(body);
  let shownStage: number | null = null;

  // Drivers report no compile progress, so the bar is an estimate: an ease toward the time the
  // compile took last time, never below the share of finished programs, full only when ready.
  const started = performance.now();
  const expected = lastCompileMs();
  let frame = 0;
  let shown = -1;
  const drawBar = (): void => {
    const elapsed = performance.now() - started;
    const share = Math.min(0.95, Math.max(1 - Math.exp((-2.3 * elapsed) / expected), api.compiled * 0.9));
    const filled = Math.round(share * BAR_CELLS);
    // The bar has only a dozen states; touch the DOM when it changes, not every frame.
    if (bar && filled !== shown) bar.textContent = `[${'#'.repeat(filled)}${'.'.repeat(BAR_CELLS - filled)}]`;
    shown = filled;
    frame = requestAnimationFrame(drawBar);
  };
  drawBar();

  const onInput = (): void => api.setStage(Number(range.value));
  const onEnd = (event: Event): void => api.setStage(Number((event.currentTarget as HTMLElement).dataset.sceneStage));
  range.addEventListener('input', onInput);
  for (const end of ends) end.addEventListener('click', onEnd);

  void api.ready.then((ok) => {
    cancelAnimationFrame(frame);
    if (unbound) return;
    if (loader) loader.hidden = true;
    if (!ok) return;
    storeCompileMs(performance.now() - started);
    // `?era=` pins the scene for review, so it never plays the intro.
    if (!introSeen() && !new URLSearchParams(window.location.search).has('era')) {
      introPending = true;
      startIntro();
    } else {
      control.hidden = false;
    }
  });

  const stop = api.onEra((state) => {
    const era = state.stage >= FONT_STAGE ? '2026' : '1997';
    if (shownStage !== null && state.stage !== shownStage) fade?.step(state.stage > shownStage ? 1 : -1);
    if (state.settled) fade?.settle();
    shownStage = state.stage;
    range.value = String(state.target);
    range.setAttribute('aria-valuetext', stageText(state.target));
    // Ticks fill up to the stage on screen; the thumb already shows where the trip ends.
    ticks.forEach((tick, n) => tick.toggleAttribute('data-on', n <= state.stage));
    for (const end of ends) end.toggleAttribute('data-here', Number(end.dataset.sceneStage) === state.stage);
    if (intro && state.settled && state.target === LAST_STAGE) {
      intro = false;
      control.hidden = false;
    }
    if (body.dataset.era !== era) body.dataset.era = era;
    // Early steps change only the picture; the overlay glitches once colour starts to arrive.
    if (state.flicker > 0 && state.stage >= FONT_STAGE - 1) {
      body.removeAttribute('data-glitch');
      void body.offsetWidth;
      body.setAttribute('data-glitch', '');
    } else {
      body.removeAttribute('data-glitch');
    }
  });

  return () => {
    unbound = true;
    cancelAnimationFrame(frame);
    clearTimeout(introTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    fade?.destroy();
    stop();
    range.removeEventListener('input', onInput);
    for (const end of ends) end.removeEventListener('click', onEnd);
    control.hidden = true;
    if (loader) loader.hidden = true;
    delete body.dataset.era;
    body.removeAttribute('data-glitch');
  };
}
