import test from 'node:test';
import assert from 'node:assert/strict';
import {
  richEnabled, colorEnabled, createStyle, stripAnsi, replacementDiff, renderDiff, toolPreview, formatInline,
  MarkdownFormatter, StreamRenderer, Spinner, footerLine, slashCompleter,
} from '../src/ui.js';

const tty = { isTTY: true };

test('rich/color enablement: TTY only, respects --plain, REA_PLAIN, NO_COLOR, TERM=dumb', () => {
  assert.equal(richEnabled({ stdout: tty, env: {} }), true);
  assert.equal(richEnabled({ stdout: { isTTY: false }, env: {} }), false);
  assert.equal(richEnabled({ stdout: tty, env: {}, plain: true }), false);
  assert.equal(richEnabled({ stdout: tty, env: { REA_PLAIN: '1' } }), false);
  assert.equal(richEnabled({ stdout: tty, env: { TERM: 'dumb' } }), false);
  assert.equal(colorEnabled({ stdout: tty, env: { NO_COLOR: '1' } }), false);
  assert.equal(colorEnabled({ stdout: tty, env: {} }), true);
});

test('createStyle wraps with ANSI when on and is the identity when off', () => {
  const on = createStyle(true), off = createStyle(false);
  assert.equal(on.red('x'), '\x1b[31mx\x1b[0m');
  assert.equal(off.red('x'), 'x');
  assert.equal(stripAnsi(on.bold(on.cyan('hi'))), 'hi');
});

test('replacementDiff: shared head/tail become context, middle is -/+, long diffs are clipped', () => {
  const d = replacementDiff('a\nb\nOLD\nc\nd', 'a\nb\nNEW1\nNEW2\nc\nd', { context: 1 });
  assert.deepEqual(d.map((l) => `${l.kind}${l.text}`), [' b', '-OLD', '+NEW1', '+NEW2', ' c']);
  const big = replacementDiff('x', Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n'), { maxLines: 10 });
  assert.equal(big.length, 11);
  assert.equal(big.at(-1).kind, '…');
  assert.deepEqual(replacementDiff('same', 'same').map((l) => l.kind), []);
});

test('toolPreview: diff for Edit, capped preview for Write, nothing for other tools', () => {
  const s = createStyle(false);
  assert.deepEqual(toolPreview({ name: 'Edit', input: { old_string: 'a', new_string: 'b' } }, s), ['- a', '+ b']);
  const w = toolPreview({ name: 'Write', input: { content: Array.from({ length: 20 }, (_, i) => `r${i}`).join('\n') } }, s);
  assert.equal(w.length, 13);
  assert.match(w.at(-1), /8 more lines/);
  assert.deepEqual(toolPreview({ name: 'Bash', input: { command: 'ls' } }, s), []);
  assert.deepEqual(renderDiff([{ kind: '+', text: 'x' }], createStyle(true)).map(stripAnsi), ['+ x']);
});

test('markdown-lite: headings, bullets, inline code/bold, fenced blocks, quotes', () => {
  const s = createStyle(false);
  const f = new MarkdownFormatter(s);
  assert.equal(f.line('## Title'), 'Title');
  assert.equal(f.line('- item with `code` and **bold**'), '• item with code and bold');
  assert.equal(f.line('```js'), '```js');
  assert.equal(f.line('# not a heading inside a fence'), '# not a heading inside a fence');
  assert.equal(f.line('```'), '```');
  assert.equal(f.line('# heading again'), 'heading again');
  assert.equal(formatInline('a *it* b', s), 'a it b');
  const on = new MarkdownFormatter(createStyle(true));
  assert.match(on.line('`x`'), /\x1b\[36mx/);
});

test('StreamRenderer: line-buffered, wraps long lines at spaces, flush emits the tail', () => {
  const out = [];
  const r = new StreamRenderer((t) => out.push(t), createStyle(false), { wrapAt: 20 });
  r.push('Hel'); r.push('lo\nwor');
  assert.deepEqual(out, ['Hello\n']);
  r.push('ld and a very long sentence without any newline at all');
  assert.ok(out.length > 2);
  assert.ok(out.slice(1).every((l) => stripAnsi(l).trimEnd().length <= 26));
  r.flush();
  assert.equal(out.join('').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim(), 'Hello world and a very long sentence without any newline at all');
  const c = [];
  const fence = new StreamRenderer((t) => c.push(t), createStyle(true));
  fence.push('```\n# x\n');
  assert.match(c[1], /\x1b\[2m# x/);     // dim inside a fence
});

test('Spinner: no output when disabled; draws a labelled line and clears it on stop', async () => {
  const w = [];
  const quiet = new Spinner({ write: (t) => w.push(t) }, createStyle(false), { enabled: false });
  quiet.start('x'); quiet.stop();
  assert.deepEqual(w, []);
  let t = 0;
  const s = new Spinner({ write: (x) => w.push(x) }, createStyle(false), { enabled: true, intervalMs: 5, now: () => (t += 1000) });
  s.start('Thinking');
  await new Promise((r) => setTimeout(r, 20));
  s.stop();
  assert.match(w.join(''), /Thinking \d+s · Ctrl-C to interrupt/);
  assert.equal(w.at(-1), '\r\x1b[2K');
  const before = w.length;
  s.stop();                                // idempotent
  assert.equal(w.length, before);
});

test('footerLine shows model, mode, context percent and compactions; slash completion', () => {
  const f = stripAnsi(footerLine({ model: 'gpt-5.5', mode: 'default', status: { tokens: 50000, window: 200000 }, compactions: 2, style: createStyle(false), width: 70 }));
  assert.match(f, /gpt-5\.5 · default · ctx 25% · 2 compactions/);
  assert.ok(f.length <= 72);
  const c = slashCompleter(['compact', 'context', 'clear']);
  assert.deepEqual(c('/co'), [['/compact', '/context'], '/co']);
  assert.deepEqual(c('/zzz')[0], ['/compact', '/context', '/clear']);   // no match: offer all
  assert.deepEqual(c('hello'), [[], 'hello']);
});

import { shortenPaths, shortenInput } from '../src/ui.js';

test('path shortening for display only; Write preview drops the trailing blank line', () => {
  assert.equal(shortenPaths('Wrote 5 bytes to /w/proj/src/a.js', '/w/proj'), 'Wrote 5 bytes to src/a.js');
  assert.equal(shortenPaths('/other/x', '/w/proj'), '/other/x');
  assert.deepEqual(shortenInput({ file_path: '/w/proj/a.js', n: 3 }, '/w/proj'), { file_path: 'a.js', n: 3 });
  const w = toolPreview({ name: 'Write', input: { content: 'a\nb\n' } }, createStyle(false));
  assert.deepEqual(w, ['+ a', '+ b']);
});
