// The generator loop: terminal reasons and continue-transitions (ARCHITECTURE.md §2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, defineTool } from '../src/harness.js';

const msg = (content, stop_reason) => ({ content, stop_reason: stop_reason ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn') });
const text = (t, stop) => msg([{ type: 'text', text: t }], stop);
const tool = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const scripted = (...r) => { const calls = []; let i = 0; const f = async (req) => { calls.push(structuredClone(req.messages)); return r[Math.min(i++, r.length - 1)]; }; f.calls = calls; return f; };
const echo = defineTool({ name: 'Echo', isReadOnly: () => true, isConcurrencySafe: () => true, call: () => 'echoed' });

async function drive(h, prompt = 'go') {
  const events = []; const gen = h.query(prompt); let s;
  while (!(s = await gen.next()).done) events.push(s.value);
  return { events, terminal: s.value };
}
const transitions = (events) => events.filter((e) => e.type === 'transition').map((e) => e.reason);

test('completed after tool use: next_turn transition then completed', async () => {
  const h = new Harness({ model: scripted(msg([tool('a', 'Echo')]), text('done')), tools: [echo] });
  const { events, terminal } = await drive(h);
  assert.deepEqual(transitions(events), ['next_turn']);
  assert.equal(terminal.reason, 'completed');
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 1);
});

test('max_tokens: partial kept, continuation nudged, then recovered', async () => {
  const model = scripted(text('part one', 'max_tokens'), text(' part two'));
  const h = new Harness({ model, tools: [] });
  const { events, terminal } = await drive(h);
  assert.deepEqual(transitions(events), ['max_output_tokens_recovery']);
  assert.equal(terminal.reason, 'completed');
  assert.equal(model.calls[1][1].role, 'assistant');          // partial answer preserved
  assert.match(model.calls[1][2].content, /cut off/);         // nudge
});

test('max_tokens exhausted after 3 recoveries', async () => {
  const h = new Harness({ model: scripted(text('x', 'max_tokens')), tools: [] });
  const { events, terminal } = await drive(h);
  assert.equal(transitions(events).length, 3);
  assert.equal(terminal.reason, 'max_output_tokens_exhausted');
});

test('malformed tool use: one retry, then malformed_tool_use_exhausted', async () => {
  const bad = msg([], 'tool_use');
  const ok = new Harness({ model: scripted(bad, text('fine')), tools: [] });
  const r1 = await drive(ok);
  assert.deepEqual(transitions(r1.events), ['malformed_tool_use_retry']);
  assert.equal(r1.terminal.reason, 'completed');

  const never = new Harness({ model: scripted(bad), tools: [] });
  const r2 = await drive(never);
  assert.equal(r2.terminal.reason, 'malformed_tool_use_exhausted');
});

test('thinking-only answer is nudged once and the empty message is not kept', async () => {
  const model = scripted(msg([{ type: 'thinking', thinking: 'hmm', signature: 's' }], 'end_turn'), text('answer'));
  const h = new Harness({ model, tools: [] });
  const { events, terminal } = await drive(h);
  assert.deepEqual(transitions(events), ['thinking_only_retry']);
  assert.equal(terminal.reason, 'completed');
  assert.equal(model.calls[1].filter((m) => m.role === 'assistant').length, 0);
});

test('stop hook blocking: re-enters, and is overridden after the cap', async () => {
  process.env.REA_STOP_HOOK_BLOCK_CAP = '2';
  try {
    const h = new Harness({ model: scripted(text('a')), tools: [], hooks: { Stop: [() => ({ decision: 'block', reason: 'run the tests' })] } });
    const { events, terminal } = await drive(h);
    assert.deepEqual(transitions(events), ['stop_hook_blocking', 'stop_hook_blocking']);
    assert.equal(terminal.reason, 'completed');
    assert.ok(events.some((e) => e.type === 'warning' && /overriding/.test(e.message)));
  } finally { delete process.env.REA_STOP_HOOK_BLOCK_CAP; }
});

test('max_turns terminal reason and event', async () => {
  const h = new Harness({ model: scripted(msg([tool('a', 'Echo')])), tools: [echo], maxTurns: 2 });
  const { events, terminal } = await drive(h);
  assert.equal(terminal.reason, 'max_turns');
  assert.ok(events.some((e) => e.type === 'max_turns_reached'));
});

test('PostToolBatch hook stop => hook_stopped', async () => {
  const h = new Harness({ model: scripted(msg([tool('a', 'Echo')]), text('x')), tools: [echo], hooks: { PostToolBatch: [() => ({ stop: true, reason: 'enough' })] } });
  assert.equal((await drive(h)).terminal.reason, 'hook_stopped');
});

test('model errors map to model_error / prompt_too_long and keep history valid', async () => {
  const boom = (kind) => async () => { const e = new Error('x'); e.kind = kind; throw e; };
  assert.equal((await drive(new Harness({ model: boom('server'), tools: [] }))).terminal.reason, 'model_error');
  assert.equal((await drive(new Harness({ model: boom('prompt_too_long'), tools: [] }))).terminal.reason, 'prompt_too_long');
});

test('abort: during model call -> aborted_streaming; during tools -> aborted_tools with synthetic results', async () => {
  const ac1 = new AbortController();
  const m1 = async () => { ac1.abort(); throw new Error('aborted'); };
  assert.equal((await drive(new Harness({ model: m1, tools: [], signal: ac1.signal }))).terminal.reason, 'aborted_streaming');

  const ac2 = new AbortController();
  const slow = defineTool({ name: 'Slow', call: async () => { ac2.abort(); return 'ok'; } });
  const queued = defineTool({ name: 'After', call: async () => 'never' });
  const h = new Harness({ model: scripted(msg([tool('a', 'Slow'), tool('b', 'After')])), tools: [slow, queued], signal: ac2.signal, permissionMode: 'bypassPermissions' });
  const { terminal } = await drive(h);
  assert.equal(terminal.reason, 'aborted_tools');
  const last = h.messages.at(-1).content;
  assert.equal(last.length, 2);                       // every tool_use has a tool_result
  assert.match(last[1].content, /Interrupted/);
});

test('streaming model: deltas pass through query() events', async () => {
  const model = async function* () { yield { type: 'text_delta', text: 'Hi' }; return text('Hi'); };
  const { events } = await drive(new Harness({ model, tools: [] }));
  assert.deepEqual(events.filter((e) => e.type === 'text_delta').map((e) => e.text), ['Hi']);
});
