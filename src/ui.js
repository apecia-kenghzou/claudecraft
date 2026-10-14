// Terminal UI building blocks. Pure where possible so they can be tested without a TTY.
// Rich output is enabled only for a real terminal (see richEnabled); piped/CI output stays plain text.

const STRUCTURAL_CODES = { bold: '1', dim: '2', italic: '3', underline: '4' };

/**
 * Color presets (own design - no bundle evidence for exact codes/palette). Each maps the same semantic role names
 * (red/green/yellow/blue/magenta/cyan/gray) to SGR parameter(s), so call sites never change across themes.
 * `mono` disables color entirely (null = don't wrap); `light` swaps `gray` from bright-black (invisible on many
 * light-background terminals) to a plain dim modifier, which renders reasonably on either background.
 */
export const THEMES = {
  dark: { red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36', gray: '90' },
  light: { red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36', gray: '2' },
  mono: { red: null, green: null, yellow: null, blue: null, magenta: null, cyan: null, gray: null },
};
export const THEME_NAMES = Object.keys(THEMES);
export const resolveTheme = (name) => THEMES[name] ?? THEMES.dark;

export function richEnabled({ stdout, env = process.env, plain = false }) {
  return Boolean(stdout?.isTTY) && !plain && !env.REA_PLAIN && env.TERM !== 'dumb';
}

export function colorEnabled({ stdout, env = process.env }) {
  return Boolean(stdout?.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb';
}

/** style.red('x') / style.bold('x') etc.; identity functions when color is off or (for a color role) the theme disables it. */
export function createStyle(enabled, themeName = 'dark') {
  const theme = resolveTheme(themeName);
  const wrap = (code) => (enabled && code !== null ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => String(s));
  return {
    ...Object.fromEntries(Object.entries(STRUCTURAL_CODES).map(([k, v]) => [k, wrap(v)])),
    ...Object.fromEntries(Object.entries(theme).map(([k, v]) => [k, wrap(v)])),
  };
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

/**
 * Single source of truth for slash-command names + descriptions, shared by /help and the live suggestion
 * dropdown (suggestSlashCommands) so the two never drift apart. `name` has no leading slash; `usage` (if any)
 * and `description` match the wording /help has always shown.
 */
export const SLASH_COMMANDS = [
  ['help', '', 'this list'], ['model', '[name]', 'show or switch the model'], ['status', '', 'session, model, context, servers'],
  ['usage', '', 'token usage this session'], ['tasks', '', 'the task checklist'], ['context', '', 'context window use'],
  ['compact', '[focus]', 'summarize history to free context'], ['clear', '', 'start a new conversation'], ['resume', '[id]', 'list or load a saved session'],
  ['fork', '[title]', 'branch the session: new id, same history so far'],
  ['plan', '[off]', 'enter or leave plan mode (read-only until you approve)'], ['export', '[file]', 'write the conversation as Markdown'],
  ['diff', '', 'git diff of the working directory'], ['init', '', 'have the model write REA.md for this project'],
  ['memory', '', 'loaded memory files'], ['skills', '', 'available skills'], ['mcp', '', 'MCP servers'], ['lsp', '', 'language server status'],
  ['sandbox', '', 'OS sandbox status'], ['permissions', '', 'active permission rules'],
  ['cd', '[dir]', 'show or change the working directory'], ['add-dir', '[dir]', 'list or add a workspace directory'],
  ['rename', '<title>', 'rename the current session'], ['session', '', 'current session id, file and cwd'], ['config', '', 'settings sources and resolved values'],
  ['agents', '', 'sub-agent types'], ['exit', '', 'quit'],
];

/**
 * Live "/" suggestion list (own design - a smaller, read-only version of the dropdown real Claude Code shows:
 * no arrow-key selection here, Tab-completion via slashCompleter already picks the best match). Returns up to
 * `limit` {command, description} pairs whose name starts with the typed prefix, plus any matching skills passed
 * in (skills have no built-in description table, so their description is whatever the caller supplies).
 */
export function suggestSlashCommands(prefix, { skills = [], limit = 8 } = {}) {
  if (!prefix.startsWith('/') || prefix.includes(' ')) return [];
  const typed = prefix.slice(1).toLowerCase();
  const builtins = SLASH_COMMANDS.filter(([name]) => name.toLowerCase().startsWith(typed))
    .map(([name, usage, description]) => ({ command: `/${name}${usage ? ` ${usage}` : ''}`, description }));
  const skillHits = skills.filter((s) => s.name.toLowerCase().startsWith(typed))
    .map((s) => ({ command: `/${s.name}`, description: s.description ?? '' }));
  return [...skillHits, ...builtins].slice(0, limit);
}

/**
 * Live "@" file-mention suggestion list (own design - a smaller version of the picker real Claude Code shows:
 * top-level working-directory entries only, substring-filtered, no recursive/fuzzy search or git-ignore awareness
 * yet). `candidates` are plain relative names (directories end in "/"); gathering them touches the filesystem,
 * so that part stays in cli.js - this is just the pure filter.
 */
export function suggestFileMentions(query, candidates, { limit = 15 } = {}) {
  const q = query.toLowerCase();
  const hits = q ? candidates.filter((c) => c.toLowerCase().includes(q)) : candidates;
  return hits.slice(0, limit);
}

/** Plain-text rows for the live "/" suggestion dropdown: one line per hit, command padded so descriptions line up. */
export function formatSlashSuggestions(hits, { pad = 20 } = {}) {
  return hits.map(({ command, description }) => `  ${command.padEnd(pad)} ${description}`);
}

/** Plain-text rows for the live "@" file-mention dropdown, matching the "+ name" marker shown in the real product. */
export function formatFileMentions(hits) {
  return hits.map((f) => `  + ${f}`);
}

/**
 * Assembles the full pinned-input block as plain text lines: an optional top rule, the editor's own lines (with
 * `prompt` prepended to the first one), an optional bottom rule, any live suggestion rows, then an optional status
 * line. Pure composition - callers apply their own styling per returned line (e.g. dim the rules/status, bold the
 * prompt) since this has no opinion on color.
 */
export function buildInputFrame({ lines, prompt = '', rule, suggestions = [], status }) {
  const out = [];
  if (rule) out.push(rule);
  out.push(...lines.map((l, i) => (i === 0 ? prompt + l : l)));
  if (rule) out.push(rule);
  out.push(...suggestions);
  if (status) out.push(status);
  return out;
}

/**
 * The "@" mention query in progress at `col` on `line`, if any: the text after the last unescaped "@" at or
 * before the cursor, as long as nothing (no space) has interrupted it since. Returns null when there's no mention
 * being typed right now (so the caller knows not to show the file picker).
 */
export function mentionQuery(line, col) {
  const before = line.slice(0, col);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  const query = before.slice(at + 1);
  return query.includes(' ') ? null : query;
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
