import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicModel, ModelError, classifyHttp, withCacheControl } from '../src/model/anthropic.js';

const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const sse = (blocks, stop = 'end_turn') => {
  let o = ev('message_start', { message: { model: 'm', usage: { input_tokens: 3 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      o += ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const t of b.parts ?? [b.text]) o += ev('content_block_delta', { index, delta: { type: 'text_delta', text: t } });
    } else {
      o += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      for (const p of b.json) o += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: p } });
    }
    o += ev('content_block_stop', { index });
  });
  return o + ev('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 7 } }) + ev('message_stop', {});
};
const okStream = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const errRes = (status, type, headers = {}) => new Response(JSON.stringify({ error: { type, message: `${type} msg` } }), { status, headers });
const stalling = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ev('message_start', { message: {} }))); /* never closes */ } }), { status: 200 });

const mk = (responses, extra = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); const r = responses[Math.min(calls.length - 1, responses.length - 1)]; return typeof r === 'function' ? r() : r; };
  const sleeps = [];
  const model = createAnthropicModel({ apiKey: 'k', fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, baseDelayMs: 10, ...extra });
  return { model, calls, sleeps };
};
async function collect(gen) {
  const events = []; let s;
  while (!(s = await gen.next()).done) events.push(s.value);
  return { events, message: s.value };
}
const req = { system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] };

test('streams text and tool_use, assembling partial JSON; emits deltas', async () => {
  const body = sse([{ type: 'text', parts: ['Hel', 'lo'] }, { type: 'tool_use', id: 't1', name: 'Read', json: ['{"file_', 'path":"a.js"}'] }], 'tool_use');
  const { model } = mk([okStream(body)]);
  const { events, message } = await collect(model(req));
  assert.deepEqual(events.filter((e) => e.type === 'text_delta').map((e) => e.text), ['Hel', 'lo']);
  assert.deepEqual(message.content, [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } }]);
  assert.equal(message.stop_reason, 'tool_use');
  assert.equal(message.usage.output_tokens, 7);
});

test('tool_use with unparsable JSON is dropped and counted as malformed', async () => {
  const body = sse([{ type: 'tool_use', id: 't', name: 'Read', json: ['{"file_path": "a'] }], 'tool_use');
  const { message } = await collect(mk([okStream(body)]).model(req));
  assert.deepEqual(message.content, []);
  assert.equal(message.malformed, 1);
});

test('request: stream flag, cache_control on system + last block, lone surrogates replaced', async () => {
  const { model, calls } = mk([okStream(sse([{ type: 'text', text: 'ok' }]))]);
  await collect(model({ ...req, messages: [{ role: 'user', content: 'bad \uD800 char' }] }));
  const b = calls[0];
  assert.equal(b.stream, true);
  assert.deepEqual(b.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(b.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
  assert.match(b.messages.at(-1).content[0].text, /bad � char/);
  assert.equal(withCacheControl('', []).system, undefined);
});

test('529 is retried with backoff and surfaced as retry events', async () => {
  const { model, sleeps } = mk([errRes(529, 'overloaded_error'), errRes(529, 'overloaded_error'), okStream(sse([{ type: 'text', text: 'ok' }]))]);
  const { events, message } = await collect(model(req));
  assert.deepEqual(events.filter((e) => e.type === 'retry').map((e) => e.kind), ['overloaded', 'overloaded']);
  assert.deepEqual(sleeps, [10, 20]);
  assert.equal(message.content[0].text, 'ok');
});

test('retry-after header wins over backoff; 429 is retryable', async () => {
  const { model, sleeps } = mk([errRes(429, 'rate_limit_error', { 'retry-after': '3' }), okStream(sse([{ type: 'text', text: 'ok' }]))]);
  await collect(model(req));
  assert.deepEqual(sleeps, [3000]);
});

test('repeated overload switches to fallback model', async () => {
  const { model, calls } = mk([errRes(529, 'overloaded_error'), errRes(529, 'overloaded_error'), okStream(sse([{ type: 'text', text: 'ok' }]))],
    { model: 'big', fallbackModel: 'small' });
  const { events } = await collect(model(req));
  assert.deepEqual(events.find((e) => e.type === 'model_fallback'), { type: 'model_fallback', from: 'big', to: 'small' });
  assert.deepEqual(calls.map((c) => c.model), ['big', 'big', 'small']);
});

test('non-retryable errors throw classified ModelError immediately', async () => {
  for (const [status, type, msg, kind] of [[401, 'authentication_error', 'x', 'auth'], [400, 'invalid_request_error', 'prompt is too long: 250000 tokens', 'prompt_too_long'], [400, 'invalid_request_error', 'bad field', 'invalid_request']]) {
    const body = JSON.stringify({ error: { type, message: msg } });
    const { model, calls } = mk([new Response(body, { status })]);
    await assert.rejects(collect(model(req)), (e) => e instanceof ModelError && e.kind === kind && !e.retryable);
    assert.equal(calls.length, 1);
  }
  assert.equal(classifyHttp(500, '{}', new Headers()).retryable, true);
});

test('stall: idle watchdog fires, retries, then falls back to non-streaming after two failures', async () => {
  const json = new Response(JSON.stringify({ content: [{ type: 'text', text: 'plain' }], stop_reason: 'end_turn', usage: {} }), { status: 200 });
  const { model, calls } = mk([stalling, stalling, json], { idleMs: 30 });
  const { events, message } = await collect(model(req));
  assert.deepEqual(calls.map((c) => c.stream), [true, true, false]);
  assert.ok(events.some((e) => e.type === 'warning' && /non-streaming/.test(e.message)));
  assert.equal(message.content[0].text, 'plain');
});

test('stream error event and truncated stream are retryable; abort is not retried', async () => {
  const truncated = okStream(ev('message_start', { message: {} }) + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
  const { model, calls } = mk([truncated, okStream(sse([{ type: 'text', text: 'ok' }]))]);
  const { events } = await collect(model(req));
  assert.equal(events.find((e) => e.type === 'retry').kind, 'stream_incomplete');
  assert.equal(calls.length, 2);

  const ac = new AbortController(); ac.abort(new Error('user abort'));
  const m2 = mk([() => { throw new Error('aborted'); }]).model;
  await assert.rejects(collect(m2({ ...req, signal: ac.signal })), /aborted/);
});
