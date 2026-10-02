import { layoutWithLines, prepareWithSegments } from '@chenglou/pretext';

/**
 * Breaks `text` into `rows` lines of at most `cols` monospace cells using
 * pretext (no DOM measurement) and justifies them into a solid block, so the
 * cloth reads as a dense sheet. Returns `rows * cols` single-cell strings.
 */
export function layoutSheet(
  text: string,
  font: string,
  cellWidth: number,
  cols: number,
  rows: number,
): string[] {
  const prepared = prepareWithSegments(text.replace(/\s+/g, ' ').trim(), font);
  // Half a cell of slack absorbs float noise in the measured widths.
  const { lines } = layoutWithLines(prepared, cols * cellWidth + cellWidth / 2, 1);
  const grid: string[] = [];
  for (let row = 0; row < rows; row++) {
    const source = lines[row % lines.length];
    const words = (source?.text ?? '').trim().split(' ');
    const isLastOfText = row % lines.length === lines.length - 1;
    grid.push(...justify(words, cols, isLastOfText));
  }
  return grid;
}

function justify(words: string[], cols: number, ragged: boolean): string[] {
  const letters = words.reduce((sum, word) => sum + word.length, 0);
  const gaps = words.length - 1;
  const cells: string[] = [];
  const spaces = ragged || gaps === 0 ? 1 : Math.max(1, (cols - letters) / gaps);
  let carry = 0;
  words.forEach((word, index) => {
    cells.push(...word);
    if (index === gaps) return;
    carry += spaces;
    const count = Math.floor(carry);
    carry -= count;
    for (let k = 0; k < count; k++) cells.push(' ');
  });
  while (cells.length < cols) cells.push(' ');
  return cells.slice(0, cols);
}
