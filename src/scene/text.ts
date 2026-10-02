import agcSource from './agc.txt?raw';
import shaderSource from './shaders.ts?raw';

/**
 * The words of the curtain. Swap the sources here; nothing else depends on their content.
 *
 * 1997: original Apollo 11 guidance computer source (AGC, MIT Instrumentation Laboratory, 1969).
 * Repo https://github.com/chrislgarry/Apollo-11 (public domain): Luminary099 (Lunar Module)
 * BURN_BABY_BURN--MASTER_IGNITION_ROUTINE, LUNAR_LANDING_GUIDANCE_EQUATIONS, THE_LUNAR_LANDING,
 * and Comanche055 (Command Module) PINBALL_GAME_BUTTONS_AND_LIGHTS. The Virtual AGC header blocks,
 * "## " commentary and page markers were stripped; the 1969 code and comments remain (agc.txt), plus
 * one transcription note of the Virtual AGC project (`RSB 2009`).
 *
 * 2026: this site's own aurora code, imported with `?raw` so it always matches what is running.
 */
export const AGC_LINES: readonly string[] = agcSource.split('\n');

/** From the aurora geometry comment to the end of `auroraReal`; keep both markers when editing shaders.ts. */
function siteCodeLines(): string[] {
  const start = shaderSource.indexOf('/*\n * Aurora as geometry.');
  const marker = shaderSource.indexOf('vec3 auroraReal(vec2 p) {');
  const end = marker === -1 ? -1 : shaderSource.indexOf('\n}', marker);
  if (start === -1 || end === -1) {
    if (import.meta.env.DEV) console.warn('[scene] aurora code markers not found in shaders.ts, showing its head');
    return shaderSource.split('\n').slice(0, 80);
  }
  return shaderSource.slice(start, end + 2).split('\n');
}

export const SITE_CODE_LINES: readonly string[] = siteCodeLines();

/** Line of the AGC listing worth showing on wide screens: the famous "I HOPE" comment. */
export const AGC_FAMOUS_LINE = Math.max(
  0,
  AGC_LINES.findIndex((line) => line.includes('TEMPORARY, I HOPE')) - 10,
);

/** Plain text for the Canvas2D fallback renderer. */
export const CURTAIN_TEXT = AGC_LINES.filter((line) => !line.startsWith('#') || line.length > 3)
  .join(' ')
  .replace(/\s+/g, ' ');
