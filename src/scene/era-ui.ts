import { FONT_STAGE, LAST_STAGE } from './era';
import type { SceneApi } from './scene';

/** Set after the first automatic trip to 2026; later visits start in 2001 and wait for the visitor. */
const INTRO_KEY = 'scene-intro-seen';
/** How long the 2026 shaders took last time on this device; drives the estimated progress bar. */
const COMPILE_KEY = 'scene-compile-ms';
const BAR_CELLS = 12;

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

/** Screen reader value of a stage: the end years, or the step between them. */
function stageText(stage: number): string {
  if (stage === 0) return '2001';
  if (stage === LAST_STAGE) return '2026';
  return `step ${stage} of ${LAST_STAGE}, between 2001 and 2026`;
}

/**
 * Wires the `2001 [-------] 2026` scale to the scene: the slider picks any stage, the end years
 * make the full trip. While the 2026 shaders compile a loader stands in its place. On the first
 * visit the scene then travels to 2026 by itself and the scale appears once it has arrived; later
 * visits get it as soon as 2026 is ready. `body[data-era]` swaps the overlay typeface;
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
      markIntroSeen();
      intro = true;
      api.setStage(LAST_STAGE);
    } else {
      control.hidden = false;
    }
  });

  const stop = api.onEra((state) => {
    const era = state.stage >= FONT_STAGE ? '2026' : '1997';
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
    stop();
    range.removeEventListener('input', onInput);
    for (const end of ends) end.removeEventListener('click', onEnd);
    control.hidden = true;
    if (loader) loader.hidden = true;
    delete body.dataset.era;
    body.removeAttribute('data-glitch');
  };
}
