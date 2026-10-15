import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMultilineAsk } from '../src/cli.js';
import { createStyle } from '../src/ui.js';

// createMultilineAsk only branches on raw-mode-specific behavior inside screen.js (scroll region/mouse, fullscreen
// only); the key-handling/dropdown logic exercised here is plain data processing, so a fake EventEmitter stdin
// (no real TTY) is sufficient and deterministic - unlike the real-pty scripts used ad hoc during development,
// which proved flaky to time precisely (EVIDENCE.md §29/§33).
class FakeStdin extends EventEmitter {
  setRawMode() {}
}

function makeHarness({ history = [] } = {}) {
  const stdin = new FakeStdin();
  const writes = [];
  const stdout = { write: (s) => writes.push(s), rows: 30, columns: 80 };
  const style = createStyle(false);
  const multilineAsk = createMultilineAsk({
    stdin, stdout, rl: {}, termMode: true, ask: async () => 'fallback', style, cwd: () => process.cwd(),
    onInterrupt: () => {}, multiline: true, fullscreen: false, history,
  });
  const type = (s) => { for (const ch of s) stdin.emit('data', Buffer.from(ch)); };
  const key = (bytes) => stdin.emit('data', Buffer.from(bytes));
  return { multilineAsk, type, key, writes, history };
}

test('createMultilineAsk: typing then Enter submits the line', async () => {
  const { multilineAsk, type, key } = makeHarness();
  const p = multilineAsk('> ');
  type('hello');
  key('\r');
  assert.equal(await p, 'hello');
});

test('createMultilineAsk: Tab accepts the top slash-command hit', async () => {
  const { multilineAsk, type, key } = makeHarness();
  const p = multilineAsk('> ');
  type('/stat');
  key('\t');
  key('\r');
  assert.equal(await p, '/status ');     // Tab-accept appends a trailing space, ready for an argument
});

test('createMultilineAsk: arrow keys move the dropdown selection; Tab then accepts that one, not the top hit', async () => {
  const { multilineAsk, type, key } = makeHarness();
  const p = multilineAsk('> ');
  type('/c');                         // matches /compact, /clear, /cd, /config, ... (several hits)
  key('\x1b[B');                       // down: move off the top hit
  key('\t');
  key('\r');
  const result = await p;
  assert.notEqual(result, '/compact'); // top hit would have been /compact; selection moved off it
  assert.ok(result.startsWith('/'));
});

test('createMultilineAsk: Escape dismisses the dropdown; typing again (changing the query) reopens it', async () => {
  const { multilineAsk, type, key } = makeHarness();
  const p = multilineAsk('> ');
  type('/stat');
  key('\x1b');                         // escape: dismiss
  key('\t');                           // Tab with the dropdown dismissed does nothing (not a real command)
  type('us');                          // still "/status" after completing it, but the query text just changed
  key('\t');                           // dropdown is back (new query), Tab now accepts
  key('\r');
  assert.equal(await p, '/status ');
});

test('createMultilineAsk: Up/Down recall history (most-recent-first) and restore the draft when returning past it', async () => {
  const { multilineAsk, type, key, history } = makeHarness({ history: ['old command'] });
  const p1 = multilineAsk('> ');
  type('/status');
  key('\r');
  assert.equal(await p1, '/status');
  assert.deepEqual(history, ['/status', 'old command']);   // the submission is unshifted to the front

  const p2 = multilineAsk('> ');
  type('draft');
  key('\x1b[A');                       // up: away from the draft, into history[0] ("/status")
  key('\x1b[A');                       // up again: into history[1] ("old command")
  key('\x1b[B');                       // down: back to history[0]
  key('\x1b[B');                       // down again: back past the start, restoring the draft
  key('\r');
  assert.equal(await p2, 'draft');
});

test('createMultilineAsk: history recall is a no-op mid multi-line buffer (does not fight line-to-line cursor movement)', async () => {
  const { multilineAsk, type, key, history } = makeHarness({ history: ['prior'] });
  const p = multilineAsk('> ');
  type('first');
  key('\n');                           // ctrl-j: newline, now on a second line
  type('second');
  key('\x1b[A');                       // up: moves the cursor to line 1, NOT history (lines.length > 1)
  key('\x1b[C');                       // right, to confirm we're still editing, not in a recalled state
  key('\x1b[A');                       // up from line 1 (nowhere to go - row 0): still not history, buffer unchanged
  key('\r');
  assert.equal(await p, 'first\nsecond');
  assert.deepEqual(history, ['first\nsecond', 'prior']);
});
