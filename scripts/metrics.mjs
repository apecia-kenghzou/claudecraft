#!/usr/bin/env node
// Reverse-engineering coverage metrics. Bundle-side numbers come from metrics/reference.json (captured from the
// analysis); rea-side numbers are computed live from this repository, so they cannot drift from the code.
//   node scripts/metrics.mjs            print
//   node scripts/metrics.mjs --write    also write METRICS.md
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HOOK_EVENTS, PERMISSION_MODES } from '../src/harness.js';
import { defaultTools } from '../src/tools.js';
import { AGENT_TOOL_NAME, BUILT_IN_AGENTS } from '../src/agents.js';
import { SKILL_TOOL_NAME } from '../src/skills.js';
import { createResourceTools } from '../src/mcp.js';
import { TaskList, createTaskTools } from '../src/tasks.js';
import { createAskTool, createPlanTools } from '../src/plan.js';
import { ENTER_WORKTREE, EXIT_WORKTREE } from '../src/worktree.js';
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../src/structured.js';
import { NotebookReadTool, NotebookEditTool } from '../src/notebook.js';
import { MODEL_WINDOWS } from '../src/models.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ref = JSON.parse(readFileSync(path.join(root, 'metrics/reference.json'), 'utf8'));
const F = ref.families, B = ref.bundle;
const src = (f) => readFileSync(path.join(root, f), 'utf8');
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const bar = (a, b, w = 20) => `[${'#'.repeat(Math.round((w * a) / b))}${'.'.repeat(w - Math.round((w * a) / b))}]`;
const countFiles = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : e.name.endsWith('.js') ? 1 : 0), 0);
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

// rea-side facts, derived from code
const harnessSrc = src('src/harness.js');
const cliSrc = src('src/cli.js');
const anthSrc = src('src/model/anthropic.js');
const openaiSrc = src('src/model/openai.js');
const reaTools = [...defaultTools().map((t) => t.name), AGENT_TOOL_NAME, SKILL_TOOL_NAME, ...createResourceTools([]).map((t) => t.name),
  ...createTaskTools(new TaskList()).map((t) => t.name), 'WebFetch', 'WebSearch',
  ...createPlanTools({ getHarness: () => null }).map((t) => t.name), createAskTool({}).name,
  ENTER_WORKTREE, EXIT_WORKTREE, 'ToolSearch', STRUCTURED_OUTPUT_TOOL_NAME, 'LSP', NotebookReadTool({}).name, NotebookEditTool({}).name];   // WebSearch registers when a backend is configured
// terminal = `return { reason: '...' }`; transitions are `type: 'transition', reason: '...'` (kept separate)
const reaTerminal = [...new Set(harnessSrc.split('\n').filter((l) => /(?:return|terminal:) \{ reason:|const reason = /.test(l))
  .flatMap((l) => [...l.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).filter((x) => x !== 'reason'))];
const reaTransitions = [...new Set([...harnessSrc.matchAll(/type: 'transition', reason: '([a-z_]+)'/g)].map((m) => m[1]))];
const reaCommands = [...new Set([...cliSrc.matchAll(/line(?: === |\.startsWith\()'\/([a-z-]+)/g)].map((m) => m[1]))];
const hooksSrc = src('src/hooks.js');
const settingsLoaded = [
  ...['userSettings', 'projectSettings', 'localSettings', 'managedSettings'].filter((n) => hooksSrc.includes(`'${n}'`)),
  ...(/'cliArg'/.test(cliSrc) ? ['cliArg'] : []),
  ...(/'session'/.test(harnessSrc) || /'session'/.test(src('src/permissions.js')) ? ['session'] : []),
];
const modelFeatures = {
  streaming: /stream: streaming/.test(anthSrc), idle_watchdog: /stream_stall/.test(anthSrc),
  non_streaming_fallback: /falling back to non-streaming/.test(anthSrc),
  overload_ratelimit_retry: /overloaded/.test(anthSrc) && /retryAfterMs/.test(anthSrc),
  strip_and_retry: /STRIP_RULES/.test(openaiSrc) && /retrying without prompt-cache markers/.test(anthSrc), model_fallback: /model_fallback/.test(anthSrc),
  refusal_fallback: /refusalFallbackModel/.test(harnessSrc),
  prompt_cache_markers: /cache_control/.test(anthSrc), cache_coverage_monitoring: /cache_miss/.test(harnessSrc),
  context_window_classification: /prompt_too_long/.test(anthSrc), media_limits: false,
  input_sanitization: /const LONE/.test(anthSrc) && /\.replace\(LONE/.test(anthSrc), thinking_resume: false,
};
const pipelineHave = {
  lookup: /this\.tools\.get\(block\.name\)/.test(harnessSrc), unknown_tool: /No such tool available/.test(harnessSrc),
  json_parse: /#parse\(/.test(harnessSrc), schema: /validateInput\(tool\.inputSchema/.test(harnessSrc),
  validate_input: /tool\.validateInput/.test(harnessSrc), pre_tool_hooks: /emit\('PreToolUse'/.test(harnessSrc),
  permission: /#permit\(tool/.test(harnessSrc), call: /tool\.call\(/.test(harnessSrc), post_tool_hooks: /emit\('PostToolUse'/.test(harnessSrc),
};
const testFiles = readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js'));
const testCount = testFiles.reduce((n, f) => n + (src(`test/${f}`).match(/^test\(/gm) ?? []).length, 0);

const inter = (mine, theirs) => theirs.filter((x) => mine.includes(x));
const rows = [
  ['Tools (coding-relevant)', inter(reaTools, F.coding_tools).length, F.coding_tools.length, reaTools.join(', ')],
  ['Hook events', inter(HOOK_EVENTS, F.hook_events).length, F.hook_events.length, HOOK_EVENTS.join(', ')],
  ['Permission modes', inter(PERMISSION_MODES, F.permission_modes).length, F.permission_modes.length, `missing: ${F.permission_modes.filter((m) => !PERMISSION_MODES.includes(m)).join(', ')}`],
  ['Loop terminal reasons', inter(reaTerminal, F.terminal_reasons).length, F.terminal_reasons.length, `own extras: ${reaTerminal.filter((r) => !F.terminal_reasons.includes(r)).join(', ') || 'none'}`],
  ['Loop transitions', inter(reaTransitions, F.transitions).length, F.transitions.length, `missing: ${F.transitions.filter((t) => !reaTransitions.includes(t)).join(', ')}`],
  ['Per-tool pipeline steps', Object.values(pipelineHave).filter(Boolean).length, F.pipeline_steps.length, ''],
  ['Model-layer feature categories', Object.values(modelFeatures).filter(Boolean).length, F.model_layer_features.length,
    `missing: ${Object.entries(modelFeatures).filter(([, v]) => !v).map(([k]) => k).join(', ')}`],
  ['Settings sources', settingsLoaded.length, F.settings_sources.length, settingsLoaded.join(', ')],
  ['Slash commands', inter(reaCommands, F.slash_commands).length, F.slash_commands.length, `have: ${reaCommands.join(', ')}`],
  ['Built-in agent types', inter(BUILT_IN_AGENTS.map((a) => a.agentType), F.agent_types).length, F.agent_types.length, `have: ${BUILT_IN_AGENTS.map((a) => a.agentType).join(', ')}`],
];

const fpDone = B.main_bundle_function_level_bytes + B.other_modules_function_level_bytes;
const lines = [];
const p = (s = '') => lines.push(s);
p('# Reverse-engineering metrics');
p();
p(`Generated by \`node scripts/metrics.mjs\`. Bundle: claude-code 2.1.296. ${ref.provenance}`);
p();
p('## 1. Visibility: how much of the code have we statically analyzed?');
p();
p('| Metric | Value |');
p('|---|---|');
p(`| Modules carved from the binary | ${B.modules_carved} (${mb(B.bytes_carved)}) |`);
p(`| First-party modules (heuristic) | ${B.first_party_modules} (${mb(B.first_party_bytes)}, ${pct(B.first_party_bytes, B.bytes_carved)} of carved) |`);
p(`| Main bundle analyzed to function level | ${mb(B.main_bundle_function_level_bytes)} of ${mb(B.main_bundle_bytes)} (${pct(B.main_bundle_function_level_bytes, B.main_bundle_bytes)}) |`);
p(`| Other modules analyzed to function level | ${B.other_modules_function_level.length} modules, ${mb(B.other_modules_function_level_bytes)} |`);
p(`| **First-party code analyzed to function level** | **${mb(fpDone)} of ${mb(B.first_party_bytes)} = ${pct(fpDone, B.first_party_bytes)}** |`);
p(`| Functions indexed / unique resolved call edges | ${B.functions.toLocaleString()} / ${B.unique_call_edges.toLocaleString()} |`);
p(`| Telemetry event names / CLAUDE_CODE_* env vars seen | ${B.telemetry_events.toLocaleString()} / ${B.env_vars} |`);
p();
p('## 2. Comprehension: how much have we actually *read*?');
p();
p(`Functions read in detail: **${B.functions_read_in_detail.length} of ${B.functions.toLocaleString()} (${pct(B.functions_read_in_detail.length, B.functions)})**, `);
p('chosen as the critical path (batching, tool runner, executor, hook contract, loop recovery). Low by design: most of the');
p('bundle is UI, telemetry and feature-flag plumbing. Reading depth is better judged per subsystem (section 4).');
p();
p('## 3. Replication: what does rea implement of each family?');
p();
p('| Family | rea | Claude Code | Coverage | Progress | Notes |');
p('|---|---|---|---|---|---|');
for (const [name, a, b, note] of rows) p(`| ${name} | ${a} | ${b} | ${pct(a, b)} | \`${bar(a, b)}\` | ${note} |`);
const macro = rows.reduce((s, r) => s + r[1] / r[2], 0) / rows.length;
p();
p(`**Unweighted mean across these ${rows.length} families: ${(100 * macro).toFixed(1)}%.** The families are not equal in importance:`);
p('the loop, model layer and tool pipeline (the parts that decide whether the agent works) are mostly done; the long tail');
p('(slash commands, agent types, hook events) is breadth that matters less per item.');
p();
p('## 4. Depth by subsystem');
p();
p('L0 located, L1 characterized (names/strings/events), L2 function-level read, L3 re-implemented and tested.');
p();
p('| Subsystem | Depth | Detail |');
p('|---|---|---|');
const fill = {
  terminal: `${rows[3][1]}/${rows[3][2]}`, transitions: `${rows[4][1]}/${rows[4][2]}`,
  model: `${rows[6][1]}/${rows[6][2]}`, hooks: `${rows[1][1]}/${rows[1][2]}`,
};
for (const [n, d, t] of ref.subsystem_depth) p(`| ${n} | ${d} | ${t.replace(/\{(\w+)\}/g, (_, k) => fill[k] ?? k)} |`);
const L = (d) => ref.subsystem_depth.filter((r) => r[1] === d).length;
p();
p(`Counts: L3 = ${L('L3')}, L2 = ${L('L2')}, L1 = ${L('L1')}, L0 = ${L('L0')} of ${ref.subsystem_depth.length} subsystems.`);
p();
p('## 5. Project health');
p();
p(`- Tests: **${testCount}** across ${testFiles.length} files (\`npm test\`).`);
p(`- Source files: ${countFiles(path.join(root, 'src'))} (zero runtime dependencies).`);
p('- Live-validated (2026-10-13 to 2026-10-14, gpt-5.5 via an OpenAI-compatible endpoint): tool loop, Write/Read/Edit/Bash, parallel');
p('  Explore subagents, auto-compaction with recall afterwards, resume across compaction boundaries, real MCP server (official');
p('  filesystem server), hook commands, the terminal UI in a pty, plan mode, web tools, a ~40-request build session with resume and');
p('  repeated compactions, the OS sandbox (real sandbox-exec confinement), git worktree isolation, structured output, ToolSearch');
p('  unlocking a deferred real MCP tool, the LSP tool against real clangd (definition/hover/documentSymbol/diagnostics), and');
p('  NotebookRead/NotebookEdit (cell replace + insert, written back as valid nbformat JSON). Mock-only: Anthropic API client,');
p('  Anthropic prompt caching, MCP over HTTP.');
p();
const out = lines.join('\n');
console.log(out);
if (process.argv.includes('--write')) { writeFileSync(path.join(root, 'METRICS.md'), `${out}\n`); console.error('wrote METRICS.md'); }
