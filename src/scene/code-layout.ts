/**
 * Lays source code onto the curtain grid. One source line per curtain row; when the screen is
 * wide the listing is set in several side-by-side blocks (like a printed listing), each block
 * starting further down the file, so the sheet stays dense instead of leaving the right side bare.
 */
const TAB_WIDTH = 2;
const GAP = 2;
const PREFERRED_BLOCK = 40;

/** Expands tabs to fixed stops and replaces anything unprintable. */
function expandTabs(line: string): string {
  let out = '';
  for (const char of line) {
    if (char === '\t') out += ' '.repeat(TAB_WIDTH - (out.length % TAB_WIDTH));
    else out += char >= ' ' && char <= '~' ? char : ' ';
  }
  return out.trimEnd();
}

export interface CodeLayoutOptions {
  /** Line index where each following block starts (the first block starts at 0). */
  starts?: readonly number[];
}

/** Returns `rows * cols` single-cell strings. */
export function layoutCode(lines: readonly string[], cols: number, rows: number, options: CodeLayoutOptions = {}): string[] {
  const source = lines.map(expandTabs);
  const total = Math.max(1, source.length);
  const blocks = Math.max(1, Math.round((cols + GAP) / (PREFERRED_BLOCK + GAP)));
  const width = Math.max(8, Math.floor((cols + GAP) / blocks - GAP));
  const starts = [0, ...(options.starts ?? [])];
  const grid: string[] = Array.from({ length: rows * cols }, () => ' ');
  for (let b = 0; b < blocks; b++) {
    const x0 = b * (width + GAP);
    const start = starts[b] ?? (starts[starts.length - 1]! + (b - starts.length + 1) * rows);
    for (let r = 0; r < rows; r++) {
      const line = source[(((start + r) % total) + total) % total] ?? '';
      for (let i = 0; i < Math.min(width, line.length); i++) {
        if (x0 + i < cols) grid[r * cols + x0 + i] = line[i]!;
      }
    }
  }
  return grid;
}
