/** Art-direction knobs of the scene; `?debug=1` shows a panel that changes them live. */
export interface Tuning {
  /** Cloud cover, 0..1. */
  clouds: number;
  /** Drifting mist banks on the water, 0..1. */
  mist: number;
  /** The distant ship light on the horizon, 0..1. */
  light: number;
  /** Boat sway of the 2026 camera, 1 is the default amplitude. */
  sway: number;
  /** Lens colour fringes at the 2026 frame corners, CSS px. */
  fringe: number;
  /** Horizon drop at the screen edges in 2026, % of the screen width. */
  curve: number;
  /** How far the moon climbs over the first minutes, % of the screen height. */
  rise: number;
  /** Duration of the scan that reveals a new era, ms; 0 switches at once. */
  wipe: number;
}

export const TUNING_DEFAULTS: Readonly<Tuning> = {
  clouds: 0,
  mist: 0,
  light: 0,
  sway: 0,
  fringe: 6,
  curve: 0.15,
  rise: 0,
  wipe: 0,
};

const KNOBS: readonly { key: keyof Tuning; min: number; max: number; step: number }[] = [
  { key: 'clouds', min: 0, max: 1, step: 0.05 },
  { key: 'mist', min: 0, max: 1, step: 0.05 },
  { key: 'light', min: 0, max: 1, step: 0.05 },
  { key: 'sway', min: 0, max: 3, step: 0.1 },
  { key: 'fringe', min: 0, max: 6, step: 0.25 },
  { key: 'curve', min: 0, max: 2, step: 0.05 },
  { key: 'rise', min: 0, max: 6, step: 0.25 },
  { key: 'wipe', min: 0, max: 1200, step: 50 },
];

/** Adds the tuning panel to the page; `onChange` runs after every edit. Returns the cleanup. */
export function mountTuningPanel(tuning: Tuning, onChange: () => void): () => void {
  const panel = document.createElement('details');
  panel.className = 'scene-debug';
  panel.open = true;
  const summary = document.createElement('summary');
  summary.textContent = 'tune';
  panel.append(summary);

  for (const { key, min, max, step } of KNOBS) {
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = key;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(tuning[key]);
    const value = document.createElement('output');
    value.textContent = String(tuning[key]);
    input.addEventListener('input', () => {
      tuning[key] = Number(input.value);
      value.textContent = input.value;
      onChange();
    });
    label.append(name, input, value);
    panel.append(label);
  }

  // The current values as JSON, to paste back into a chat or into TUNING_DEFAULTS.
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'copy values';
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(JSON.stringify(tuning)).then(() => {
      copy.textContent = 'copied';
      window.setTimeout(() => (copy.textContent = 'copy values'), 1200);
    });
  });
  panel.append(copy);

  document.body.append(panel);
  return () => panel.remove();
}
