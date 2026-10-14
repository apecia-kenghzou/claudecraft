// Backend that drives the real `claude` CLI in print mode (stream-json), so your subscription is used by the
// client it was issued to. rea never reads or forwards any Claude credentials; the child process handles auth.
//
// Trade-off: Claude Code runs its OWN loop and tools here, so this is a reference/comparison backend, not a way
// to exercise rea's own loop. Yields rea-style events and returns a terminal `{reason, text, turns, costUsd}`.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const claudeBin = () => process.env.REA_CLAUDE_BIN || 'claude';

/** Build argv for one print-mode run. Exported for tests. */
export function buildArgs({ model, permissionMode, allowedTools, disallowedTools, sessionId, resume, appendSystemPrompt, persist = true }) {
  const a = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (model) a.push('--model', model);
  if (permissionMode && permissionMode !== 'default') a.push('--permission-mode', permissionMode);
  if (allowedTools?.length) a.push('--allowedTools', ...allowedTools);
  if (disallowedTools?.length) a.push('--disallowedTools', ...disallowedTools);
  if (appendSystemPrompt) a.push('--append-system-prompt', appendSystemPrompt);
  if (resume) a.push('--resume', resume);
  else if (sessionId) a.push('--session-id', sessionId);
  if (!persist) a.push('--no-session-persistence');
  return a;
}

/** Map one stream-json line to zero or more rea events; returns a terminal when the final result arrives. */
export function mapEvent(obj) {
  const events = [];
  if (obj.type === 'system' && obj.subtype === 'init') {
    events.push({ type: 'init', sessionId: obj.session_id, model: obj.model, tools: obj.tools });
  } else if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
    events.push({ type: 'assistant', content: obj.message.content, usage: obj.message.usage });
  } else if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
    for (const b of obj.message.content) {
      if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        events.push({ type: 'tool_result', result: { type: 'tool_result', tool_use_id: b.tool_use_id, content, is_error: !!b.is_error } });
      }
    }
  } else if (obj.type === 'result') {
    return { events, terminal: {
      reason: obj.is_error ? (obj.subtype === 'error_max_turns' ? 'max_turns' : 'model_error') : 'completed',
      text: typeof obj.result === 'string' ? obj.result : '', turns: obj.num_turns ?? 0, costUsd: obj.total_cost_usd,
      durationMs: obj.duration_ms, usage: obj.usage, sessionId: obj.session_id, subtype: obj.subtype,
    } };
  }
  return { events };
}

export async function* runClaudeCli({ prompt, cwd = process.cwd(), signal, bin = claudeBin(), env = process.env, ...opts }) {
  const child = spawn(bin, buildArgs(opts), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], signal });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  const exited = new Promise((resolve) => {
    child.on('error', (e) => resolve({ code: -1, error: e }));
    child.on('close', (code) => resolve({ code }));
  });

  let terminal, buf = '';
  const lines = (async function* () {
    for await (const chunk of child.stdout) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); }
    }
    if (buf.trim()) yield buf;
  })();

  for await (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }        // ignore non-JSON noise
    const m = mapEvent(obj);
    for (const e of m.events) yield e;
    if (m.terminal) terminal = m.terminal;
  }
  const { code, error } = await exited;
  if (signal?.aborted) return { reason: 'aborted_streaming', text: '', turns: 0 };
  if (error) {
    const hint = error.code === 'ENOENT' ? ` ("${bin}" not found; set REA_CLAUDE_BIN)` : '';
    yield { type: 'error', error: new Error(`could not start claude${hint}: ${error.message}`) };
    return { reason: 'model_error', text: '', turns: 0 };
  }
  if (!terminal) {
    yield { type: 'error', error: new Error(`claude exited ${code} without a result${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`) };
    return { reason: 'model_error', text: '', turns: 0 };
  }
  return terminal;
}

/** Compact, diffable summary of a run: the ordered tool calls plus the outcome. */
export function summarizeTrace(events, terminal) {
  const calls = [];
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    for (const b of e.content) if (b.type === 'tool_use') calls.push({ tool: b.name, keys: Object.keys(b.input ?? {}).sort() });
  }
  return { toolCalls: calls, reason: terminal.reason, turns: terminal.turns, costUsd: terminal.costUsd, text: terminal.text };
}

export const newSessionId = () => randomUUID();
