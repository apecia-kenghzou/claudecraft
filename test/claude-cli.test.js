import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildArgs, mapEvent, runClaudeCli, summarizeTrace } from '../src/backends/claude-cli.js';

const FAKE = path.resolve('test/fixtures/fake-claude.mjs');
const BIN = path.resolve('bin/claudecraft.js');
async function collect(gen) { const ev = []; let s; while (!(s = await gen.next()).done) ev.push(s.value); return { ev, terminal: s.value }; }

test('buildArgs: stream-json print mode, optional flags, session handling', () => {
  assert.deepEqual(buildArgs({}), ['-p', '--output-format', 'stream-json', '--verbose']);
  const a = buildArgs({ model: 'm', permissionMode: 'plan', allowedTools: ['Read', 'Bash(ls:*)'], sessionId: 'abc', persist: false });
  assert.deepEqual(a, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'm', '--permission-mode', 'plan',
    '--allowedTools', 'Read', 'Bash(ls:*)', '--session-id', 'abc', '--no-session-persistence']);
  assert.ok(buildArgs({ resume: 'abc', sessionId: 'zzz' }).includes('--resume'));
  assert.ok(!buildArgs({ permissionMode: 'default' }).includes('--permission-mode'));
});

test('mapEvent maps assistant, tool_result and result lines', () => {
  assert.equal(mapEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }).events[0].type, 'assistant');
  const tr = mapEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'x' }], is_error: true }] } });
  assert.equal(tr.events[0].result.is_error, true);
  assert.equal(typeof tr.events[0].result.content, 'string');
  assert.equal(mapEvent({ type: 'result', is_error: true, subtype: 'error_max_turns' }).terminal.reason, 'max_turns');
  assert.equal(mapEvent({ type: 'result', is_error: false, result: 'ok', total_cost_usd: 1 }).terminal.reason, 'completed');
});

test('runClaudeCli: relays events, ignores noise, returns terminal with cost; prompt goes via stdin', async () => {
  const log = path.join(mkdtempSync(path.join(tmpdir(), 'rea-cc-')), 'log.jsonl');
  const { ev, terminal } = await collect(runClaudeCli({ prompt: 'hello there', bin: FAKE, env: { ...process.env, FAKE_CLAUDE_LOG: log }, model: 'm1' }));
  assert.deepEqual(ev.map((e) => e.type), ['init', 'assistant', 'tool_result', 'assistant']);
  assert.equal(terminal.reason, 'completed');
  assert.equal(terminal.costUsd, 0.0123);
  const rec = JSON.parse(readFileSync(log, 'utf8').trim());
  assert.equal(rec.prompt, 'hello there');
  assert.ok(rec.argv.includes('--model') && rec.argv.includes('m1'));
  assert.deepEqual(summarizeTrace(ev, terminal).toolCalls, [{ tool: 'Read', keys: ['file_path'] }]);
});

test('runClaudeCli: crash without result and missing binary report model_error cleanly', async () => {
  const c = await collect(runClaudeCli({ prompt: 'x', bin: FAKE, env: { ...process.env, FAKE_CLAUDE_MODE: 'crash' } }));
  assert.equal(c.terminal.reason, 'model_error');
  assert.match(c.ev.at(-1).error.message, /exited 3.*boom/);
  const m = await collect(runClaudeCli({ prompt: 'x', bin: '/no/such/claude-binary' }));
  assert.equal(m.terminal.reason, 'model_error');
  assert.match(m.ev.at(-1).error.message, /not found/);
});

test('CLI --backend claude-cli: print mode relays output, shows cost, exit code reflects result; no API key needed', async () => {
  const run = (mode) => new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: tmpdir(), REA_CLAUDE_BIN: FAKE, ...(mode ? { FAKE_CLAUDE_MODE: mode } : {}) };
    const p = spawn('node', [BIN, '--backend', 'claude-cli', '-p', 'what is in a.txt'], { env });
    let out = '', err = '';
    p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { err += b; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end();
  });
  const ok = await run();
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /● Read\(/);
  assert.match(ok.out, /Answer to: what is in a\.txt/);
  assert.match(ok.err, /\[claude-cli\] 2 turns, \$0\.0123/);
  assert.equal((await run('error')).code, 1);
});
