#!/usr/bin/env node
// Compare Claude Code's behaviour with rea's on the same prompt, read-only (permission-mode plan on both sides).
//   node scripts/compare.mjs "which files mention TODO?" [--cwd dir] [--out trace.json]
// Side A: the real `claude -p` (uses your subscription via the real client).
// Side B: rea's own loop. REA_PROVIDER=openai uses an OpenAI-compatible endpoint (OPENAI_API_KEY, OPENAI_BASE_URL,
// OPENAI_MODEL); otherwise the Anthropic API (ANTHROPIC_API_KEY). Skipped when no key is set.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { runClaudeCli, summarizeTrace } from '../src/backends/claude-cli.js';
import { Harness, defaultTools, createState, createAnthropicModel, createOpenAIModel, buildSystemPrompt } from '../src/index.js';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const cwd = path.resolve(flag('--cwd') ?? process.cwd());
const out = flag('--out');
const prompt = args.join(' ');
if (!prompt) { console.error('usage: compare.mjs "<prompt>" [--cwd dir] [--out file]'); process.exit(2); }

async function sideClaude() {
  const events = []; const gen = runClaudeCli({ prompt, cwd, permissionMode: 'plan', persist: false });
  let s; while (!(s = await gen.next()).done) events.push(s.value);
  return summarizeTrace(events, s.value);
}

async function sideRea() {
  const openai = process.env.REA_PROVIDER === 'openai';
  if (!(openai ? process.env.OPENAI_API_KEY ?? process.env.REA_API_KEY : process.env.ANTHROPIC_API_KEY)) return { skipped: `${openai ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} not set` };
  const events = [];
  const h = new Harness({
    model: openai ? createOpenAIModel() : createAnthropicModel(), tools: defaultTools({ cwd, state: createState() }), permissionMode: 'plan',
    system: buildSystemPrompt({ cwd }), maxTurns: 15, onEvent: (e) => events.push(e),
  });
  const r = await h.run(prompt);
  return { ...summarizeTrace(events.filter((e) => e.type === 'assistant'), { reason: r.reason, turns: r.turns, text: r.text }) };
}

const [claude, rea] = await Promise.all([sideClaude(), sideRea()]);
const seq = (t) => (t.toolCalls ?? []).map((c) => c.tool);
const agree = rea.skipped ? null : JSON.stringify(seq(claude)) === JSON.stringify(seq(rea));
const result = { prompt, cwd, claude, rea, sameToolSequence: agree };
console.log(`prompt : ${prompt}\ncwd    : ${cwd}\n`);
console.log(`claude : ${claude.reason}, ${claude.turns} turns, $${claude.costUsd ?? '?'}\n         tools: ${seq(claude).join(' -> ') || '(none)'}`);
console.log(rea.skipped ? `rea    : skipped (${rea.skipped})` : `rea    : ${rea.reason}, ${rea.turns} turns\n         tools: ${seq(rea).join(' -> ') || '(none)'}\n\nsame tool sequence: ${agree}`);
if (out) { writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`); console.error(`wrote ${out}`); }
