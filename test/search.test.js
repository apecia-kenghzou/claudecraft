import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { grep, glob, splitGlobs } from '../src/search.js';

function fixture() {
  const d = mkdtempSync(path.join(tmpdir(), 'rea-'));
  mkdirSync(path.join(d, 'src')); mkdirSync(path.join(d, '.git'));
  writeFileSync(path.join(d, 'src/a.js'), 'const x = 1;\nfunction hello() {}\n');
  writeFileSync(path.join(d, 'src/b.ts'), 'export function hello2() {}\n// TODO later\n');
  writeFileSync(path.join(d, '.git/config'), 'function hidden() {}\n');
  utimesSync(path.join(d, 'src/a.js'), new Date(1e12), new Date(1e12)); // older
  return d;
}

test('splitGlobs keeps brace groups intact', () => {
  assert.deepEqual(splitGlobs('*.js,*.ts'), ['*.js', '*.ts']);
  assert.deepEqual(splitGlobs('*.{ts,tsx} src/**'), ['*.{ts,tsx}', 'src/**']);
});

test('grep: files_with_matches, VCS dirs excluded, newest first', () => {
  const cwd = fixture();
  const r = grep({ cwd, pattern: 'function' });
  assert.deepEqual(r.lines, ['src/b.ts', 'src/a.js']);
});

test('grep: content mode with line numbers, glob filter, ignoreCase', () => {
  const cwd = fixture();
  const r = grep({ cwd, pattern: 'todo', outputMode: 'content', glob: '*.ts', ignoreCase: true });
  assert.deepEqual(r.lines, ['src/b.ts:2:// TODO later']);
});

test('grep: head_limit and offset page results and flag truncation', () => {
  const cwd = fixture();
  const r = grep({ cwd, pattern: 'function', headLimit: 1 });
  assert.equal(r.lines.length, 1); assert.equal(r.truncated, true);
  assert.equal(grep({ cwd, pattern: 'function', headLimit: 1, offset: 1 }).lines[0], 'src/a.js');
});

test('grep: count mode', () => {
  const cwd = fixture();
  assert.ok(grep({ cwd, pattern: 'function', outputMode: 'count' }).lines.includes('src/a.js:1'));
});

test('glob: pattern + mtime sort', () => {
  const cwd = fixture();
  assert.deepEqual(glob({ cwd, pattern: 'src/*' }).files, ['src/b.ts', 'src/a.js']);
  assert.deepEqual(glob({ cwd, pattern: '**/*.js' }).files, ['src/a.js']);
});
