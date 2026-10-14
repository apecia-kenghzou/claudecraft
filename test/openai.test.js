import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIModel, toOpenAIMessages, toOpenAITools } from '../src/model/openai.js';
import { ModelError } from '../src/model/anthropic.js';

const data = (o) => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (delta, finish = null, extra = {}) => data({ choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const sse = (...parts) => new Response(parts.join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers });
const stalling = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(chunk({ content: 'x' }))); } }), { status: 200 });

const mk = (responses, extra = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); const r = responses[Math.min(calls.length - 1, responses.length - 1)]; return typeof r === 'function' ? r() : r; };
  const sleeps = [];
  return { model: createOpenAIModel({ apiKey: 'k', baseURL: 'http://h:8317/v1', model: 'gpt-x', fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, baseDelayMs: 10, ...extra }), calls, sleeps };
};
async function collect(gen) { const ev = []; let s; while (!(s = await gen.next()).done) ev.push(s.value); return { ev, msg: s.value }; }
const req = { system: 'SYS', messages: [{ role: 'user', content: 'hi' }], tools: [] };

test('toOpenAIMessages: system, tool_use -> tool_calls, tool_result -> tool role, text after results, thinking dropped', () => {
  const out = toOpenAIMessages('SYS', [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'c1', name: 'Read', input: { p: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'file' }], is_error: false }, { type: 'text', text: 'extra context' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'only', signature: 's' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ]);
  assert.deepEqual(out, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"p":1}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file' },
    { role: 'user', content: 'extra context' },
    { role: 'assistant', content: 'done' },
  ]);
  assert.deepEqual(toOpenAITools([{ name: 'T', description: 'd', input_schema: { type: 'object' } }]),
    [{ type: 'function', function: { name: 'T', description: 'd', parameters: { type: 'object' } } }]);
});

test('endpoint URL is derived from the base URL in every common shape', async () => {
  for (const [base, want] of [['http://h:8317', 'http://h:8317/v1/chat/completions'], ['http://h:8317/v1', 'http://h:8317/v1/chat/completions'],
    ['http://h:8317/v1/', 'http://h:8317/v1/chat/completions'], ['https://x/api/v1/chat/completions', 'https://x/api/v1/chat/completions'], ['https://o/openai/v2', 'https://o/openai/v2/chat/completions']]) {
    const { model, calls } = mk([sse(chunk({ content: 'a' }, 'stop'))], { baseURL: base });
    await collect(model(req));
    assert.equal(calls[0].url, want);
    assert.equal(calls[0].headers.authorization, 'Bearer k');
  }
});

test('streaming: text deltas, tool calls assembled across chunks, usage with cache accounting, stop mapping', async () => {
  const body = sse(
    chunk({ content: 'Hel' }), chunk({ content: 'lo' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"file_' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'path":"a.js"}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'call_2', function: { name: 'Glob', arguments: '{"pattern":"*"}' } }] }),
    chunk({}, 'tool_calls'),
    data({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } } }),
  );
  const { model, calls } = mk([body]);
  const { ev, msg } = await collect(model({ ...req, tools: [{ name: 'Read', description: '', input_schema: {} }] }));
  assert.deepEqual(ev.filter((e) => e.type === 'text_delta').map((e) => e.text), ['Hel', 'lo']);
  assert.deepEqual(msg.content, [
    { type: 'text', text: 'Hello' },
    { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.js' } },
    { type: 'tool_use', id: 'call_2', name: 'Glob', input: { pattern: '*' } },
  ]);
  assert.equal(msg.stop_reason, 'tool_use');
  assert.deepEqual(msg.usage, { input_tokens: 200, cache_read_input_tokens: 800, output_tokens: 50 });
  const b = calls[0].body;
  assert.equal(b.stream, true);
  assert.deepEqual(b.stream_options, { include_usage: true });
  assert.equal(b.max_completion_tokens, 8192);
  assert.equal(b.messages[0].role, 'system');
  assert.equal(b.tools[0].type, 'function');
});

test('finish reasons: length -> max_tokens; stop with tool calls -> tool_use; malformed args dropped and counted', async () => {
  const len = await collect(mk([sse(chunk({ content: 'cut' }, 'length'))]).model(req));
  assert.equal(len.msg.stop_reason, 'max_tokens');
  const proxy = await collect(mk([sse(chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'T', arguments: '{}' } }] }, 'stop'))]).model(req));
  assert.equal(proxy.msg.stop_reason, 'tool_use');
  const bad = await collect(mk([sse(chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'T', arguments: '{"x":' } }] }, 'tool_calls'))]).model(req));
  assert.deepEqual(bad.msg.content, []);
  assert.equal(bad.msg.malformed, 1);
});

test('non-streaming responses are parsed too (and used after two stream stalls)', async () => {
  const plain = json({ choices: [{ message: { content: 'plain', tool_calls: [{ id: 't', function: { name: 'X', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  const { model, calls } = mk([stalling, stalling, plain], { idleMs: 30 });
  const { ev, msg } = await collect(model(req));
  assert.deepEqual(calls.map((c) => c.body.stream), [true, true, false]);
  assert.ok(ev.some((e) => e.type === 'warning' && /non-streaming/.test(e.message)));
  assert.deepEqual(msg.content, [{ type: 'text', text: 'plain' }, { type: 'tool_use', id: 't', name: 'X', input: { a: 1 } }]);
  assert.equal(msg.stop_reason, 'tool_use');
});

test('errors: 429/529 retried with retry-after, auth and bad request are not, overload falls back to another model', async () => {
  const ok = () => sse(chunk({ content: 'ok' }, 'stop'));
  const a = mk([json({ error: { message: 'slow down' } }, 429, { 'retry-after': '2' }), ok()]);
  await collect(a.model(req));
  assert.deepEqual(a.sleeps, [2000]);

  const auth = mk([json({ error: { message: 'bad key', type: 'invalid_api_key' } }, 401)]);
  await assert.rejects(collect(auth.model(req)), (e) => e instanceof ModelError && e.kind === 'auth' && !e.retryable);
  assert.equal(auth.calls.length, 1);

  const long = mk([json({ error: { message: "This model's maximum context length is 128000 tokens" } }, 400)]);
  await assert.rejects(collect(long.model(req)), (e) => e.kind === 'prompt_too_long');

  const fb = mk([json({ error: { message: 'busy' } }, 529), json({ error: { message: 'busy' } }, 529), ok()], { model: 'big', fallbackModel: 'small' });
  const { ev } = await collect(fb.model(req));
  assert.ok(ev.some((e) => e.type === 'model_fallback'));
  assert.deepEqual(fb.calls.map((c) => c.body.model), ['big', 'big', 'small']);
});

test('missing key fails fast with a clear message', () => {
  const save = { a: process.env.OPENAI_API_KEY, b: process.env.REA_API_KEY };
  delete process.env.OPENAI_API_KEY; delete process.env.REA_API_KEY;
  try { assert.throws(() => createOpenAIModel({}), /no API key/); } finally { for (const [k, v] of [['OPENAI_API_KEY', save.a], ['REA_API_KEY', save.b]]) if (v !== undefined) process.env[k] = v; }
});
