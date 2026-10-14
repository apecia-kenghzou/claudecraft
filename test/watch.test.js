import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileWatcher } from '../src/watch.js';

const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'rea-watch-')));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// fs.watch events are async and platform-timed; poll for a condition instead of a fixed sleep. Under a heavily loaded
// host (e.g. the full suite's many concurrent child processes), the OS can occasionally drop a single notification
// outright rather than just deliver it late - `retryEvery` re-runs `trigger` periodically so a dropped notification
// gets a fresh chance instead of the test waiting out a dead signal.
async function until(fn, timeoutMs = 9000, { retryEvery, trigger } = {}) {
  const start = Date.now();
  let lastRetry = start;
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    if (retryEvery && Date.now() - lastRetry > retryEvery) { lastRetry = Date.now(); trigger(); }
    await wait(20);
  }
  return fn();
}

test('createFileWatcher reports add, change and unlink with absolute paths', async () => {
  const dir = tmp();
  const events = [];
  const w = createFileWatcher(dir, { onEvent: (e) => events.push(e) });
  try {
    const f = path.join(dir, 'a.txt');
    writeFileSync(f, 'one');
    assert.ok(await until(() => events.some((e) => e.file_path === f && e.event === 'add'), 9000, { retryEvery: 1500, trigger: () => writeFileSync(f, 'one') }), JSON.stringify(events));
    writeFileSync(f, 'two');
    assert.ok(await until(() => events.some((e) => e.file_path === f && e.event === 'change'), 9000, { retryEvery: 1500, trigger: () => writeFileSync(f, 'two') }), JSON.stringify(events));
    unlinkSync(f);
    assert.ok(await until(() => events.some((e) => e.file_path === f && e.event === 'unlink'), 9000, { retryEvery: 1500, trigger: () => { try { unlinkSync(f); } catch { /* already gone */ } } }), JSON.stringify(events));
  } finally { w.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('createFileWatcher ignores .git/node_modules/.rea by default', async () => {
  const dir = tmp();
  mkdirSync(path.join(dir, '.git'));
  const events = [];
  const w = createFileWatcher(dir, { onEvent: (e) => events.push(e) });
  try {
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: x');
    const seen = path.join(dir, 'seen.txt');
    writeFileSync(seen, 'hi');
    assert.ok(await until(() => events.some((e) => e.file_path.endsWith('seen.txt')), 9000, { retryEvery: 1500, trigger: () => writeFileSync(seen, 'hi') }));
    await wait(200);
    assert.ok(!events.some((e) => e.file_path.includes('.git')));
  } finally { w.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('recursive watch (where supported) sees nested-directory changes too', { skip: process.platform === 'linux' ? 'no recursive fs.watch on Linux' : false }, async () => {
  const dir = tmp();
  mkdirSync(path.join(dir, 'sub'));
  const events = [];
  const w = createFileWatcher(dir, { onEvent: (e) => events.push(e) });
  try {
    assert.equal(w.recursive, true);
    const f = path.join(dir, 'sub', 'nested.txt');
    writeFileSync(f, 'x');
    assert.ok(await until(() => events.some((e) => e.file_path === f && e.event === 'add'), 9000, { retryEvery: 1500, trigger: () => writeFileSync(f, 'x') }), JSON.stringify(events));
  } finally { w.close(); rmSync(dir, { recursive: true, force: true }); }
});
