import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLspTool, resolveColumn, serverForFile, DEFAULT_SERVERS } from '../src/lsp.js';

const SERVER = path.resolve('test/fixtures/mock-lsp-server.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'rea-lsp-'));
const mockServers = (ext, env = {}) => ({ [ext]: { command: process.execPath, args: [SERVER], env } });

function writeSample(dir, ext = '.ts') {
  const file = path.join(dir, `a${ext}`);
  writeFileSync(file, 'function foo() {}\nfoo();\n\nconst x = 1;\nfoo();\n');
  return file;
}

test('resolveColumn: whole-word match, occurrence index, no match', () => {
  assert.equal(resolveColumn('function foo() {}', 'foo'), 9);
  assert.equal(resolveColumn('foo bar foo', 'foo', 2), 8);                 // "foofoo" never counts: no word boundary inside it
  assert.equal(resolveColumn('nothing here', 'zzz'), null);
  assert.equal(resolveColumn('const foobar = 1;', 'foo'), null);   // whole-word only: "foobar" is not "foo"
});

test('serverForFile: extension lookup is case-insensitive; unknown extensions are unmatched', () => {
  assert.equal(serverForFile('a.rs').command, 'rust-analyzer');
  assert.equal(serverForFile('A.TS').command, 'typescript-language-server');
  assert.equal(serverForFile('a.zzz'), undefined);
  assert.ok(Object.keys(DEFAULT_SERVERS).length > 5);
});

test('validateInput: unknown extension is rejected before spawning anything; documentSymbol does not need one', () => {
  const tool = createLspTool({ cwd: tmp() });
  assert.equal(tool.validateInput({ action: 'definition', file_path: 'a.zzz' }).ok, false);
  assert.equal(tool.validateInput({ action: 'documentSymbol', file_path: 'a.zzz' }).ok, true);
});

test('documentSymbol and hover against the mock server', async () => {
  const cwd = tmp();
  writeSample(cwd);
  const tool = createLspTool({ cwd, servers: mockServers('.ts') });
  try {
    assert.match(await tool.call({ action: 'documentSymbol', file_path: 'a.ts' }), /foo \(function\) :1/);
    assert.match(await tool.call({ action: 'hover', file_path: 'a.ts', line: 1, symbol: 'foo' }), /function foo\(\): void/);
  } finally { await tool.close(); }
});

test('definition and references resolve a position from line + symbol text, formatted as path:line with a snippet', async () => {
  const cwd = tmp();
  writeSample(cwd);
  const tool = createLspTool({ cwd, servers: mockServers('.ts') });
  try {
    const def = await tool.call({ action: 'definition', file_path: 'a.ts', line: 2, symbol: 'foo' });
    assert.match(def, /^a\.ts:5: foo\(\);$/m);
    const refs = await tool.call({ action: 'references', file_path: 'a.ts', line: 2, symbol: 'foo' });
    assert.equal(refs.split('\n').length, 2);
    assert.match(refs, /a\.ts:2: foo\(\);/);
    assert.match(refs, /a\.ts:5: foo\(\);/);
  } finally { await tool.close(); }
});

test('symbol wins when the model sends both symbol and a meaningless character (0): the real-world case that mattered', async () => {
  const cwd = tmp();
  writeSample(cwd);
  const tool = createLspTool({ cwd, servers: mockServers('.ts') });
  try {
    // a model-sent character:0 (or 1, as a default/placeholder) must not shadow a valid symbol
    const out = await tool.call({ action: 'definition', file_path: 'a.ts', line: 2, symbol: 'foo', character: 0 });
    assert.match(out, /a\.ts:5/);
  } finally { await tool.close(); }
});

test('an explicit 1-based character also works, without needing "symbol"', async () => {
  const cwd = tmp();
  writeSample(cwd);
  const tool = createLspTool({ cwd, servers: mockServers('.ts') });
  try {
    assert.match(await tool.call({ action: 'definition', file_path: 'a.ts', line: 2, character: 1 }), /a\.ts:5/);
  } finally { await tool.close(); }
});

test('errors: unknown symbol on the line, line past EOF, missing position info', async () => {
  const cwd = tmp();
  writeSample(cwd);
  const tool = createLspTool({ cwd, servers: mockServers('.ts') });
  try {
    await assert.rejects(tool.call({ action: 'definition', file_path: 'a.ts', line: 2, symbol: 'nope' }), /was not found on line 2/);
    await assert.rejects(tool.call({ action: 'definition', file_path: 'a.ts', line: 999, symbol: 'foo' }), /past the end/);
    await assert.rejects(tool.call({ action: 'hover', file_path: 'a.ts', line: 1 }), /Provide either "symbol"/);
    await assert.rejects(tool.call({ action: 'definition', file_path: 'missing.ts', line: 1, symbol: 'x' }), /File not found/);
  } finally { await tool.close(); }
});

test('no-result and diagnostics modes; the connection is reused (and re-synced) across calls', async () => {
  const cwd = tmp();
  writeSample(cwd);
  const log = path.join(cwd, 'log.jsonl');
  const tool = createLspTool({ cwd, servers: mockServers('.ts', { MOCK_LSP_MODE: 'no-result', MOCK_LSP_LOG: log }) });
  try {
    assert.match(await tool.call({ action: 'definition', file_path: 'a.ts', line: 2, symbol: 'foo' }), /No definition found for "foo"/);
    await tool.call({ action: 'hover', file_path: 'a.ts', line: 1, symbol: 'foo' });
    const { readFileSync } = await import('node:fs');
    const inits = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).in).filter((m) => m === 'initialize');
    assert.equal(inits.length, 1);                                          // one server process reused for both calls
  } finally { await tool.close(); }

  const d = createLspTool({ cwd, servers: mockServers('.ts', { MOCK_LSP_MODE: 'diagnostics' }) });
  try {
    const out = await d.call({ action: 'documentSymbol', file_path: 'a.ts' });
    assert.match(out, /Diagnostics for a\.ts:\nerror 1:1: mock error/);
  } finally { await d.close(); }
});

test('startup failures: crashing server, missing binary', async () => {
  const cwd = tmp();
  writeSample(cwd);
  const crash = createLspTool({ cwd, servers: mockServers('.ts', { MOCK_LSP_MODE: 'crash' }) });
  await assert.rejects(crash.call({ action: 'documentSymbol', file_path: 'a.ts' }), /exited with code 9.*cannot start/s);
  const missing = createLspTool({ cwd, servers: { '.ts': { command: '/no/such/language-server', args: [] } } });
  await assert.rejects(missing.call({ action: 'documentSymbol', file_path: 'a.ts' }), /could not start/);
});

test('tool.status() reports connected servers', async () => {
  const cwd = tmp();
  writeSample(cwd);
  const tool = createLspTool({ cwd, servers: mockServers('.ts') });
  assert.deepEqual(tool.status(), []);
  await tool.call({ action: 'documentSymbol', file_path: 'a.ts' });
  assert.equal(tool.status().length, 1);
  assert.equal(tool.status()[0].running, true);
  await tool.close();
  assert.equal(tool.status()[0].running, false);
});
