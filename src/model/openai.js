// OpenAI-compatible provider (chat.completions): works with OpenAI, proxies, OpenRouter, Ollama, LM Studio, vLLM...
// Same contract as the Anthropic client: an async generator that yields UI events and RETURNS an
// Anthropic-shaped assistant message { content, stop_reason, usage }, so the harness needs no changes.
import { ModelError, classifyHttp } from './anthropic.js';

const sleepAbortable = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

const textOf = (c) => (typeof c === 'string' ? c : (c ?? []).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n'));

/** Anthropic-shaped history -> OpenAI chat messages. Tool results become role:'tool' messages right after the call. */
export function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (!text && !calls.length) continue;                        // thinking-only turns carry nothing portable
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: textOf(b.content) });
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

export const toOpenAITools = (tools) => (tools ?? []).map((t) => ({
  type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } },
}));

const STOP = { stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

/**
 * When a server rejects an optional parameter, resend without it (once per rule). Many OpenAI-compatible servers (proxies,
 * llama.cpp, older vLLM) do not know `stream_options` or `max_completion_tokens`.
 */
export const STRIP_RULES = [
  { name: 'stream_options', what: 'stream_options', test: /stream_options|include_usage/i },
  { name: 'max_completion_tokens', what: 'max_completion_tokens (using max_tokens)', test: /max_completion_tokens/i },
];

function usageOf(u) {
  if (!u) return {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return { input_tokens: (u.prompt_tokens ?? 0) - cached, cache_read_input_tokens: cached, output_tokens: u.completion_tokens ?? 0 };
}

function buildMessage({ text, calls, finish, usage }) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  let malformed = 0;
  for (const c of [...calls.values()]) {
    if (!c.name) { malformed++; continue; }
    try { content.push({ type: 'tool_use', id: c.id || `call_${content.length}`, name: c.name, input: c.args ? JSON.parse(c.args) : {} }); }
    catch { malformed++; }
  }
  let stop_reason = STOP[finish] ?? 'end_turn';
  if (calls.size && stop_reason === 'end_turn') stop_reason = 'tool_use';   // some proxies report "stop" with tool calls
  return { content, stop_reason, usage: usageOf(usage), malformed };
}

async function* readSSE(body, { idleMs, onIdle }) {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = '';
  try {
    for (;;) {
      let timer;
      const idle = new Promise((_, rej) => { timer = setTimeout(() => { onIdle?.(); rej(new ModelError('stream_stall', `no data for ${idleMs}ms`, { retryable: true })); }, idleMs); });
      let chunk;
      try { chunk = await Promise.race([reader.read(), idle]); } finally { clearTimeout(timer); }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          try { yield JSON.parse(data); } catch { throw new ModelError('stream_error', 'malformed SSE data', { retryable: true }); }
        }
      }
    }
  } finally { reader.cancel().catch(() => {}); }
}

async function* streamChat({ fetchImpl, url, headers, body, signal, idleMs }) {
  const ac = new AbortController();
  const onAbort = () => ac.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res;
    try { res = await fetchImpl(url, { method: 'POST', headers, body, signal: ac.signal }); } catch (e) {
      if (signal?.aborted) throw e;
      throw new ModelError('network', `network error: ${e.message}`, { retryable: true });
    }
    if (!res.ok) throw classifyHttp(res.status, await res.text(), res.headers);
    let text = '', finish = null, usage = null, sawChunk = false;
    const calls = new Map();
    for await (const chunk of readSSE(res.body, { idleMs, onIdle: () => ac.abort() })) {
      sawChunk = true;
      if (chunk.error) throw new ModelError('stream_error', `stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`, { retryable: false });
      if (chunk.usage) usage = chunk.usage;
      const ch = chunk.choices?.[0];
      if (!ch) continue;
      const d = ch.delta ?? {};
      if (typeof d.content === 'string' && d.content) { text += d.content; yield { type: 'text_delta', text: d.content }; }
      if (d.reasoning_content) yield { type: 'thinking_delta', text: d.reasoning_content };
      for (const tc of d.tool_calls ?? []) {
        const cur = calls.get(tc.index ?? 0) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        if (!calls.has(tc.index ?? 0)) { calls.set(tc.index ?? 0, cur); yield { type: 'tool_use_start', id: cur.id, name: cur.name }; }
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
    if (!sawChunk || (!finish && !text && !calls.size)) throw new ModelError('stream_incomplete', 'stream ended without a result', { retryable: true });
    return buildMessage({ text, calls, finish, usage });
  } finally { signal?.removeEventListener('abort', onAbort); }
}

async function plainChat({ fetchImpl, url, headers, body, signal }) {
  let res;
  try { res = await fetchImpl(url, { method: 'POST', headers, body, signal }); } catch (e) {
    if (signal?.aborted) throw e;
    throw new ModelError('network', `network error: ${e.message}`, { retryable: true });
  }
  if (!res.ok) throw classifyHttp(res.status, await res.text(), res.headers);
  const j = await res.json();
  const ch = j.choices?.[0];
  if (!ch) throw new ModelError('invalid_request', `response had no choices: ${JSON.stringify(j).slice(0, 200)}`);
  const calls = new Map((ch.message?.tool_calls ?? []).map((tc, i) => [i, { id: tc.id, name: tc.function?.name, args: tc.function?.arguments }]));
  return buildMessage({ text: ch.message?.content ?? '', calls, finish: ch.finish_reason, usage: j.usage });
}

export function createOpenAIModel({
  apiKey = process.env.OPENAI_API_KEY ?? process.env.REA_API_KEY,
  baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  model = process.env.OPENAI_MODEL || 'gpt-5.5', fallbackModel, maxTokens = 8192, stream = true,
  maxRetries = Number(process.env.REA_MAX_RETRIES ?? 4), idleMs = Number(process.env.REA_STREAM_IDLE_MS ?? 90000),
  baseDelayMs = 500, sleep = sleepAbortable, fetchImpl = globalThis.fetch, extraBody = {},
} = {}) {
  if (!apiKey) throw new Error('no API key: set OPENAI_API_KEY (or REA_API_KEY)');
  let current = model;
  const root = baseURL.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(root) ? root : `${root}${/\/v\d+$/.test(root) ? '' : '/v1'}/chat/completions`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };

  async function* call({ system, messages, tools, signal }) {
    let active = current, streaming = stream, overloaded = 0, streamFailures = 0;
    const stripped = new Set();
    for (let attempt = 0; ; attempt++) {
      const toolDefs = toOpenAITools(tools);
      const body = JSON.stringify({
        model: active, messages: toOpenAIMessages(system, messages),
        [stripped.has('max_completion_tokens') ? 'max_tokens' : 'max_completion_tokens']: maxTokens, stream: streaming,
        ...(streaming && !stripped.has('stream_options') ? { stream_options: { include_usage: true } } : {}),
        ...(toolDefs.length ? { tools: toolDefs } : {}), ...extraBody,
      });
      try {
        const args = { fetchImpl, url, headers, body, signal };
        if (streaming) return yield* streamChat({ ...args, idleMs });
        return await plainChat(args);
      } catch (e) {
        if (e instanceof ModelError && e.kind === 'invalid_request' && !signal?.aborted) {
          const rule = STRIP_RULES.find((r) => !stripped.has(r.name) && r.test.test(e.message));
          if (rule) { stripped.add(rule.name); yield { type: 'warning', message: `server rejected ${rule.what}; retrying without it` }; continue; }
        }
        if (signal?.aborted || !(e instanceof ModelError) || !e.retryable || attempt >= maxRetries) throw e;
        if (e.kind === 'overloaded' && ++overloaded >= 2 && fallbackModel && active !== fallbackModel) {
          yield { type: 'model_fallback', from: active, to: fallbackModel }; active = fallbackModel;
        }
        if (['stream_stall', 'network', 'stream_incomplete', 'stream_error'].includes(e.kind) && streaming && ++streamFailures >= 2) {
          streaming = false; yield { type: 'warning', message: 'streaming failed twice; falling back to non-streaming' };
        }
        const delayMs = e.retryAfterMs ?? Math.min(baseDelayMs * 2 ** attempt, 8000);
        yield { type: 'retry', attempt: attempt + 1, kind: e.kind, delayMs, message: e.message };
        await sleep(delayMs, signal);
      }
    }
  }
  call.modelName = model;
  call.setModel = (m) => { current = m; call.modelName = m; };
  call.provider = 'openai';
  return call;
}
