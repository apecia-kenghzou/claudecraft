// Full-screen (pinned-input) layout and mouse support for the terminal UI (ARCHITECTURE.md row 8's remaining
// items). Deliberately NOT the alternate-screen-buffer approach (`\x1b[?1049h`), which would require every output
// call site in cli.js to go through a redraw-aware layer. Instead this uses a VT scrolling region (DECSTBM,
// `CSI r`): the terminal's own scrollback keeps working completely unchanged for every existing `stdout.write`
// call, and only the last `footerRows` screen rows are carved out as a separately-drawn, pinned area - the
// technique vim/tmux use for a status line, applied to an input box instead. Own design: no bundle evidence for
// how the real product's full-screen layout is implemented (it's an Ink/React app, which works completely
// differently), only that the lightweight terminal UI's own remaining-work list named "full-screen layout" and
// "mouse" (ARCHITECTURE.md row 8).
//
// All functions here return the raw ANSI string to write (or parsed data), so they're pure and testable without a
// real terminal; only the actual `stdout.write`/resize-listener wiring in cli.js touches a live TTY.

const ESC = '\x1b';

/** Confine scrolling to rows 1..(rows - footerRows), leaving the bottom footerRows rows pinned. */
export const setScrollRegion = (rows, footerRows) => `${ESC}[1;${Math.max(1, rows - footerRows)}r`;
export const resetScrollRegion = () => `${ESC}[r`;

/** Mouse reporting: basic button events in SGR (extended, 1006) encoding, which reports coordinates past column 223. */
export const enableMouse = () => `${ESC}[?1000h${ESC}[?1006h`;
export const disableMouse = () => `${ESC}[?1006l${ESC}[?1000l`;

/**
 * Redraw the pinned footer without disturbing the scrolling region above it or the caller's cursor position there:
 * save cursor, jump to the footer's first row, clear each footer row, write `lines`, restore the saved cursor.
 * `lines` must already fit within `cols` (the caller wraps/truncates); this only positions and clears.
 */
export function drawFooter({ rows, footerRows, lines }) {
  const top = Math.max(1, rows - footerRows + 1);
  const body = lines.slice(0, footerRows).map((l, i) => `${ESC}[${top + i};1H${ESC}[2K${l}`).join('');
  return `${ESC}7${body}${ESC}8`;    // DECSC/DECRC (save/restore cursor) bracket the whole redraw
}

/**
 * Where, within the footer, to place the terminal cursor (1-based row/col), given the logical (row, col) in the
 * editor. `headerRows` is how many fixed rows (e.g. a top divider) sit above editorRow 0 in the drawn footer -
 * must match whatever the caller actually put there, same as `mouseToEditorColumn` needs to agree with it below.
 */
export function footerCursorPosition({ rows, footerRows, editorRow, editorCol, prefixWidth, headerRows = 0 }) {
  const top = Math.max(1, rows - footerRows + 1);
  const col = prefixWidth + editorCol + 1;
  return `${ESC}[${top + headerRows + editorRow};${col}H`;
}

/**
 * Parse one chunk of raw stdin bytes as an SGR mouse report (`CSI < b ; x ; y M` for press, `m` for release).
 * Returns {button, x, y, pressed} (1-based terminal coordinates) or null if the chunk isn't a mouse report.
 */
export function parseMouseEvent(chunk) {
  const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(s);
  if (!m) return null;
  return { button: Number(m[1]), x: Number(m[2]), y: Number(m[3]), pressed: m[4] === 'M' };
}

/**
 * Translate a left-click mouse event into an editor column, if it landed on the footer's input row (editorRow 0,
 * i.e. the first/prompt line, `headerRows` rows below the top of the footer - see footerCursorPosition); returns
 * null for clicks elsewhere (other footer rows, outside the footer, or any button other than a plain left click)
 * rather than guessing.
 */
export function mouseToEditorColumn(evt, { rows, footerRows, prefixWidth, lineLength, headerRows = 0 }) {
  if (!evt || evt.button !== 0 || !evt.pressed) return null;
  const top = Math.max(1, rows - footerRows + 1);
  if (evt.y !== top + headerRows) return null;
  const col = Math.max(0, Math.min(lineLength, evt.x - 1 - prefixWidth));
  return col;
}
