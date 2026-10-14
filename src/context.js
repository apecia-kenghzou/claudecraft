// Context management: token accounting, compaction thresholds, a rapid-refill circuit breaker, and the
// summarization step. Numbers and structure follow behaviour read from the bundle (EVIDENCE.md §7);
// the prompt text and code are original.

// ---- thresholds -------------------------------------------------------------------------------------------
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const RESERVED_OUTPUT_CAP = 20_000;   // room kept free for the model's reply (min(maxOutputTokens, cap))
export const HARD_RESERVE = 13_000;          // compaction never waits closer than this to the window
export const BLOCK_MARGIN = 3_000;           // within this of the window: refuse to call the model
export const WARN_MARGIN = 20_000;           // warn this far before the compaction threshold
export const DEFAULT_BUFFER_FRACTION = 0.2;  // compact when 20% of the window is left
export const RAPID_REFILL_TURNS = 3;
export const RAPID_REFILL_LIMIT = 3;
export const MIN_SUMMARIZE_TOKENS = 1500;    // below this, summarizing costs more than it frees
export const MIN_COMPACT_GAIN = 500;         // a compaction must free at least this much or it is reverted
export const MIN_HEADROOM = 4000;            // conversation room kept above the fixed overhead (system + tools + memory)

export const effectiveWindow = (contextWindow, maxOutputTokens = 8192) =>
  contextWindow - Math.min(maxOutputTokens, RESERVED_OUTPUT_CAP);

export function compactThreshold(window, { bufferFraction = DEFAULT_BUFFER_FRACTION, pctOverride } = {}) {
  const hard = window - HARD_RESERVE;
  const capped = pctOverride > 0 && pctOverride <= 100 ? Math.min(Math.floor(window * (pctOverride / 100)), hard) : hard;
  return Math.min(window - Math.round(window * bufferFraction), capped);
}

/** ok < warn < compact < blocked */
export function contextLevel(tokens, window, { enabled = true, threshold } = {}) {
  const t = threshold ?? compactThreshold(window);
  const base = enabled ? t : window;
  const pctLeft = Math.max(0, Math.round(((base - tokens) / base) * 100));
  if (tokens >= window - BLOCK_MARGIN) return { level: 'blocked', pctLeft };
  if (enabled && tokens >= t) return { level: 'compact', pctLeft };
  if (tokens >= base - WARN_MARGIN) return { level: 'warn', pctLeft };
  return { level: 'ok', pctLeft };
}

/** Compaction right after a compaction means something huge keeps refilling the window. */
export function nextRefillState(prev) {
  const n = prev?.compacted && prev.turnCounter < RAPID_REFILL_TURNS ? (prev.consecutiveRapidRefills ?? 0) + 1 : 0;
  return { action: n >= RAPID_REFILL_LIMIT ? 'trip' : 'proceed', consecutiveRapidRefills: n };
}

// ---- token estimation ---------------------------------------------------------------------------------------
const CHARS_PER_TOKEN = 4;
export function estimateTokens(x) {
  if (x == null) return 0;
  if (typeof x === 'string') return Math.ceil(x.length / CHARS_PER_TOKEN);
  if (Array.isArray(x)) return x.reduce((n, v) => n + estimateTokens(v), 0);
  if (typeof x === 'object') {
    if (x.type === 'text') return estimateTokens(x.text) + 2;
    if (x.type === 'tool_use') return estimateTokens(x.name) + estimateTokens(JSON.stringify(x.input ?? {})) + 8;
    if (x.type === 'tool_result') return estimateTokens(x.content) + 8;
    if (x.type === 'thinking') return estimateTokens(x.thinking) + 4;
    return Math.ceil(JSON.stringify(x).length / CHARS_PER_TOKEN);
  }
  return 1;
}
export const estimateMessages = (messages) => messages.reduce((n, m) => n + 4 + estimateTokens(m.content), 0);
export const usageTokens = (u) => (u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0) : 0);

// ---- compaction ---------------------------------------------------------------------------------------------
const isPlainUser = (m) => m.role === 'user' && !m.isFileAttachment && (typeof m.content === 'string' || m.content.every((b) => b.type !== 'tool_result'));
/** Indices where history can be cut without separating a tool_use from its tool_result. */
export const safeBoundaries = (messages) => messages.flatMap((m, i) => (isPlainUser(m) ? [i] : []));

export function buildCompactionPrompt(instructions) {
  return [
    'Write a continuation summary of this coding session so the work can resume with no other context.',
    'First think in <analysis> tags (scratch space, discarded). Then give the final summary in <summary> tags with these sections:',
    '1. Request and intent: what the user asked for, and any change of direction',
    '2. Technical context: languages, frameworks, designs and decisions that matter',
    '3. Files: each file read, changed or created, why it matters, and key snippets',
    '4. Errors and fixes: what failed, how it was resolved, and any user corrections',
    '5. Problem solving: what is solved and what is still being investigated',
    '6. User messages: every user message that is not a tool result, keeping constraints and instructions verbatim',
    '7. Pending tasks: work explicitly requested and not yet done',
    '8. Current work: exactly what was in progress right before this summary, with file names',
    '9. Next step: only if it follows directly from the latest request; quote the latest messages to avoid drift',
    'Be precise and complete; prefer exact names, paths and numbers over paraphrase.',
    instructions ? `\nAdditional instructions from the user:\n${instructions}` : '',
  ].join('\n');
}

/** Take the <summary> body; fall back to the raw text minus any <analysis> block. */
export function extractSummary(raw) {
  const m = /<summary>([\s\S]*?)(?:<\/summary>|$)/.exec(raw);
  const body = m ? m[1] : raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, '');
  return body.trim();
}

/**
 * Prompts and task state are deterministic, so they are carried verbatim instead of trusting repeated summarization
 * (summaries of summaries drift: after several compactions a model conflated early requests with later ones).
 */
export function formatUserMessages(list, { maxEach = 400, keepFirst = 3, keepLast = 25, maxChars = 12000 } = {}) {
  if (!list.length) return '';
  const clip = (t) => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > maxEach ? `${x.slice(0, maxEach)}…` : x; };
  let idx = list.map((t, i) => ({ t, n: i + 1 }));
  if (idx.length > keepFirst + keepLast) {
    const hidden = idx.length - keepFirst - keepLast;
    idx = [...idx.slice(0, keepFirst), { t: `[${hidden} messages omitted]`, n: null }, ...idx.slice(-keepLast)];
  }
  let out = idx.map((x) => (x.n ? `${x.n}. ${clip(x.t)}` : x.t)).join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n[truncated]`;
  return out;
}

export function wrapSummary(summary, { userMessages = [], extra = '' } = {}) {
  const um = formatUserMessages(userMessages);
  return `This session continues from earlier work that was compacted to save context. The summary below replaces the earlier messages; treat it as the history and continue from it.

<summary>
${summary}
</summary>${um ? `\n\n<user-messages>\nEvery request the user has sent so far, in order, verbatim (long ones clipped):\n${um}\n</user-messages>` : ''}${extra ? `\n\n<session-state>\n${extra}\n</session-state>` : ''}`;
}

/** Recover the verbatim user-message list from a summary produced by wrapSummary (used when resuming a session). */
export function parseUserMessages(content) {
  const m = /<user-messages>\n[^\n]*\n([\s\S]*?)\n<\/user-messages>/.exec(content ?? '');
  if (!m) return [];
  return m[1].split('\n').map((l) => /^\d+\.\s+(.*)$/.exec(l)?.[1]).filter(Boolean);
}

function truncateToolResults(messages, max = 8000) {
  return messages.map((m) => (typeof m.content === 'string' ? { role: m.role, content: m.content } : {
    role: m.role,
    content: m.content.map((b) => (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > max
      ? { ...b, content: `${b.content.slice(0, max)}\n[truncated for summarization]` } : b)),
  }));
}

/**
 * Summarize the older part of `messages` and return the replacement history.
 * @param {object} o
 * @param {object[]} o.messages
 * @param {(req:object)=>Promise<{content:object[],stop_reason?:string}>} o.callModel
 * @param {number} [o.keepBudget] max estimated tokens of recent turn to keep verbatim (0 = keep nothing)
 */
export async function compactMessages({ messages, callModel, instructions, signal, keepBudget = 20_000, maxShrinkRetries = 3, userMessages = [], extra = '' }) {
  const preTokens = estimateMessages(messages);
  const bounds = safeBoundaries(messages);
  const last = bounds.at(-1) ?? 0;
  // Keep the latest user turn verbatim only if it is small and something older exists to summarize.
  const keepFrom = last > 0 && estimateMessages(messages.slice(last)) <= keepBudget ? last : messages.length;
  let toSummarize = messages.slice(0, keepFrom);
  if (toSummarize.length === 0) throw Object.assign(new Error('nothing to compact'), { kind: 'not_worth_it' });
  if (estimateMessages(toSummarize) < MIN_SUMMARIZE_TOKENS) {
    throw Object.assign(new Error(`only ~${estimateMessages(toSummarize)} tokens could be summarized; not worth a compaction`), { kind: 'not_worth_it' });
  }

  let dropped = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = await callModel({
        system: 'You write precise continuation summaries of coding-agent sessions.',
        messages: [...truncateToolResults(toSummarize), { role: 'user', content: buildCompactionPrompt(instructions) }],
        tools: [], signal,
      });
      const raw = reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const summary = extractSummary(raw);
      if (!summary) throw new Error('compaction produced an empty summary');
      const kept = messages.slice(keepFrom);
      const out = [{ role: 'user', content: wrapSummary(summary, { userMessages, extra }), isCompactSummary: true }, ...kept];
      return { messages: out, summary, preTokens, postTokens: estimateMessages(out), summarized: toSummarize.length, kept: kept.length, dropped };
    } catch (err) {
      // The summarization request itself can be too long: drop the oldest chunk and try again.
      if (err.kind !== 'prompt_too_long' || attempt >= maxShrinkRetries) throw err;
      const b = safeBoundaries(toSummarize).find((i) => i >= Math.ceil(toSummarize.length * 0.2));
      if (b === undefined) throw err;
      dropped += b;
      toSummarize = toSummarize.slice(b);
    }
  }
}


// ---- micro-compaction: clear old, large tool results without a model call ------------------------------------
export const CLEARED_MARKER = '[Old tool result content cleared]';
const COMPACTABLE = (name) => ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'ListMcpResources', 'ReadMcpResource'].includes(name) || name.startsWith('mcp__');

/**
 * Replace the content of old tool results (not the calls) with a marker. The most recent `keepRecent` results are untouched, and
 * only results of at least `minChars` are worth clearing. Mutates `messages`; returns what it did.
 */
export function microCompact(messages, { keepRecent = 4, minChars = 1500 } = {}) {
  const names = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);
  }
  const results = [];
  for (const m of messages) {
    if (m.role === 'user' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') results.push(b);
  }
  const candidates = results.slice(0, Math.max(0, results.length - keepRecent));
  let cleared = 0, freed = 0;
  for (const b of candidates) {
    if (typeof b.content !== 'string' || b.content === CLEARED_MARKER || b.content.length < minChars) continue;
    if (b.is_error || !COMPACTABLE(names.get(b.tool_use_id) ?? '')) continue;
    freed += estimateTokens(b.content) - estimateTokens(CLEARED_MARKER);
    b.content = CLEARED_MARKER;
    cleared++;
  }
  return { cleared, freedTokens: freed };
}

// ---- re-attach recently used files after a full compaction -------------------------------------------------------
/**
 * @param {string[]} paths most recently used first
 * @param {{read:(p:string)=>string|null, maxFiles?:number, perFileTokens?:number, totalTokens?:number}} o
 */
export function buildFileAttachments(paths, { read, maxFiles = 5, perFileTokens = 5000, totalTokens = 20000 }) {
  const parts = [], files = [];
  let used = 0;
  for (const p of paths) {
    if (files.length >= maxFiles || used >= totalTokens) break;
    let text;
    try { text = read(p); } catch { text = null; }
    if (text == null || text.includes('\u0000')) continue;
    const room = Math.min(perFileTokens, totalTokens - used) * 4;
    let body = text.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
    const truncated = body.length > room;
    if (truncated) body = `${body.slice(0, room)}\n[truncated: file continues; use Read with an offset]`;
    used += estimateTokens(body);
    files.push({ path: p, tokens: estimateTokens(body), truncated });
    parts.push(`<file path="${p}">\n${body}\n</file>`);
  }
  if (!parts.length) return { message: null, files: [], tokens: 0 };
  const content = `These are the files you were working with just before the conversation was compacted, re-read from disk now (current contents):\n\n${parts.join('\n\n')}`;
  return { message: { role: 'user', content, isFileAttachment: true }, files, tokens: estimateTokens(content) };
}
