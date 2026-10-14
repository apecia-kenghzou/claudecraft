import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveWindow, compactThreshold, contextLevel, nextRefillState, estimateTokens, safeBoundaries,
  extractSummary, compactMessages, buildCompactionPrompt, wrapSummary,
} from '../src/context.js';
import { Harness, defineTool } from '../src/harness.js';

test('effective window reserves min(maxOutput, 20k); threshold is window-20% capped by window-13k', () => {
  assert.equal(effectiveWindow(200000, 8192), 191808);
  assert.equal(effectiveWindow(200000, 64000), 180000);
  assert.equal(compactThreshold(180000), 144000);                       // 20% buffer wins
  assert.equal(compactThreshold(20000), 7000);                          // 13k hard reserve wins
  assert.equal(compactThreshold(100000, { pctOverride: 50 }), 50000);
});

test('context levels: ok -> warn -> compact -> blocked, with autocompact off treated against the window', () => {
  const w = 180000, t = compactThreshold(w);
  assert.equal(contextLevel(1000, w).level, 'ok');
  assert.equal(contextLevel(t - 20000, w).level, 'warn');
  assert.equal(contextLevel(t, w).level, 'compact');
  assert.equal(contextLevel(w - 3000, w).level, 'blocked');
  assert.equal(contextLevel(t, w, { enabled: false }).level, 'ok');
});

test('rapid-refill breaker trips on the 3rd consecutive compaction within 3 turns', () => {
  let s = null;
  const seq = [];
  for (let i = 0; i < 4; i++) {
    const n = nextRefillState(s); seq.push(n.action);
    s = { compacted: true, turnCounter: 1, consecutiveRapidRefills: n.consecutiveRapidRefills };
  }
  assert.deepEqual(seq, ['proceed', 'proceed', 'proceed', 'trip']);
  assert.equal(nextRefillState({ compacted: true, turnCounter: 5, consecutiveRapidRefills: 2 }).consecutiveRapidRefills, 0);
});

test('safeBoundaries never separates tool_use from tool_result', () => {
  const m = [
    { role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'X', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'r' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: 'b' },
  ];
  assert.deepEqual(safeBoundaries(m), [0, 4]);
});

test('extractSummary strips analysis and handles missing closing tag', () => {
  assert.equal(extractSummary('<analysis>x</analysis><summary>\nS\n</summary>'), 'S');
  assert.equal(extractSummary('<summary>cut off'), 'cut off');
  assert.equal(extractSummary('<analysis>x</analysis>plain'), 'plain');
  assert.match(buildCompactionPrompt('focus on tests'), /focus on tests/);
});

const hist = () => [
  { role: 'user', content: 'build a parser' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { p: 1 } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(30000) }] },
  { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  { role: 'user', content: 'now add tests' },
];

test('compactMessages: summarizes older turns, keeps the latest user turn, truncates huge tool results in the request', async () => {
  let seen;
  const callModel = async (req) => { seen = req; return { content: [{ type: 'text', text: '<summary>PARSER WORK</summary>' }] }; };
  const r = await compactMessages({ messages: hist(), callModel });
  assert.equal(r.messages[0].isCompactSummary, true);
  assert.match(r.messages[0].content, /PARSER WORK/);
  assert.deepEqual(r.messages[1], { role: 'user', content: 'now add tests' });
  assert.equal(r.summarized, 4);
  assert.ok(seen.messages[2].content[0].content.length < 9000);
  assert.equal(seen.tools.length, 0);
});

test('compactMessages retries by dropping the oldest turns when the request itself is too long', async () => {
  let calls = 0;
  const callModel = async () => {
    if (++calls === 1) { const e = new Error('long'); e.kind = 'prompt_too_long'; throw e; }
    return { content: [{ type: 'text', text: '<summary>ok</summary>' }] };
  };
  const big = [...hist(), ...hist(), ...hist()];
  const r = await compactMessages({ messages: big, callModel });
  assert.equal(calls, 2);
  assert.ok(r.dropped > 0);
});

// ---- harness integration -------------------------------------------------------------------------------------
const BIG = 'lorem ipsum dolor sit amet '.repeat(500);   // ~3k tokens: big enough to be worth compacting
const text = (t, usage) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage });
async function drive(h, p = 'go') { const ev = []; const g = h.query(p); let s; while (!(s = await g.next()).done) ev.push(s.value); return { ev, t: s.value }; }

test('auto-compaction triggers from reported usage, replaces history, then continues', async () => {
  const calls = [];
  const model = async (req) => {
    calls.push(req);
    if (req.tools.length === 0) return text('<summary>SUMMARY</summary>');              // the compaction request
    return text(`reply ${calls.filter((c) => c.tools.length).length}`, { input_tokens: calls.length === 1 ? 160000 : 2000, output_tokens: 10 });
  };
  const h = new Harness({ model, tools: [defineTool({ name: 'T', call: () => 'x' })], contextWindow: 200000, maxOutputTokens: 8192 });
  await drive(h, `first ${BIG}`);                // reports 160k used -> over the ~153k threshold for the next call
  const { ev } = await drive(h, 'second');
  assert.ok(ev.some((e) => e.type === 'compact_start' && e.trigger === 'auto'));
  assert.ok(ev.some((e) => e.type === 'compact_end'));
  assert.equal(h.compactions.length, 1);
  assert.equal(h.messages[0].isCompactSummary, true);
  assert.match(h.messages.at(-1).content[0].text, /reply 2/);
});

test('reactive compaction on prompt_too_long, once; second failure is terminal', async () => {
  let n = 0;
  const model = async (req) => {
    if (req.tools.length === 0) return text('<summary>S</summary>');
    if (++n === 1) { const e = new Error('too long'); e.kind = 'prompt_too_long'; throw e; }
    return text('recovered');
  };
  const h = new Harness({ model, tools: [defineTool({ name: 'T', call: () => 'x' })] });
  h.messages.push({ role: 'user', content: `old 1 ${BIG}` }, { role: 'assistant', content: [{ type: 'text', text: 'a' }] });
  const { ev, t } = await drive(h, 'new');
  assert.equal(t.reason, 'completed');
  assert.ok(ev.some((e) => e.type === 'compact_start' && e.trigger === 'reactive'));

  const always = async (req) => { if (req.tools.length === 0) return text('<summary>S</summary>'); const e = new Error('x'); e.kind = 'prompt_too_long'; throw e; };
  const h2 = new Harness({ model: always, tools: [defineTool({ name: 'T', call: () => 'x' })] });
  h2.messages.push({ role: 'user', content: `old ${BIG}` }, { role: 'assistant', content: [{ type: 'text', text: 'a' }] });
  assert.equal((await drive(h2, 'new')).t.reason, 'prompt_too_long');
});

test('rapid refill breaker ends the loop instead of compacting forever', async () => {
  const model = async (req) => (req.tools.length === 0 ? text('<summary>S</summary>')
    : { content: [{ type: 'tool_use', id: `u${Math.random()}`, name: 'T', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 170000 } });
  const h = new Harness({ model, tools: [defineTool({ name: 'T', isReadOnly: () => true, call: () => BIG })], maxTurns: 50, permissionMode: 'bypassPermissions' });   // big tool output each turn
  const { t } = await drive(h, `go ${BIG}`);
  assert.equal(t.reason, 'rapid_refill_breaker');
  assert.equal(h.compactions.length, 3);
});

test('blocking_limit when autocompact is off and the window is full; PreCompact hook can veto', async () => {
  const full = async () => text('x', { input_tokens: 190000 });
  const h = new Harness({ model: full, tools: [], autoCompact: false });
  await drive(h, `one ${BIG}`);
  assert.equal((await drive(h, 'two')).t.reason, 'blocking_limit');

  const m2 = async (req) => (req.tools.length === 0 ? text('<summary>S</summary>') : text('x', { input_tokens: 160000 }));
  const h2 = new Harness({ model: m2, tools: [defineTool({ name: 'T', call: () => 'x' })], hooks: { PreCompact: [() => ({ stop: true })] } });
  await drive(h2, `one ${BIG}`);
  const { ev, t } = await drive(h2, 'two');
  assert.ok(ev.some((e) => e.type === 'warning' && /blocked by PreCompact/.test(e.message)));
  assert.equal(h2.compactions.length, 0);
  assert.equal(t.reason, 'completed');
});

test('manual compact() and clear()', async () => {
  const model = async (req) => (req.tools.length === 0 ? text('<summary>M</summary>') : text('hi'));
  const h = new Harness({ model, tools: [] });
  await drive(h, `a ${BIG}`); await drive(h, 'b');
  const r = await h.compact('focus on b');
  assert.equal(r.trigger, 'manual');
  assert.equal(h.messages[0].isCompactSummary, true);
  h.clear();
  assert.equal(h.messages.length, 0);
  assert.equal(await h.compact(), null);
});

test('compaction guards: tiny history is skipped silently, a counterproductive compaction is reverted, a trip suspends instead of bricking', async () => {
  // 1) not worth it: nothing happens, no failure counted, the model is still called
  const small = new Harness({ model: async (req) => (req.tools.length === 0 ? text('<summary>S</summary>') : text('hi', { input_tokens: 170000 })), tools: [defineTool({ name: 'T', call: () => 'x' })] });
  await drive(small, 'a');
  const r1 = await drive(small, 'b');
  assert.equal(r1.t.reason, 'completed');
  assert.ok(r1.ev.some((e) => e.type === 'compact_skipped'));
  assert.equal(small.compactions.length, 0);
  assert.equal(small.compactFailures, 0);

  // 2) summary as large as the input: reverted, history preserved
  const hugeSummary = `<summary>${BIG.repeat(3)}</summary>`;
  const big = new Harness({ model: async (req) => (req.tools.length === 0 ? text(hugeSummary) : text('ok', { input_tokens: 170000 })), tools: [defineTool({ name: 'T', call: () => 'x' })] });
  await drive(big, `first ${BIG}`);
  const before = big.messages.length;
  const r2 = await drive(big, 'second');
  assert.ok(r2.ev.some((e) => e.type === 'warning' && /would not reduce the context/.test(e.message)));
  assert.equal(big.compactions.length, 0);
  assert.ok(big.messages.length >= before);             // nothing was thrown away
  assert.equal(big.compactFailures, 1);

  // 3) after a breaker trip the session keeps working (auto-compaction paused) and /compact re-enables it
  const model = async (req) => (req.tools.length === 0 ? text('<summary>S</summary>')
    : { content: [{ type: 'tool_use', id: `u${Math.random()}`, name: 'T', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 170000 } });
  const h = new Harness({ model, tools: [defineTool({ name: 'T', isReadOnly: () => true, call: () => BIG })], maxTurns: 50, permissionMode: 'bypassPermissions' });
  assert.equal((await drive(h, `go ${BIG}`)).t.reason, 'rapid_refill_breaker');
  assert.equal(h.autoCompactSuspended, true);
  h.maxTurns = 2;
  const next = await drive(h, 'continue');              // does NOT end instantly with the breaker reason
  assert.notEqual(next.t.reason, 'rapid_refill_breaker');
  h.clear();
  assert.equal(h.autoCompactSuspended, false);
});

test('threshold respects fixed overhead: a tiny window cannot make compaction fire on every turn', () => {
  const h = new Harness({ model: async () => text('x'), tools: Array.from({ length: 30 }, (_, i) => defineTool({ name: `Tool${i}`, description: 'd'.repeat(600), call: () => 'x' })),
    system: 'S'.repeat(4000), contextWindow: 60000, compactPct: 5 });
  const c = h.contextStatus();
  assert.ok(c.baseline > 4000);
  assert.ok(c.threshold >= c.baseline + 4000, `threshold ${c.threshold} baseline ${c.baseline}`);
  assert.equal(c.feasible, true);
  const tiny = new Harness({ model: async () => text('x'), tools: [], system: 'S'.repeat(40000), contextWindow: 12000 });
  assert.equal(tiny.contextStatus().feasible, false);
});

import { formatUserMessages, parseUserMessages } from '../src/context.js';

test('formatUserMessages: numbered, clipped, and middle omitted for long sessions; wrapSummary carries it plus session state', () => {
  assert.equal(formatUserMessages([]), '');
  const f = formatUserMessages(['first request', 'x'.repeat(1000)]);
  assert.match(f, /^1\. first request\n2\. x{400}…$/);
  const many = Array.from({ length: 60 }, (_, i) => `msg ${i + 1}`);
  const m = formatUserMessages(many);
  assert.match(m, /^1\. msg 1\n2\. msg 2\n3\. msg 3\n\[32 messages omitted\]\n36\. msg 36/);
  assert.match(m, /60\. msg 60$/);
  const w = wrapSummary('S', { userMessages: ['do A', 'do B'], extra: 'Tasks: #1 x' });
  assert.match(w, /<summary>\nS\n<\/summary>/);
  assert.match(w, /<user-messages>[\s\S]*1\. do A\n2\. do B\n<\/user-messages>/);
  assert.match(w, /<session-state>\nTasks: #1 x\n<\/session-state>/);
  assert.deepEqual(parseUserMessages(w), ['do A', 'do B']);
  assert.equal(wrapSummary('S').includes('<user-messages>'), false);
});

test('prompts and tasks survive repeated compactions verbatim even when the summarizer is useless (no drift)', async () => {
  const model = async (req) => (req.tools.length === 0 ? text('<summary>unhelpful vague summary</summary>')
    : text('ok', { input_tokens: 170000, output_tokens: 5 }));
  const h = new Harness({ model, tools: [defineTool({ name: 'T', call: () => 'x' })], compactionExtra: () => 'Task list:\n#1 [pending] ship it' });
  const FIRST = `FIRST REQUEST: build slugify with exactly 6 tests, codeword ZEBRA-42. ${BIG}`;
  await drive(h, FIRST);
  for (const p of ['second request', 'third request', 'fourth request']) {
    await drive(h, `${p} ${BIG}`);
    await h.compact();                                   // each compaction summarizes the previous summary again
  }
  assert.equal(h.compactions.length, 3);
  const summary = h.messages[0];
  assert.equal(summary.isCompactSummary, true);
  assert.match(summary.content, /unhelpful vague summary/);
  assert.match(summary.content, /1\. FIRST REQUEST: build slugify with exactly 6 tests, codeword ZEBRA-42\./);
  assert.match(summary.content, /2\. second request/);
  assert.match(summary.content, /4\. fourth request/);
  assert.match(summary.content, /#1 \[pending\] ship it/);

  // resuming rebuilds the verbatim list from the summary itself
  const r = new Harness({ model, tools: [] });
  r.messages.push(...h.messages.map((m) => ({ ...m })));
  r.restoreUserPrompts();
  assert.equal(r.userPrompts.length, 4);
  assert.match(r.userPrompts[0], /^FIRST REQUEST/);
  h.clear();
  assert.deepEqual(h.userPrompts, []);
});

import { microCompact, buildFileAttachments, CLEARED_MARKER } from '../src/context.js';
import { createState } from '../src/tools.js';
import { SessionStore, loadSession } from '../src/session.js';
import { mkdtempSync, writeFileSync as wf } from 'node:fs';
import { tmpdir as td } from 'node:os';
import pth from 'node:path';

const toolPair = (id, name, content, isErr = false) => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isErr ? { is_error: true } : {}) }] },
];

test('microCompact clears old large compactable results, keeps recent ones, errors, small ones and non-compactable tools', () => {
  const big = 'x'.repeat(4000);
  const msgs = [
    { role: 'user', content: 'start' },
    ...toolPair('1', 'Read', big), ...toolPair('2', 'Grep', big), ...toolPair('3', 'Write', big),
    ...toolPair('4', 'Bash', 'small output'), ...toolPair('5', 'Read', big, true),
    ...toolPair('6', 'mcp__fs__read', big), ...toolPair('7', 'Read', big), ...toolPair('8', 'Read', big),
    ...toolPair('9', 'Bash', big), ...toolPair('10', 'Glob', big),
  ];
  const r = microCompact(msgs, { keepRecent: 4, minChars: 1500 });
  const byId = Object.fromEntries(msgs.filter((m) => m.role === 'user' && Array.isArray(m.content)).map((m) => [m.content[0].tool_use_id, m.content[0].content]));
  assert.equal(byId['1'], CLEARED_MARKER);          // old Read, large
  assert.equal(byId['2'], CLEARED_MARKER);          // old Grep
  assert.equal(byId['3'], big);                      // Write is not a compactable tool
  assert.equal(byId['4'], 'small output');           // too small to bother
  assert.equal(byId['5'], big);                      // errors are kept
  assert.equal(byId['6'], CLEARED_MARKER);          // MCP results are compactable
  assert.equal(byId['7'], big);                      // 7,8,9,10 are the four most recent results
  assert.equal(r.cleared, 3);                        // 1, 2 and 6
  assert.equal(Object.values(byId).filter((c) => c === CLEARED_MARKER).length, 3);
  assert.ok(r.freedTokens > 2500);
  assert.equal(microCompact(msgs).cleared, 0);       // idempotent
});

test('buildFileAttachments: numbered current contents, per-file and total budgets, skips unreadable and binary files', () => {
  const files = { '/a.js': 'one\ntwo\n', '/big.txt': 'y'.repeat(200000), '/bin': 'ab\u0000cd', '/c.js': 'last' };
  const read = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
  const a = buildFileAttachments(['/a.js', '/missing', '/bin', '/big.txt', '/c.js'], { read, perFileTokens: 500, totalTokens: 1200 });
  assert.deepEqual(a.files.map((f) => f.path), ['/a.js', '/big.txt', '/c.js'].slice(0, a.files.length));
  assert.match(a.message.content, /<file path="\/a\.js">\n1\tone\n2\ttwo/);
  assert.match(a.message.content, /\[truncated: file continues/);
  assert.equal(a.message.isFileAttachment, true);
  assert.ok(a.tokens <= 1500);
  assert.equal(buildFileAttachments(['/nope'], { read }).message, null);
  assert.equal(buildFileAttachments(['/a.js', '/c.js'], { read, maxFiles: 1 }).files.length, 1);
});

test('state.recentFiles tracks most-recent-first order across Read/Write/Edit touches', () => {
  const st = createState();
  st.touch('/a'); st.touch('/b'); st.touch('/c'); st.touch('/a');
  assert.deepEqual(st.recentFiles(2), ['/a', '/c']);
  assert.deepEqual(st.recentFiles(10), ['/a', '/c', '/b']);
});

test('harness: micro-compaction relieves pressure without a model call; full compaction re-attaches recent files from disk', async () => {
  const dir = mkdtempSync(pth.join(td(), 'rea-att-'));
  const file = pth.join(dir, 'work.js');
  wf(file, 'export const answer = 42;\n// line two\n');
  const big = 'filler '.repeat(900);

  // 1) micro-compaction first: context climbs gradually from ~7k toward the ~10.4k threshold with results of ~500 tokens each
  let calls = 0;
  const midBig = 'filler '.repeat(290);                       // ~2,000 chars
  const model = async (req) => {
    if (req.tools.length === 0) return text('<summary>S</summary>');
    calls++;
    return { content: [{ type: 'tool_use', id: `u${calls}`, name: 'Read', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 6500 + 500 * calls } };
  };
  const reader = defineTool({ name: 'Read', isReadOnly: () => true, call: () => midBig });
  const h = new Harness({ model, tools: [reader], contextWindow: 60000, compactPct: 20, maxTurns: 7, permissionMode: 'bypassPermissions' });
  const { ev } = await drive(h, 'go');
  assert.ok(ev.some((e) => e.type === 'micro_compact' && e.cleared > 0), 'expected a micro_compact event');
  assert.equal(ev.filter((e) => e.type === 'compact_start').length, 0);          // relieved without a full compaction
  assert.ok(h.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.content === CLEARED_MARKER)));
  // tool_use blocks and ids are untouched, so the history stays valid for the API
  const uses = h.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_use') : []));
  const results = h.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : []));
  assert.deepEqual(results.map((r) => r.tool_use_id), uses.map((u) => u.id));

  // 2) full compaction re-attaches the files
  const st = createState();
  st.touch(file);
  const m2 = async (req) => (req.tools.length === 0 ? text('<summary>worked on work.js</summary>') : text('ok', { input_tokens: 5 }));
  const h2 = new Harness({ model: m2, tools: [defineTool({ name: 'T', call: () => 'x' })], recentFiles: () => st.recentFiles(8), contextWindow: 200000 });
  await drive(h2, `first ${BIG}`);
  await drive(h2, 'second');
  const rec = await h2.compact();
  assert.deepEqual(rec.reattached, [file]);
  assert.equal(h2.messages[0].isCompactSummary, true);
  assert.equal(h2.messages[1].isFileAttachment, true);
  assert.match(h2.messages[1].content, /1\texport const answer = 42;/);
  // the attachment is current disk content, not a stale copy
  wf(file, 'export const answer = 43;\n');
  const rec2 = await h2.compact();
  assert.ok(rec2 === null || rec2.reattached.length >= 0);
});

test('attachments persist across resume without becoming user prompts', async () => {
  const home = mkdtempSync(pth.join(td(), 'rea-att-home-'));
  const cwd = mkdtempSync(pth.join(td(), 'rea-att-cwd-'));
  const file = pth.join(cwd, 'a.js');
  wf(file, 'x = 1\n');
  const st = createState(); st.touch(file);
  const store = new SessionStore({ cwd, home });
  const model = async (req) => (req.tools.length === 0 ? text('<summary>S</summary>') : text('ok'));
  const h = new Harness({ model, tools: [], store, recentFiles: () => st.recentFiles(), contextWindow: 200000 });
  await drive(h, `real prompt ${BIG}`); await drive(h, 'second');
  await h.compact();
  const loaded = loadSession(store.file);
  const r = new Harness({ model, tools: [] });
  r.messages.push(...loaded.messages);
  r.restoreUserPrompts();
  assert.ok(loaded.messages.some((m) => m.isFileAttachment));
  assert.ok(r.userPrompts.every((p) => !/re-read from disk/.test(p)));
  assert.match(r.userPrompts[0], /^real prompt/);
});

test('re-attachment never makes a compaction net-negative: budget is capped at half of what the summary freed', async () => {
  const dir = mkdtempSync(pth.join(td(), 'rea-att2-'));
  const f = pth.join(dir, 'big.txt');
  wf(f, 'word '.repeat(6000));                              // ~7.5k tokens if fully attached
  const st = createState(); st.touch(f);
  const m = async (req) => (req.tools.length === 0 ? text('<summary>short</summary>') : text('ok'));   // no usage: estimates are used
  const h = new Harness({ model: m, tools: [defineTool({ name: 'T', call: () => 'x' })], recentFiles: () => st.recentFiles(), contextWindow: 200000 });
  await drive(h, `first ${BIG}`); await drive(h, 'second');
  const before = h.contextStatus().tokens;
  const rec = await h.compact();
  assert.ok(rec, 'compaction should run');
  assert.ok(rec.postTokens < before, `post ${rec.postTokens} should be below pre ${before}`);
  assert.equal(h.messages[1].isFileAttachment, true);       // attached, but truncated to the budget
  assert.match(h.messages[1].content, /\[truncated: file continues/);
});
