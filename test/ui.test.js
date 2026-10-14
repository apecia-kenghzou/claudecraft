import test from 'node:test';
import assert from 'node:assert/strict';
import {
  richEnabled, colorEnabled, createStyle, stripAnsi, replacementDiff, renderDiff, toolPreview, formatInline,
  MarkdownFormatter, StreamRenderer, Spinner, footerLine, slashCompleter, THEME_NAMES, resolveTheme,
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

test('themes: dark/light/mono presets; unknown name falls back to dark; structural styles survive mono', () => {
  assert.deepEqual(THEME_NAMES, ['dark', 'light', 'mono']);
  assert.equal(resolveTheme('nope'), resolveTheme('dark'));
  const dark = createStyle(true, 'dark'), light = createStyle(true, 'light'), mono = createStyle(true, 'mono');
  assert.equal(dark.gray('x'), '\x1b[90mx\x1b[0m');
  assert.equal(light.gray('x'), '\x1b[2mx\x1b[0m');          // avoids bright-black on a light background
  assert.equal(mono.gray('x'), 'x');                          // no color at all in mono
  assert.equal(mono.red('x'), 'x');
  assert.equal(mono.bold('x'), '\x1b[1mx\x1b[0m');             // structural styles are not color and still work
  assert.equal(createStyle(false, 'dark').gray('x'), 'x');     // color disabled entirely overrides any theme
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

import { suggestSlashCommands, suggestFileMentions, SLASH_COMMANDS } from '../src/ui.js';

test('suggestSlashCommands: filters built-ins by prefix, includes matching skills first, bare input yields nothing', () => {
  assert.deepEqual(suggestSlashCommands('hi'), []);                            // no leading "/"
  assert.deepEqual(suggestSlashCommands('/status x'), []);                     // already has an argument: not a command prefix anymore
  const statusOnly = suggestSlashCommands('/stat');
  assert.deepEqual(statusOnly, [{ command: '/status', description: 'session, model, context, servers' }]);
  const compactHits = suggestSlashCommands('/c');
  assert.ok(compactHits.some((h) => h.command === '/compact [focus]'));
  assert.ok(compactHits.some((h) => h.command === '/clear'));
  assert.ok(compactHits.some((h) => h.command === '/cd [dir]'));
  const withSkill = suggestSlashCommands('/g', { skills: [{ name: 'greet', description: 'say hi' }] });
  assert.equal(withSkill[0].command, '/greet');                                // a matching skill is listed too
  assert.equal(withSkill[0].description, 'say hi');
});

test('suggestSlashCommands: a matching skill is listed ahead of built-ins, limit is respected', () => {
  const hits = suggestSlashCommands('/c', { skills: [{ name: 'commit-helper', description: 'writes commit messages' }], limit: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].command, '/commit-helper');
  assert.equal(hits[0].description, 'writes commit messages');
});

test('suggestSlashCommands: SLASH_COMMANDS covers /help\'s own list (no drift between the two)', () => {
  assert.ok(SLASH_COMMANDS.some(([name]) => name === 'help'));
  assert.ok(SLASH_COMMANDS.some(([name]) => name === 'exit'));
  assert.equal(SLASH_COMMANDS.filter(([name]) => name === 'status').length, 1);
});

test('suggestFileMentions: substring match, directories distinguishable by trailing slash, limit respected', () => {
  const candidates = ['src/', 'test/', 'README.md', 'package.json', 'METRICS.md'];
  assert.deepEqual(suggestFileMentions('', candidates), candidates);
  assert.deepEqual(suggestFileMentions('md', candidates), ['README.md', 'METRICS.md']);
  assert.deepEqual(suggestFileMentions('src', candidates), ['src/']);
  assert.equal(suggestFileMentions('', candidates, { limit: 2 }).length, 2);
});

import { formatSlashSuggestions, formatFileMentions, buildInputFrame } from '../src/ui.js';

test('formatSlashSuggestions / formatFileMentions: plain-text rows, command padded so descriptions line up', () => {
  assert.deepEqual(formatSlashSuggestions([{ command: '/status', description: 'session info' }], { pad: 10 }), ['  /status    session info']);
  assert.deepEqual(formatFileMentions(['src/', 'README.md']), ['  + src/', '  + README.md']);
});

test('buildInputFrame: rules bracket the input, prompt only prepends to the first line, suggestions/status appended', () => {
  const frame = buildInputFrame({
    lines: ['hello', 'world'], prompt: '> ', rule: '---', suggestions: ['  /status  ...'], status: 'footer',
  });
  assert.deepEqual(frame, ['---', '> hello', 'world', '---', '  /status  ...', 'footer']);
  const bare = buildInputFrame({ lines: ['hi'] });
  assert.deepEqual(bare, ['hi']);
});

import { mentionQuery } from '../src/ui.js';

test('mentionQuery: finds the text after the last "@" at/before the cursor, null once a space interrupts it', () => {
  assert.equal(mentionQuery('look at @src', 12), 'src');
  assert.equal(mentionQuery('look at @', 9), '');
  assert.equal(mentionQuery('no mention here', 10), null);
  assert.equal(mentionQuery('@src then more', 14), null);       // cursor is past the mention; a space interrupted it
  assert.equal(mentionQuery('a@b @c', 3), 'b');                   // only the nearest "@" before the cursor counts
});

test('suggestSlashCommands: a custom "commands" list overrides the SLASH_COMMANDS default (reference-mode backend)', () => {
  const minimal = [['exit', '', 'quit'], ['quit', '', 'alias for /exit']];
  assert.deepEqual(suggestSlashCommands('/ex', { commands: minimal }), [{ command: '/exit', description: 'quit' }]);
  assert.deepEqual(suggestSlashCommands('/stat', { commands: minimal }), []);   // /status isn't in the minimal list
});
