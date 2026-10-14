// Terminal UI building blocks. Pure where possible so they can be tested without a TTY.
// Rich output is enabled only for a real terminal (see richEnabled); piped/CI output stays plain text.

const CODES = { reset: 0, bold: 1, dim: 2, italic: 3, underline: 4, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 };

export function richEnabled({ stdout, env = process.env, plain = false }) {
  return Boolean(stdout?.isTTY) && !plain && !env.REA_PLAIN && env.TERM !== 'dumb';
}

export function colorEnabled({ stdout, env = process.env }) {
  return Boolean(stdout?.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb';
}

/** style.red('x') etc.; identity functions when color is off. */
export function createStyle(enabled) {
  const wrap = (code) => (enabled ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => String(s));
  return Object.fromEntries(Object.entries(CODES).filter(([k]) => k !== 'reset').map(([k, v]) => [k, wrap(v)]));
}

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// ---- diff for Edit / Write ----------------------------------------------------------------------------------
/** Line diff of a single replacement: shared head/tail lines become context, the middle is -/+ lines. */
export function replacementDiff(oldStr, newStr, { context = 2, maxLines = 24 } = {}) {
  if (oldStr === newStr) return [];
  const a = oldStr.split('\n'), b = newStr.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out = [];
  for (const l of a.slice(Math.max(0, head - context), head)) out.push({ kind: ' ', text: l });
  for (const l of a.slice(head, a.length - tail)) out.push({ kind: '-', text: l });
  for (const l of b.slice(head, b.length - tail)) out.push({ kind: '+', text: l });
  for (const l of a.slice(a.length - tail, a.length - tail + context)) out.push({ kind: ' ', text: l });
  if (out.length > maxLines) {
    const hidden = out.length - maxLines;
    return [...out.slice(0, maxLines), { kind: '…', text: `${hidden} more lines` }];
  }
  return out;
}

export function renderDiff(lines, style) {
  return lines.map((l) => {
    if (l.kind === '+') return style.green(`+ ${l.text}`);
    if (l.kind === '-') return style.red(`- ${l.text}`);
    if (l.kind === '…') return style.dim(`  … ${l.text}`);
    return style.dim(`  ${l.text}`);
  });
}

/** What to show under a tool call: a diff for Edit, a preview for Write, nothing otherwise. */
export function toolPreview(block, style) {
  const i = block.input ?? {};
  if (block.name === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    return renderDiff(replacementDiff(i.old_string, i.new_string), style);
  }
  if (block.name === 'Write' && typeof i.content === 'string') {
    const ls = i.content.replace(/\n$/, '').split('\n');
    const shown = ls.slice(0, 12).map((l) => style.green(`+ ${l}`));
    if (ls.length > 12) shown.push(style.dim(`  … ${ls.length - 12} more lines`));
    return shown;
  }
  return [];
}

// ---- markdown-lite for streamed assistant text -----------------------------------------------------------
export function formatInline(line, style) {
  return line
    .replace(/`([^`]+)`/g, (_, c) => style.cyan(c))
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => style.bold(t))
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g, (_, p, t) => `${p}${style.italic(t)}`);
}

/** Line-level formatting with a little state (are we inside a code fence?). */
export class MarkdownFormatter {
  constructor(style) { this.style = style; this.fenced = false; }

  line(raw) {
    const s = this.style;
    if (/^\s*(```|~~~)/.test(raw)) { this.fenced = !this.fenced; return s.dim(raw); }
    if (this.fenced) return s.dim(raw);
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) return s.bold(s.cyan(h[2]));
    const li = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    if (li) return `${li[1]}• ${formatInline(li[2], s)}`;
    if (/^\s*>\s?/.test(raw)) return s.gray(raw);
    return formatInline(raw, s);
  }
}

/** Accumulates streamed deltas and emits formatted complete lines; long lines break at the last space. */
export class StreamRenderer {
  constructor(write, style, { wrapAt = 100 } = {}) {
    this.write = write; this.fmt = new MarkdownFormatter(style); this.buf = ''; this.wrapAt = wrapAt; this.any = false;
  }

  push(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      this.emit(this.buf.slice(0, i)); this.buf = this.buf.slice(i + 1);
    }
    while (this.buf.length > this.wrapAt) {            // very long line: do not wait for a newline
      const cut = this.buf.lastIndexOf(' ', this.wrapAt);
      if (cut <= 0) break;
      this.emit(this.buf.slice(0, cut)); this.buf = this.buf.slice(cut + 1);
    }
  }

  emit(line) { this.any = true; this.write(`${this.fmt.line(line)}\n`); }

  flush() { if (this.buf) { this.emit(this.buf); this.buf = ''; } this.fmt.fenced = false; }
}

// ---- spinner ------------------------------------------------------------------------------------------------
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  constructor(stream, style, { enabled = false, intervalMs = 90, now = Date.now } = {}) {
    Object.assign(this, { stream, style, enabled, intervalMs, now });
    this.timer = null; this.label = ''; this.started = 0; this.frame = 0; this.visible = false;
  }

  start(label) {
    this.label = label;
    if (!this.enabled || this.timer) return;
    this.started = this.now();
    this.timer = setInterval(() => this.#draw(), this.intervalMs);
    this.timer.unref?.();
    this.#draw();
  }

  setLabel(label) { this.label = label; }

  #draw() {
    const secs = ((this.now() - this.started) / 1000).toFixed(0);
    this.stream.write(`\r\x1b[2K${this.style.cyan(FRAMES[this.frame++ % FRAMES.length])} ${this.style.dim(`${this.label} ${secs}s · Ctrl-C to interrupt`)}`);
    this.visible = true;
  }

  /** Remove the spinner line (call before printing anything else). */
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.visible) { this.stream.write('\r\x1b[2K'); this.visible = false; }
  }
}

// ---- footer -------------------------------------------------------------------------------------------------
export function footerLine({ model, mode, status, compactions = 0, style, width = 80 }) {
  const parts = [model, mode];
  if (status) parts.push(`ctx ${Math.max(0, Math.min(100, Math.round((status.tokens / status.window) * 100)))}%`);
  if (compactions) parts.push(`${compactions} compaction${compactions === 1 ? '' : 's'}`);
  const text = ` ${parts.join(' · ')} `;
  const rule = '─'.repeat(Math.max(2, Math.min(width, 100) - text.length - 2));
  return style.dim(`──${text}${rule}`);
}

export function slashCompleter(names) {
  const all = names.map((n) => `/${n}`);
  return (line) => {
    if (!line.startsWith('/')) return [[], line];
    const hits = all.filter((c) => c.startsWith(line));
    return [hits.length ? hits : all, line];
  };
}

/** Display helper: show paths under the working directory relatively (`/cwd/src/a.js` -> `src/a.js`). */
export function shortenPaths(text, cwd) {
  if (!cwd) return text;
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return String(text).split(root).join('');
}

export function shortenInput(input, cwd) {
  if (!input || typeof input !== 'object') return input;
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' && v.length < 500 ? shortenPaths(v, cwd) : v]));
}
