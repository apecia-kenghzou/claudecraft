// A multi-line input editor for the interactive REPL. Deliberately split in two pieces so the actual editing logic
// is unit-testable without a real TTY: `parseKey` turns raw stdin bytes into a structured key event, `LineEditor`
// turns key events into buffer/cursor state. Only the thin raw-mode wiring in cli.js needs a real terminal.
//
// Newline conventions (EVIDENCE.md §28): the bundle's own help text lists three ways to add a newline instead of
// submitting - "shift+enter", "ctrl+j", and "backslash (\\) + return to add newline". All three are implemented:
// ctrl+j is unambiguous (raw mode sends LF 0x0A for it, CR 0x0D for a plain Enter); a trailing single backslash
// right before Enter is stripped and treated as a newline instead of being submitted; shift+enter is only
// detectable when the terminal actually sends a distinguishable sequence for it (the Kitty keyboard protocol's
// `CSI 13;2u`), which most terminals do not do without an opt-in handshake this project does not send - so in an
// ordinary terminal, "shift+enter" degrades to a plain Enter (submits), same as real terminal apps that don't ask
// for that handshake either. This is an honest, not a silent, gap.

/** Parse one chunk of raw stdin bytes into a key event, or null for bytes that don't map to anything handled here. */
export function parseKey(chunk) {
  const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  if (s === '\r') return { name: 'enter' };
  if (s === '\n') return { name: 'ctrl-j' };             // LF: Ctrl+J in raw mode (distinct from Enter's CR)
  if (s === '\x7f' || s === '\x08') return { name: 'backspace' };
  if (s === '\x1b[3~') return { name: 'delete' };
  if (s === '\x1b[A') return { name: 'up' };
  if (s === '\x1b[B') return { name: 'down' };
  if (s === '\x1b[C') return { name: 'right' };
  if (s === '\x1b[D') return { name: 'left' };
  if (s === '\x1b[H' || s === '\x1b[1~' || s === '\x01') return { name: 'home' };     // Ctrl+A too
  if (s === '\x1b[F' || s === '\x1b[4~' || s === '\x05') return { name: 'end' };      // Ctrl+E too
  if (s === '\x0b') return { name: 'kill-to-end' };      // Ctrl+K
  if (s === '\x15') return { name: 'kill-line' };         // Ctrl+U
  if (s === '\x1b[13;2u') return { name: 'shift-enter' }; // Kitty keyboard protocol, if the terminal sends it
  if (s === '\x03') return { name: 'ctrl-c' };
  if (s.length === 1 && s >= ' ') return { name: 'char', char: s };
  if (!s.startsWith('\x1b') && [...s].every((c) => c >= ' ' || c === '\t')) return { name: 'text', text: s };  // paste
  return null;
}

/**
 * Multi-line buffer + cursor. `lines` is always at least one (possibly empty) string. `handleKey` mutates state
 * and returns {submit: string} once, when the input should be sent (Enter without a newline convention active),
 * or undefined otherwise.
 */
/**
 * The screen lines to draw for the current buffer: `prefixWidth` spaces of indent on every line after the first,
 * so continuation lines align under (not before) the prompt prefix. Pure and TTY-agnostic - the caller applies its
 * own ANSI styling to the prefix and writes the result; this only decides the plain-text content and shape.
 */
export function frameLines(editor, prefixWidth) {
  const pad = ' '.repeat(prefixWidth);
  return editor.lines.map((l, i) => (i === 0 ? l : pad + l));
}

export class LineEditor {
  constructor(initial = '') {
    this.lines = initial.split('\n');
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
  }

  get text() { return this.lines.join('\n'); }
  get empty() { return this.lines.length === 1 && this.lines[0] === ''; }

  #insertNewline() {
    const line = this.lines[this.row];
    const before = line.slice(0, this.col), after = line.slice(this.col);
    this.lines.splice(this.row, 1, before, after);
    this.row += 1; this.col = 0;
  }

  #insertText(text) {
    const line = this.lines[this.row];
    this.lines[this.row] = line.slice(0, this.col) + text + line.slice(this.col);
    this.col += text.length;
  }

  clear() { this.lines = ['']; this.row = 0; this.col = 0; }

  handleKey(key) {
    switch (key.name) {
      case 'char': this.#insertText(key.char); return;
      case 'text': this.#insertText(key.text); return;
      case 'ctrl-j': case 'shift-enter': this.#insertNewline(); return;
      case 'enter': {
        const line = this.lines[this.row];
        // a single trailing backslash means "newline", not "submit" (EVIDENCE.md §28); a doubled backslash
        // (an escaped literal backslash) submits normally with both backslashes kept.
        if (line.endsWith('\\') && !line.endsWith('\\\\')) {
          this.lines[this.row] = line.slice(0, -1);
          this.col = Math.min(this.col, this.lines[this.row].length);
          this.#insertNewline();
          return;
        }
        const submitted = this.text;
        this.clear();
        return { submit: submitted };
      }
      case 'backspace': {
        if (this.col > 0) { const l = this.lines[this.row]; this.lines[this.row] = l.slice(0, this.col - 1) + l.slice(this.col); this.col -= 1; }
        else if (this.row > 0) { const prevLen = this.lines[this.row - 1].length; this.lines[this.row - 1] += this.lines[this.row]; this.lines.splice(this.row, 1); this.row -= 1; this.col = prevLen; }
        return;
      }
      case 'delete': {
        const l = this.lines[this.row];
        if (this.col < l.length) this.lines[this.row] = l.slice(0, this.col) + l.slice(this.col + 1);
        else if (this.row < this.lines.length - 1) { this.lines[this.row] += this.lines[this.row + 1]; this.lines.splice(this.row + 1, 1); }
        return;
      }
      case 'left': {
        if (this.col > 0) this.col -= 1;
        else if (this.row > 0) { this.row -= 1; this.col = this.lines[this.row].length; }
        return;
      }
      case 'right': {
        if (this.col < this.lines[this.row].length) this.col += 1;
        else if (this.row < this.lines.length - 1) { this.row += 1; this.col = 0; }
        return;
      }
      case 'up': { if (this.row > 0) { this.row -= 1; this.col = Math.min(this.col, this.lines[this.row].length); } return; }
      case 'down': { if (this.row < this.lines.length - 1) { this.row += 1; this.col = Math.min(this.col, this.lines[this.row].length); } return; }
      case 'home': this.col = 0; return;
      case 'end': this.col = this.lines[this.row].length; return;
      case 'kill-to-end': this.lines[this.row] = this.lines[this.row].slice(0, this.col); return;
      case 'kill-line': { this.lines[this.row] = this.lines[this.row].slice(this.col); this.col = 0; return; }
      default: return;
    }
  }
}
