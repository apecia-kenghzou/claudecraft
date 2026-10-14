// Each test pins one behaviour found in Claude Code's bundle (see EVIDENCE.md §4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, defineTool, ToolExecutor } from '../src/index.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const use = (...calls) => ({ content: calls.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}`, name, input })) });
const scripted = (...r) => { let i = 0; return async () => r[i++]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resultsOf = async (h) => (await h.run('go')).messages[2].content;

const write = defineTool({ name: 'Write', call: () => 'written' });
const read = defineTool({
  name: 'Read', inputSchema: { type: 'object', required: ['p'], properties: { p: { type: 'string' } } },
  isReadOnly: () => true, isConcurrencySafe: () => true, call: ({ p }) => p,
});

test('errors are wrapped in <tool_use_error> and unknown tool uses the exact wording', async () => {
  const h = new Harness({ model: scripted(use(['Nope', {}]), text('x')), tools: [] });
  const [r] = await resultsOf(h);
  assert.equal(r.is_error, true);
  assert.equal(r.content, '<tool_use_error>Error: No such tool available: Nope</tool_use_error>');
});

test('string input is JSON-parsed; unparsable input reports first 200 bytes and common causes', async () => {
  const ok = new Harness({ model: scripted(use(['Read', '{"p":"hi"}']), text('x')), tools: [read] });
  assert.equal((await resultsOf(ok))[0].content, 'hi');
  const bad = new Harness({ model: scripted(use(['Read', '{"p": C:\\bad']), text('x')), tools: [read] });
  const [r] = await resultsOf(bad);
  assert.match(r.content, /could not be parsed as JSON/);
  assert.match(r.content, /Common causes/);
});

test('unrecognized keys are ignored, not an error', async () => {
  const h = new Harness({ model: scripted(use(['Read', { p: 'a', extra: 1 }]), text('x')), tools: [read] });
  assert.equal((await resultsOf(h))[0].content, 'a');
});

test('tool.validateInput rejects before hooks or permission run, with a remedy', async () => {
  let hookRan = false;
  const t = defineTool({ name: 'Edit', validateInput: () => ({ ok: false, message: 'file not read yet', remedy: 'read_first' }), call: () => 'x' });
  const h = new Harness({ model: scripted(use(['Edit', {}]), text('x')), tools: [t], hooks: { PreToolUse: [() => { hookRan = true; }] } });
  const [r] = await resultsOf(h);
  assert.equal(hookRan, false);
  assert.equal(r.content, '<tool_use_error>file not read yet</tool_use_error>');
  assert.equal(r.remedy, 'read_first');
});

test('PreToolUse runs BEFORE permission: hook allow skips the prompt, hook ask forces it', async () => {
  const asked = [];
  const mk = (hook, mode = 'default') => new Harness({
    model: scripted(use(['Write', {}]), text('x')), tools: [write], permissionMode: mode,
    hooks: { PreToolUse: [() => hook] }, askUser: () => { asked.push(1); return true; },
  });
  assert.equal((await resultsOf(mk({ permission: 'allow' })))[0].content, 'written');
  assert.equal(asked.length, 0);
  assert.equal((await resultsOf(mk({ permission: 'ask' }, 'bypassPermissions')))[0].content, 'written');
  assert.equal(asked.length, 1);
});

test('static deny list still beats a hook allow', async () => {
  const h = new Harness({ model: scripted(use(['Write', {}]), text('x')), tools: [write], deny: ['Write'],
    hooks: { PreToolUse: [() => ({ permission: 'allow' })] } });
  assert.match((await resultsOf(h))[0].content, /denied by policy/);
});

test('hook stop yields "Execution stopped by PreToolUse hook"; additionalContext is appended', async () => {
  const h = new Harness({ model: scripted(use(['Write', {}]), text('x')), tools: [write], permissionMode: 'bypassPermissions',
    hooks: { PreToolUse: [() => ({ stop: true, reason: 'frozen', additionalContext: 'repo is frozen' })] } });
  const c = await resultsOf(h);
  assert.match(c[0].content, /Execution stopped by PreToolUse hook: frozen/);
  assert.deepEqual(c[1], { type: 'text', text: 'repo is frozen' });
});

test('isConcurrencySafe that throws counts as unsafe (serialized)', async () => {
  let active = 0, peak = 0;
  const flaky = (name) => defineTool({
    name, isReadOnly: () => true, isConcurrencySafe: () => { throw new Error('boom'); },
    call: async () => { active++; peak = Math.max(peak, active); await sleep(15); active--; return name; },
  });
  const h = new Harness({ model: scripted(use(['A', {}], ['B', {}]), text('x')), tools: [flaky('A'), flaky('B')] });
  await resultsOf(h);
  assert.equal(peak, 1);
});

test('executor: unsafe tool is a barrier; later safe tools wait; results keep call order', async () => {
  const log = [];
  const run = async (b) => { log.push(`start ${b.id}`); await sleep(b.ms); log.push(`end ${b.id}`); return { type: 'tool_result', tool_use_id: b.id, content: b.id }; };
  const ex = new ToolExecutor({ run });
  ex.add({ id: 'r1', ms: 20 }, { safe: true });
  ex.add({ id: 'w', ms: 10 }, { safe: false });  // must wait for r1, and block r2
  ex.add({ id: 'r2', ms: 5 }, { safe: true });
  const out = await ex.drain();
  assert.deepEqual(out.map((r) => r.content), ['r1', 'w', 'r2']);
  assert.deepEqual(log, ['start r1', 'end r1', 'start w', 'end w', 'start r2', 'end r2']);
});

test('executor: concurrency cap and abort produces synthetic errors for queued tools', async () => {
  let active = 0, peak = 0;
  const run = async (b) => { active++; peak = Math.max(peak, active); await sleep(10); active--; return { type: 'tool_result', tool_use_id: b.id, content: 'ok' }; };
  const capped = new ToolExecutor({ run, maxConcurrency: 2 });
  for (let i = 0; i < 5; i++) capped.add({ id: `c${i}` }, { safe: true });
  await capped.drain();
  assert.equal(peak, 2);

  const ac = new AbortController();
  const ex = new ToolExecutor({ run: async (b) => { await sleep(20); return { type: 'tool_result', tool_use_id: b.id, content: 'ran' }; }, signal: ac.signal });
  ex.add({ id: 'a' }, { safe: false });
  ex.add({ id: 'b' }, { safe: false }); // queued behind a
  ac.abort();
  const [a, b] = await ex.drain();
  assert.equal(a.content, 'ran');
  assert.equal(b.is_error, true);
  assert.match(b.content, /Interrupted/);
});
