// Anthropic Messages API client: SSE streaming with an idle watchdog, classified errors, retry with backoff,
// model fallback on repeated overload, and fallback from streaming to non-streaming.
// The call is an async generator: it yields UI events and *returns* the assembled assistant message.
// Behaviours mirror the categories found in the bundle's model-call layer (ARCHITECTURE.md §3), written from scratch.

export class ModelError extends Error {
  /** kind: auth | invalid_request | prompt_too_long | rate_limit | overloaded | server | network | stream_stall | stream_incomplete | stream_error */
  constructor(kind, message, { status, retryAfterMs, retryable = false } = {}) {
    super(message);
    Object.assign(this, { name: 'ModelError', kind, status, retryAfterMs, retryable });
  }
}

const TOO_LONG = /prompt is too long|context (window|length)|too many tokens|exceeds? the (maximum|context)/i;

export function classifyHttp(status, bodyText, headers) {
  let msg = bodyText.slice(0, 500);
  let type = '';
  try { const j = JSON.parse(bodyText); type = j.error?.type ?? ''; msg = j.error?.message ?? msg; } catch { /* keep raw */ }
  const ra = Number(headers?.get?.('retry-after'));
  const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
  const text = `Anthropic API ${status}${type ? ` ${type}` : ''}: ${msg}`;
  if (status === 401 || status === 403) return new ModelError('auth', text, { status });
  if (status === 413 || (status === 400 && TOO_LONG.test(msg))) return new ModelError('prompt_too_long', text, { status });
  if (status === 429) return new ModelError('rate_limit', text, { status, retryAfterMs, retryable: true });
  if (status === 529 || type === 'overloaded_error') return new ModelError('overloaded', text, { status, retryAfterMs, retryable: true });
  if (status >= 500) return new ModelError('server', text, { status, retryAfterMs, retryable: true });
  return new ModelError('invalid_request', text, { status });
}

// Lone UTF-16 surrogates make the API reject the body.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const sanitize = (_k, v) => (typeof v === 'string' ? v.replace(LONE, '�') : v);

// The API rejects unknown fields; the harness adds `remedy`/`denial` to tool_results for its own use.
export function toApiMessages(messages) {
  return messages.map((m) => (typeof m.content === 'string' ? { role: m.role, content: m.content } : {
    role: m.role,
    content: m.content.map((b) => (b.type === 'tool_result'
      ? { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, ...(b.is_error ? { is_error: true } : {}) }
      : b)),
  }));
}

/** Put one ephemeral cache breakpoint on the system prompt and one on the last message block. */
export function withCacheControl(system, messages) {
  const sys = system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined;
  const out = messages.map((m) => ({ ...m }));
  const last = out.at(-1);
  if (last) {
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map((b) => ({ ...b }));
    if (blocks.length) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
    last.content = blocks;
  }
  return { system: sys, messages: out };
}

export async function* parseSSE(body, { idleMs, onIdle }) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      let timer;
      const idle = new Promise((_, rej) => {
        timer = setTimeout(() => { onIdle?.(); rej(new ModelError('stream_stall', `no data for ${idleMs}ms`, { retryable: true })); }, idleMs);
      });
      let chunk;
      try { chunk = await Promise.race([reader.read(), idle]); } finally { clearTimeout(timer); }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        let event = 'message'; const data = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length) {
          try { yield { event, data: JSON.parse(data.join('\n')) }; } catch (e) {
            if (e instanceof SyntaxError) throw new ModelError('stream_error', 'malformed SSE data', { retryable: true });
            throw e;
          }
        }
      }
    }
  } finally { reader.cancel().catch(() => {}); }
}

function assembleError(data) {
  const t = data?.error?.type ?? 'error';
  const msg = `Anthropic stream error ${t}: ${data?.error?.message ?? ''}`;
  if (t === 'overloaded_error') return new ModelError('overloaded', msg, { retryable: true });
  if (t === 'rate_limit_error') return new ModelError('rate_limit', msg, { retryable: true });
  if (t === 'api_error') return new ModelError('server', msg, { retryable: true });
  return new ModelError('stream_error', msg, { retryable: false });
}

async function* streamMessage({ fetchImpl, url, headers, body, signal, idleMs }) {
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

    const blocks = [];
    let stop_reason = null, usage = {}, model, started = false, stopped = false;
    for await (const { event, data } of parseSSE(res.body, { idleMs, onIdle: () => ac.abort() })) {
      if (event === 'error') throw assembleError(data);
      if (event === 'message_start') { started = true; usage = { ...data.message?.usage }; model = data.message?.model; }
      else if (event === 'content_block_start') {
        const b = { ...data.content_block };
        if (b.type === 'text') b.text = b.text ?? '';
        if (b.type === 'tool_use') { b._json = ''; b.input = {}; }
        if (b.type === 'thinking') { b.thinking = b.thinking ?? ''; b.signature = b.signature ?? ''; }
        blocks[data.index] = b;
        if (b.type === 'tool_use') yield { type: 'tool_use_start', id: b.id, name: b.name };
      } else if (event === 'content_block_delta') {
        const b = blocks[data.index]; const d = data.delta;
        if (!b) continue;
        if (d.type === 'text_delta') { b.text += d.text; yield { type: 'text_delta', text: d.text }; }
        else if (d.type === 'input_json_delta') b._json += d.partial_json;
        else if (d.type === 'thinking_delta') { b.thinking += d.thinking; yield { type: 'thinking_delta', text: d.thinking }; }
        else if (d.type === 'signature_delta') b.signature = d.signature;
      } else if (event === 'content_block_stop') {
        const b = blocks[data.index];
        if (b?.type === 'tool_use') {
          try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b._invalid = true; }
        }
      } else if (event === 'message_delta') {
        if (data.delta?.stop_reason) stop_reason = data.delta.stop_reason;
        usage = { ...usage, ...data.usage };
      } else if (event === 'message_stop') stopped = true;
    }
    if (!started || (!stopped && !stop_reason)) throw new ModelError('stream_incomplete', 'stream ended before message_stop', { retryable: true });
    const done = blocks.filter(Boolean);
    const malformed = done.filter((b) => b._invalid).length;
    const content = done.filter((b) => !b._invalid).map(({ _json, ...b }) => b);
    return { content, stop_reason, usage, model, malformed };
  } finally { signal?.removeEventListener('abort', onAbort); }
}

async function nonStreamMessage({ fetchImpl, url, headers, body, signal }) {
  let res;
  try { res = await fetchImpl(url, { method: 'POST', headers, body, signal }); } catch (e) {
    if (signal?.aborted) throw e;
    throw new ModelError('network', `network error: ${e.message}`, { retryable: true });
  }
  if (!res.ok) throw classifyHttp(res.status, await res.text(), res.headers);
  const j = await res.json();
  return { content: j.content, stop_reason: j.stop_reason, usage: j.usage, model: j.model, malformed: 0 };
}

const sleepAbortable = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

export function createAnthropicModel({
  apiKey = process.env.ANTHROPIC_API_KEY,
  baseURL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  model = 'claude-sonnet-5-5', fallbackModel, maxTokens = 8192, stream = true, cache = true,
  maxRetries = Number(process.env.REA_MAX_RETRIES ?? 4),
  idleMs = Number(process.env.REA_STREAM_IDLE_MS ?? 60000),
  baseDelayMs = 500, sleep = sleepAbortable, fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  let current = model;
  const url = `${baseURL}/v1/messages`;
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };

  async function* call({ system, messages, tools, signal }) {
    let active = current, streaming = stream, overloaded = 0, streamFailures = 0, useCache = cache;
    for (let attempt = 0; ; attempt++) {
      const api = toApiMessages(messages);
      const cached = useCache ? withCacheControl(system, api) : { system, messages: api };
      const body = JSON.stringify({
        model: active, max_tokens: maxTokens, stream: streaming, system: cached.system, messages: cached.messages,
        ...(tools?.length ? { tools } : {}),
      }, sanitize);
      try {
        const args = { fetchImpl, url, headers, body, signal };
        if (streaming) return yield* streamMessage({ ...args, idleMs });
        return await nonStreamMessage(args);
      } catch (e) {
        // A proxy or older API that rejects cache markers: resend without them.
        if (e instanceof ModelError && e.kind === 'invalid_request' && useCache && /cache_control/i.test(e.message) && !signal?.aborted) {
          useCache = false;
          yield { type: 'warning', message: 'server rejected cache_control; retrying without prompt-cache markers' };
          continue;
        }
        if (signal?.aborted || !(e instanceof ModelError) || !e.retryable || attempt >= maxRetries) throw e;
        if (e.kind === 'overloaded' && ++overloaded >= 2 && fallbackModel && active !== fallbackModel) {
          yield { type: 'model_fallback', from: active, to: fallbackModel };
          active = fallbackModel;
        }
        if (['stream_stall', 'network', 'stream_incomplete', 'stream_error'].includes(e.kind) && streaming && ++streamFailures >= 2) {
          streaming = false;
          yield { type: 'warning', message: 'streaming failed twice; falling back to non-streaming' };
        }
        const delayMs = e.retryAfterMs ?? Math.min(baseDelayMs * 2 ** attempt, 8000);
        yield { type: 'retry', attempt: attempt + 1, kind: e.kind, delayMs, message: e.message };
        await sleep(delayMs, signal);
      }
    }
  }
  call.modelName = model;
  call.setModel = (m) => { current = m; call.modelName = m; };
  return call;
}
