// Core-loop and model-layer behaviours added in v0.16 (see EVIDENCE.md §17).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, defineTool, HOOK_EVENTS } from '../src/harness.js';
import { RuleSet } from '../src/permissions.js';
import { ModelError, createAnthropicModel } from '../src/model/anthropic.js';
import { createOpenAIModel, STRIP_RULES } from '../src/model/openai.js';
import { TaskList } from '../src/tasks.js';

const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', ...extra });
const use = (...calls) => ({ content: calls.map(([name, input], i) => ({ type: 'tool_use', id: `u${i}`, name, input })), stop_reason: 'tool_use' });
const scripted = (...r) => { const reqs = []; let i = 0; const f = async (req) => { reqs.push(structuredClone(req.messages)); const v = r[Math.min(i++, r.length - 1)]; if (v instanceof Error) throw v; return v; }; f.reqs = reqs; return f; };
async function drive(h, p = 'go') { const ev = []; const g = h.query(p); let s; while (!(s = await g.next()).done) ev.push(s.value); return { ev, t: s.value }; }
const transitions = (ev) => ev.filter((e) => e.type === 'transition').map((e) => e.reason);
const noop = defineTool({ name: 'T', isReadOnly: () => true, call: () => 'ok' });

test('hook event list now includes the core permission / failure / switch / task events', () => {
  for (const e of ['PermissionRequest', 'PermissionDenied', 'StopFailure', 'Notification', 'UserPromptExpansion', 'PreModelSwitch', 'PostModelSwitch', 'TaskCreated', 'TaskCompleted']) {
    assert.ok(HOOK_EVENTS.includes(e), e);
  }
});

test('refusal: refused output dropped, nudged retry once, then the second answer stands', async () => {
  const model = scripted({ content: [{ type: 'text', text: 'I cannot' }], stop_reason: 'refusal' }, text('here is the safe part'));
  const h = new Harness({ model, tools: [] });
  const { ev, t } = await drive(h);
  assert.deepEqual(transitions(ev), ['refusal_retry']);
  assert.equal(t.reason, 'completed');
  assert.equal(t.text, 'here is the safe part');
  assert.equal(h.messages.filter((m) => m.role === 'assistant').length, 1);          // the refusal was not kept
  assert.match(model.reqs[1].at(-1).content, /declined/);

  const twice = scripted({ content: [], stop_reason: 'refusal' });
  const h2 = new Harness({ model: twice, tools: [] });
  const r = await drive(h2);
  assert.equal(r.t.reason, 'completed');                                              // second refusal ends normally
  assert.match(h2.messages.at(-1).content[0].text, /declined to respond/);
});

test('refusal retry can use a fallback model and restores the original afterwards', async () => {
  const seen = [];
  let current = 'main';
  const model = async () => { seen.push(current); return seen.length === 1 ? { content: [], stop_reason: 'refusal' } : text('ok'); };
  Object.defineProperty(model, 'modelName', { get: () => current });
  model.setModel = (m) => { current = m; };
  const h = new Harness({ model, tools: [], refusalFallbackModel: 'safe-model' });
  const { ev } = await drive(h);
  assert.deepEqual(seen, ['main', 'safe-model']);
  assert.equal(current, 'main');
  assert.ok(ev.some((e) => e.type === 'model_fallback' && e.trigger === 'refusal' && e.to === 'safe-model'));
});

test('Stop hook with stop (continue:false) ends the turn as stop_hook_prevented; a block still wins over it', async () => {
  const h = new Harness({ model: scripted(text('done')), tools: [], hooks: { Stop: [() => ({ stop: true, reason: 'policy window closed' })] } });
  const { ev, t } = await drive(h);
  assert.equal(t.reason, 'stop_hook_prevented');
  assert.equal(t.stopReason, 'policy window closed');
  assert.ok(ev.some((e) => e.type === 'warning' && /Stopped by a Stop hook/.test(e.message)));

  let n = 0;
  const h2 = new Harness({ model: scripted(text('a'), text('b')), tools: [],
    hooks: { Stop: [() => (n++ === 0 ? { decision: 'block', reason: 'again' } : {}), () => ({ stop: true })] } });
  const r2 = await drive(h2);
  assert.deepEqual(transitions(r2.ev), ['stop_hook_blocking']);
});

test('error classification: API errors are api_error (with transience), media errors image_error, others model_error; StopFailure fires', async () => {
  const failures = [];
  const hooks = { StopFailure: [(p) => { failures.push(p); }] };
  const mk = (err) => new Harness({ model: scripted(err), tools: [], hooks });
  const api = await drive(mk(new ModelError('overloaded', 'busy', { retryable: true })));
  assert.equal(api.t.reason, 'api_error');
  assert.equal(api.t.isTransient, true);
  assert.equal(api.t.errorKind, 'overloaded');
  const auth = await drive(mk(new ModelError('auth', 'bad key')));
  assert.equal(auth.t.reason, 'api_error');
  assert.equal(auth.t.isTransient, false);
  const img = await drive(mk(new ModelError('invalid_request', 'Could not process image: too large')));
  assert.equal(img.t.reason, 'image_error');
  const other = await drive(mk(new TypeError('boom')));
  assert.equal(other.t.reason, 'model_error');
  const long = await drive(mk(new ModelError('prompt_too_long', 'too long')));
  assert.equal(long.t.reason, 'prompt_too_long');
  assert.deepEqual(failures.map((f) => f.reason), ['api_error', 'api_error', 'model_error']);   // image/prompt errors are not "failures" of the turn
});

test('hook defer: non-interactive solo call ends the turn as tool_deferred; interactive or batched falls back to ask', async () => {
  const deferHook = { PreToolUse: [() => ({ permission: 'defer', reason: 'needs human review' })] };
  const write = defineTool({ name: 'W', call: () => 'wrote' });
  const solo = new Harness({ model: scripted(use(['W', { x: 1 }]), text('never')), tools: [write], nonInteractive: true, hooks: deferHook, askUser: () => true });
  const r = await drive(solo);
  assert.equal(r.t.reason, 'tool_deferred');
  assert.deepEqual(r.t.deferred, [{ id: 'u0', name: 'W', input: { x: 1 } }]);
  assert.match(solo.messages.at(-1).content[0].content, /deferred/);                  // history stays valid: the call has a result

  const asked = [];
  const inter = new Harness({ model: scripted(use(['W', {}]), text('done')), tools: [write], nonInteractive: false, hooks: deferHook, askUser: () => { asked.push(1); return true; } });
  assert.equal((await drive(inter)).t.reason, 'completed');
  assert.equal(asked.length, 1);

  const batch = new Harness({ model: scripted(use(['W', {}], ['W', {}]), text('done')), tools: [write], nonInteractive: true, hooks: deferHook, askUser: () => true });
  assert.equal((await drive(batch)).t.reason, 'completed');                           // defer is solo-only
});

test('requestStop ends cleanly at the next boundary and keeps tool results valid', async () => {
  let h;
  const stopper = defineTool({ name: 'S', isReadOnly: () => true, call: () => { h.requestStop('moved to background'); return 'ok'; } });
  h = new Harness({ model: scripted(use(['S', {}]), text('would continue')), tools: [stopper] });
  const { t } = await drive(h);
  assert.equal(t.reason, 'background_requested');
  assert.equal(t.why, 'moved to background');
  assert.equal(h.messages.at(-1).role, 'user');                                       // tool_result is in place
  assert.equal(h.stopRequested, null);
});

test('messages queued during a turn are absorbed at the next boundary', async () => {
  let h;
  const slow = defineTool({ name: 'S', isReadOnly: () => true, call: () => { h.queueMessage('also use tabs, not spaces'); return 'ok'; } });
  const model = scripted(use(['S', {}]), text('noted'));
  h = new Harness({ model, tools: [slow] });
  const { ev, t } = await drive(h);
  assert.equal(t.reason, 'completed');
  assert.ok(ev.some((e) => e.type === 'absorbed_mid_turn' && e.text === 'also use tabs, not spaces'));
  const lastReq = model.reqs.at(-1);
  assert.match(JSON.stringify(lastReq.at(-1).content), /sent this while you were working[\s\S]*also use tabs/);
  assert.ok(h.userPrompts.includes('also use tabs, not spaces'));
});

test('prompt-cache coverage: a drop from cached to zero emits cache_miss and is counted', async () => {
  const usage = [{ input_tokens: 10, cache_read_input_tokens: 0 }, { input_tokens: 10, cache_read_input_tokens: 900 }, { input_tokens: 900, cache_read_input_tokens: 0 }];
  let i = 0;
  const model = async () => (i < 2 ? { ...use(['T', {}]), usage: usage[i++] } : { ...text('done'), usage: usage[i++] });
  const h = new Harness({ model, tools: [noop] });
  const { ev } = await drive(h);
  const miss = ev.filter((e) => e.type === 'cache_miss');
  assert.equal(miss.length, 1);
  assert.equal(miss[0].previousCached, 900);
  assert.equal(h.usageTotals.cache_misses, 1);
});

test('PermissionRequest hooks can answer for the user; PermissionDenied is emitted on a denial', async () => {
  const write = defineTool({ name: 'W', call: () => 'wrote' });
  const denied = [];
  let prompted = 0;
  const allow = new Harness({ model: scripted(use(['W', {}]), text('ok')), tools: [write], askUser: () => { prompted++; return false; },
    hooks: { PermissionRequest: [() => ({ permission: 'allow' })] } });
  await drive(allow);
  assert.equal(prompted, 0);
  assert.equal(allow.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result').content[0].content, 'wrote');

  const deny = new Harness({ model: scripted(use(['W', {}]), text('ok')), tools: [write], askUser: () => true,
    hooks: { PermissionRequest: [() => ({ permission: 'deny', reason: 'frozen' })], PermissionDenied: [(p) => { denied.push(p); }] } });
  await drive(deny);
  assert.match(deny.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result').content[0].content, /frozen/);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].tool, 'W');

  const byRule = new Harness({ model: scripted(use(['W', {}]), text('ok')), tools: [write], rules: new RuleSet({ cwd: '/p' }).add('deny', 'W'),
    hooks: { PermissionDenied: [(p) => { denied.push(p); }] } });
  await drive(byRule);
  assert.equal(denied.length, 2);
});

test('TaskList emits created/completed events once, only on the transition', () => {
  const ev = [];
  const l = new TaskList([], null, (e) => ev.push(`${e.type}:${e.task.id}`));
  const a = l.create({ subject: 'a' });
  l.update(a.id, { status: 'in_progress' });
  l.update(a.id, { status: 'completed' });
  l.update(a.id, { status: 'completed' });
  assert.deepEqual(ev, ['created:1', 'completed:1']);
});

// ---- model layer: strip-and-retry ------------------------------------------------------------------------
const err400 = (msg) => new Response(JSON.stringify({ error: { message: msg, type: 'invalid_request_error' } }), { status: 400 });
const sseOk = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
async function collect(gen) { const ev = []; let s; while (!(s = await gen.next()).done) ev.push(s.value); return { ev, msg: s.value }; }

test('openai provider strips rejected optional parameters once each and retries', async () => {
  const bodies = [];
  const responses = [err400("Unrecognized request argument supplied: stream_options"), err400('Unknown field max_completion_tokens'), sseOk()];
  const fetchImpl = async (_u, init) => { bodies.push(JSON.parse(init.body)); return responses[bodies.length - 1]; };
  const m = createOpenAIModel({ apiKey: 'k', baseURL: 'http://h/v1', fetchImpl, sleep: async () => {} });
  const { ev, msg } = await collect(m({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }));
  assert.equal(msg.content[0].text, 'ok');
  assert.ok('stream_options' in bodies[0] && 'max_completion_tokens' in bodies[0]);
  assert.ok(!('stream_options' in bodies[1]) && 'max_completion_tokens' in bodies[1]);
  assert.ok(!('stream_options' in bodies[2]) && !('max_completion_tokens' in bodies[2]) && bodies[2].max_tokens === 8192);
  assert.equal(ev.filter((e) => e.type === 'warning').length, 2);
  assert.equal(STRIP_RULES.length, 2);

  // an unrelated 400 is not stripped and not retried forever
  const f2 = async () => err400('model not found');
  const m2 = createOpenAIModel({ apiKey: 'k', fetchImpl: f2, sleep: async () => {} });
  await assert.rejects(collect(m2({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [] })), /model not found/);
});

test('openai content_filter finish maps to refusal; anthropic client drops cache markers a server rejects', async () => {
  const filtered = new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: 'content_filter' }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
  const m = createOpenAIModel({ apiKey: 'k', fetchImpl: async () => filtered, sleep: async () => {} });
  assert.equal((await collect(m({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [] }))).msg.stop_reason, 'refusal');

  const bodies = [];
  const ok = new Response(`event: message_start\ndata: ${JSON.stringify({ message: { usage: {} } })}\n\nevent: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'text_delta', text: 'hi' } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' } })}\n\nevent: message_stop\ndata: {}\n\n`, { status: 200 });
  const fetchImpl = async (_u, init) => { bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? err400('system.0.cache_control: Extra inputs are not permitted') : ok; };
  const a = createAnthropicModel({ apiKey: 'k', fetchImpl, sleep: async () => {} });
  const { ev, msg } = await collect(a({ system: 'S', messages: [{ role: 'user', content: 'x' }], tools: [] }));
  assert.equal(msg.content[0].text, 'hi');
  assert.ok(JSON.stringify(bodies[0]).includes('cache_control'));
  assert.ok(!JSON.stringify(bodies[1]).includes('cache_control'));
  assert.ok(ev.some((e) => e.type === 'warning' && /cache_control/.test(e.message)));
});
