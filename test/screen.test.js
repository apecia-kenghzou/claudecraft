import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setScrollRegion, resetScrollRegion, enableMouse, disableMouse, drawFooter, footerCursorPosition,
  parseMouseEvent, mouseToEditorColumn,
} from '../src/screen.js';

test('setScrollRegion/resetScrollRegion: DECSTBM sequences, clamped to at least row 1', () => {
  assert.equal(setScrollRegion(40, 2), '\x1b[1;38r');
  assert.equal(setScrollRegion(2, 5), '\x1b[1;1r');          // footer taller than the screen: clamp, don't go negative
  assert.equal(resetScrollRegion(), '\x1b[r');
});

test('enableMouse/disableMouse: SGR (1006) + basic (1000) mouse reporting, symmetric on/off', () => {
  assert.equal(enableMouse(), '\x1b[?1000h\x1b[?1006h');
  assert.equal(disableMouse(), '\x1b[?1006l\x1b[?1000l');
});

test('drawFooter: saves/restores cursor, positions and clears each footer row, writes content', () => {
  const out = drawFooter({ rows: 40, footerRows: 2, lines: ['> hello', '  world'] });
  assert.equal(out, '\x1b7\x1b[39;1H\x1b[2K> hello\x1b[40;1H\x1b[2K  world\x1b8');
});

test('drawFooter: extra lines beyond footerRows are dropped (caller is expected to wrap/truncate)', () => {
  const out = drawFooter({ rows: 10, footerRows: 1, lines: ['one', 'two', 'three'] });
  assert.equal(out, '\x1b7\x1b[10;1H\x1b[2Kone\x1b8');
});

test('footerCursorPosition: row/col translated into the footer region, 1-based', () => {
  assert.equal(footerCursorPosition({ rows: 40, footerRows: 2, editorRow: 0, editorCol: 3, prefixWidth: 2 }), '\x1b[39;6H');
  assert.equal(footerCursorPosition({ rows: 40, footerRows: 2, editorRow: 1, editorCol: 0, prefixWidth: 2 }), '\x1b[40;3H');
});

test('parseMouseEvent: SGR press and release, non-mouse input returns null', () => {
  assert.deepEqual(parseMouseEvent('\x1b[<0;10;39M'), { button: 0, x: 10, y: 39, pressed: true });
  assert.deepEqual(parseMouseEvent('\x1b[<0;10;39m'), { button: 0, x: 10, y: 39, pressed: false });
  assert.equal(parseMouseEvent('hello'), null);
  assert.equal(parseMouseEvent('\x1b[A'), null);                  // an arrow key, not a mouse report
});

test('mouseToEditorColumn: only a left-click press on the prompt row maps to a column; everything else is null', () => {
  const base = { rows: 40, footerRows: 2, prefixWidth: 2, lineLength: 20 };
  assert.equal(mouseToEditorColumn({ button: 0, x: 10, y: 39, pressed: true }, base), 7);     // x=10, prefix=2 -> col 7
  assert.equal(mouseToEditorColumn({ button: 0, x: 1, y: 39, pressed: true }, base), 0);      // clamped to 0, not negative
  assert.equal(mouseToEditorColumn({ button: 0, x: 999, y: 39, pressed: true }, base), 20);   // clamped to lineLength
  assert.equal(mouseToEditorColumn({ button: 0, x: 10, y: 40, pressed: true }, base), null);  // second footer row, not the prompt row
  assert.equal(mouseToEditorColumn({ button: 0, x: 10, y: 39, pressed: false }, base), null); // release, not press
  assert.equal(mouseToEditorColumn({ button: 2, x: 10, y: 39, pressed: true }, base), null);  // right-click
  assert.equal(mouseToEditorColumn(null, base), null);
});

test('footerCursorPosition / mouseToEditorColumn: headerRows shifts both consistently (e.g. a divider above the input)', () => {
  assert.equal(footerCursorPosition({ rows: 40, footerRows: 12, editorRow: 0, editorCol: 0, prefixWidth: 2, headerRows: 1 }), '\x1b[30;3H');
  const base = { rows: 40, footerRows: 12, prefixWidth: 2, lineLength: 20, headerRows: 1 };
  // row 29 is the header/divider row itself - never clickable as the input
  assert.equal(mouseToEditorColumn({ button: 0, x: 10, y: 29, pressed: true }, base), null);
  // row 30 (top + headerRows) is the actual input row
  assert.equal(mouseToEditorColumn({ button: 0, x: 10, y: 30, pressed: true }, base), 7);
});
