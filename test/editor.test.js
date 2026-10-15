import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKey, LineEditor, frameLines } from '../src/editor.js';

test('parseKey: control sequences, printable chars, pasted text, unknown bytes', () => {
  assert.deepEqual(parseKey('\r'), { name: 'enter' });
  assert.deepEqual(parseKey('\n'), { name: 'ctrl-j' });
  assert.deepEqual(parseKey('\x7f'), { name: 'backspace' });
  assert.deepEqual(parseKey('\x1b[A'), { name: 'up' });
  assert.deepEqual(parseKey('\x1b[B'), { name: 'down' });
  assert.deepEqual(parseKey('\x1b[C'), { name: 'right' });
  assert.deepEqual(parseKey('\x1b[D'), { name: 'left' });
  assert.deepEqual(parseKey('\x01'), { name: 'home' });
  assert.deepEqual(parseKey('\x05'), { name: 'end' });
  assert.deepEqual(parseKey('\x1b[13;2u'), { name: 'shift-enter' });
  assert.deepEqual(parseKey('\x03'), { name: 'ctrl-c' });
  assert.deepEqual(parseKey('\t'), { name: 'tab' });
  assert.deepEqual(parseKey('\x1b'), { name: 'escape' });
  assert.deepEqual(parseKey('a'), { name: 'char', char: 'a' });
  assert.deepEqual(parseKey('hello world'), { name: 'text', text: 'hello world' });   // multi-char paste
  assert.equal(parseKey('\x1b[99~'), null);                                           // unrecognized escape sequence
});

test('LineEditor: typing, backspace/delete across line boundaries, cursor movement', () => {
  const e = new LineEditor();
  for (const c of 'hi') e.handleKey({ name: 'char', char: c });
  assert.equal(e.text, 'hi');
  e.handleKey({ name: 'left' }); e.handleKey({ name: 'left' });
  e.handleKey({ name: 'char', char: 'X' });
  assert.equal(e.text, 'Xhi');
  e.handleKey({ name: 'end' });
  e.handleKey({ name: 'ctrl-j' });
  e.handleKey({ name: 'text', text: 'there' });
  assert.equal(e.text, 'Xhi\nthere');
  assert.equal(e.row, 1); assert.equal(e.col, 5);
  e.handleKey({ name: 'home' });
  e.handleKey({ name: 'backspace' });                       // joins back into the first line
  assert.equal(e.text, 'Xhithere');
  assert.equal(e.row, 0); assert.equal(e.col, 3);
  e.handleKey({ name: 'left' }); e.handleKey({ name: 'left' });    // col 3 -> 1, between 'X' and 'h'
  e.handleKey({ name: 'delete' });                                  // removes 'h'
  assert.equal(e.text, 'Xithere');
});

test('LineEditor: up/down clamp column to the shorter line; home/end; kill-to-end/kill-line', () => {
  const e = new LineEditor('abcdef\nxy');
  assert.equal(e.row, 1); assert.equal(e.col, 2);           // starts at the end of the initial text
  e.handleKey({ name: 'up' });
  assert.equal(e.row, 0); assert.equal(e.col, 2);           // column preserved, within bounds
  e.handleKey({ name: 'end' });
  e.handleKey({ name: 'down' });
  assert.equal(e.row, 1); assert.equal(e.col, 2);           // clamped to the shorter second line
  e.handleKey({ name: 'up' });
  e.handleKey({ name: 'kill-to-end' });                     // col is still 2 (preserved through end/down/up)
  assert.equal(e.lines[0], 'ab');
  const e2 = new LineEditor('hello');
  e2.handleKey({ name: 'left' }); e2.handleKey({ name: 'left' });
  e2.handleKey({ name: 'kill-line' });
  assert.equal(e2.text, 'lo');
  assert.equal(e2.col, 0);
});

test('LineEditor: Enter submits and clears; ctrl-j and shift-enter insert a newline instead', () => {
  const e = new LineEditor();
  e.handleKey({ name: 'text', text: 'hi' });
  const r = e.handleKey({ name: 'enter' });
  assert.deepEqual(r, { submit: 'hi' });
  assert.equal(e.empty, true);

  e.handleKey({ name: 'text', text: 'a' });
  e.handleKey({ name: 'ctrl-j' });
  e.handleKey({ name: 'text', text: 'b' });
  assert.equal(e.handleKey({ name: 'enter' })?.submit, 'a\nb');

  e.handleKey({ name: 'text', text: 'c' });
  e.handleKey({ name: 'shift-enter' });
  e.handleKey({ name: 'text', text: 'd' });
  assert.equal(e.handleKey({ name: 'enter' })?.submit, 'c\nd');
});

test('LineEditor: a trailing single backslash + Enter adds a newline (and the backslash is dropped); doubled backslash submits', () => {
  const e = new LineEditor();
  e.handleKey({ name: 'text', text: 'line one\\' });
  assert.equal(e.handleKey({ name: 'enter' }), undefined);          // not submitted - newline inserted instead
  e.handleKey({ name: 'text', text: 'line two' });
  assert.equal(e.text, 'line one\nline two');
  assert.deepEqual(e.handleKey({ name: 'enter' }), { submit: 'line one\nline two' });

  const e2 = new LineEditor();
  e2.handleKey({ name: 'text', text: 'keep this\\\\' });            // an escaped literal backslash: submits as-is
  assert.deepEqual(e2.handleKey({ name: 'enter' }), { submit: 'keep this\\\\' });
});

test('LineEditor: constructing from existing multi-line text starts the cursor at its end', () => {
  const e = new LineEditor('one\ntwo\nthree');
  assert.equal(e.row, 2);
  assert.equal(e.col, 5);
  assert.equal(e.lines.length, 3);
});

test('frameLines: the first line is bare, every continuation line is indented to the prompt width', () => {
  const e = new LineEditor('hello\nworld');
  assert.deepEqual(frameLines(e, 2), ['hello', '  world']);
  const single = new LineEditor('just one line');
  assert.deepEqual(frameLines(single, 2), ['just one line']);
});
