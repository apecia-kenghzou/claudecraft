import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Harness, defineTool } from '../src/harness.js';
import { RuleSet } from '../src/permissions.js';
import { SessionStore, listSessions } from '../src/session.js';
import { parseAgentFile, loadAgents, filterTools, createAgentTool, BUILT_IN_AGENTS } from '../src/agents.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'rea-ag-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t, usage) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage });
const uses = (...calls) => ({ content: calls.map(([name, input], i) => ({ type: 'tool_use', id: `u${i}`, name, input })), stop_reason: 'tool_use' });
const isChild = (req) => !/NEVER_IN_PARENT/.test(req.system) && /sub-agent|read-only|architect|CUSTOM_AGENT/.test(req.system);

function setup({ childScript, parentScript, hooks, rules, store, extraTools = [], permissionMode = 'bypassPermissions', defs } = {}) {
  const log = { child: [], parent: [] };
  let pi = 0, ci = 0;
  const model = async (req) => {
    const snap = { ...req, messages: structuredClone(req.messages) };
    if (isChild(req)) { log.child.push(snap); const r = childScript[Math.min(ci++, childScript.length - 1)]; return typeof r === 'function' ? r(req) : r; }
    log.parent.push(snap); return parentScript[Math.min(pi++, parentScript.length - 1)];
  };
  const tools = [
    defineTool({ name: 'Read', isReadOnly: () => true, isConcurrencySafe: () => true, call: () => 'file contents' }),
    defineTool({ name: 'Glob', isReadOnly: () => true, isConcurrencySafe: () => true, call: () => 'a.js' }),
    defineTool({ name: 'Grep', isReadOnly: () => true, isConcurrencySafe: () => true, call: () => 'match' }),
    defineTool({ name: 'Write', isEdit: () => true, call: () => 'written' }),
    defineTool({ name: 'Bash', permissionContent: ({ command }) => ({ kind: 'command', value: command }), isReadOnly: ({ command }) => /^ls\b/.test(command), call: ({ command }) => `ran ${command}` }),
    ...extraTools,
  ];
  let h;
  const events = [];
  tools.push(createAgentTool({ getParent: () => h, definitions: defs ?? BUILT_IN_AGENTS, cwd: '/proj', onEvent: (e) => events.push(e) }));
  h = new Harness({ model, tools, permissionMode, hooks, rules: rules ?? new RuleSet({ cwd: '/proj' }), cwd: '/proj', store, system: 'PARENT_SYSTEM' });
  return { h, log, events };
}
const toolResult = (h) => h.messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result').content;

test('parseAgentFile: frontmatter, defaults, and validation errors', () => {
  const a = parseAgentFile('---\nname: reviewer\ndescription: Reviews diffs\ntools: Read, Grep\nmodel: sonnet\nmaxTurns: 7\n---\nYou review code. CUSTOM_AGENT', 'reviewer.md');
  assert.equal(a.agentType, 'reviewer');
  assert.deepEqual(a.tools, ['Read', 'Grep']);
  assert.equal(a.maxTurns, 7);
  assert.match(a.systemPrompt(), /CUSTOM_AGENT/);
  assert.ok(a.disallowedTools.includes('Agent'));                 // custom agents cannot nest either
  assert.throws(() => parseAgentFile('no frontmatter', 'x.md'), /frontmatter/);
  assert.throws(() => parseAgentFile('---\nname: x\n---\nbody', 'x.md'), /description/);
  assert.throws(() => parseAgentFile('---\nname: bad name!\ndescription: d\n---\nb', 'x.md'), /invalid agent name/);
});

test('loadAgents: built-ins, user then project override, bad files skipped with a warning', () => {
  const home = tmp(), cwd = tmp(), warns = [];
  mkdirSync(path.join(home, '.rea', 'agents'), { recursive: true });
  mkdirSync(path.join(cwd, '.rea', 'agents'), { recursive: true });
  writeFileSync(path.join(home, '.rea', 'agents', 'helper.md'), '---\nname: helper\ndescription: user helper\n---\nuser');
  writeFileSync(path.join(cwd, '.rea', 'agents', 'helper.md'), '---\nname: helper\ndescription: project helper\n---\nproject');
  writeFileSync(path.join(cwd, '.rea', 'agents', 'Explore.md'), '---\nname: Explore\ndescription: my explore\n---\nmine');
  writeFileSync(path.join(cwd, '.rea', 'agents', 'broken.md'), 'nope');
  const defs = loadAgents(cwd, { home, warn: (m) => warns.push(m) });
  assert.equal(defs.find((d) => d.agentType === 'helper').whenToUse, 'project helper');
  assert.equal(defs.find((d) => d.agentType === 'Explore').whenToUse, 'my explore');
  assert.ok(defs.some((d) => d.agentType === 'Plan'));
  assert.equal(warns.length, 1);
});

test('filterTools: wildcard, allow-list and deny-list; the Agent tool is never given to a child', () => {
  const names = ['Read', 'Write', 'Bash', 'Agent'].map((name) => ({ name }));
  const f = (def) => filterTools(names, def).map((t) => t.name);
  assert.deepEqual(f({ tools: ['*'], disallowedTools: [] }), ['Read', 'Write', 'Bash']);
  assert.deepEqual(f({ tools: ['Read', 'Agent'], disallowedTools: [] }), ['Read']);
  assert.deepEqual(f({ tools: ['*'], disallowedTools: ['Write'] }), ['Read', 'Bash']);
});

test('Explore: isolated context, read-only tool set, result carries report + agentId + usage; parent never sees child history', async () => {
  const { h, log } = setup({
    parentScript: [uses(['Agent', { description: 'find x', prompt: 'Where is X defined?', subagent_type: 'Explore' }]), text('X is in a.js')],
    childScript: [uses(['Grep', { pattern: 'X' }]), text('X is defined in src/a.js:10', { input_tokens: 100, output_tokens: 20 })],
  });
  await h.run('where is X?');
  const child = log.child[0];
  assert.deepEqual(child.tools.map((t) => t.name).sort(), ['Bash', 'Glob', 'Grep', 'Read']);   // no Write, no Agent
  assert.equal(child.messages.length, 1);                                                          // only the prompt
  assert.equal(child.messages[0].content, 'Where is X defined?');
  const r = toolResult(h)[0];
  assert.match(r.content, /X is defined in src\/a\.js:10/);
  assert.match(r.content, /agentId: agent-[0-9a-f]{8}/);
  assert.match(r.content, /<usage>subagent_tokens: 120 tool_uses: 1 duration_ms: \d+<\/usage>/);
  assert.equal(JSON.stringify(h.messages).includes('"pattern":"X"'), false);                     // child's tool call not in parent history
  assert.equal(log.parent.at(-1).messages.at(-1).content[0].type, 'tool_result');
});

test('read-only agents cannot mutate: Write is unknown to them and mutating Bash is denied even under bypass', async () => {
  const { h, log } = setup({
    permissionMode: 'bypassPermissions',
    parentScript: [uses(['Agent', { description: 'd', prompt: 'p', subagent_type: 'Plan' }]), text('ok')],
    childScript: [uses(['Write', { file_path: 'x' }], ['Bash', { command: 'touch x' }], ['Bash', { command: 'ls' }]), text('done')],
  });
  await h.run('go');
  const res = log.child[1].messages.at(-1).content;
  assert.match(res[0].content, /No such tool available: Write/);
  assert.match(res[1].content, /plan mode: only read-only tools may run/);
  assert.equal(res[2].content, 'ran ls');
});

test('general-purpose inherits the parent permission mode and tools (minus Agent)', async () => {
  const { h, log } = setup({
    parentScript: [uses(['Agent', { description: 'd', prompt: 'write it' }]), text('ok')],
    childScript: [uses(['Write', { file_path: 'y' }]), text('wrote y')],
  });
  await h.run('go');
  assert.deepEqual(log.child[0].tools.map((t) => t.name).sort(), ['Bash', 'Glob', 'Grep', 'Read', 'Write']);
  assert.equal(log.child[1].messages.at(-1).content[0].content, 'written');
});

test('permission rules (deny) from the parent apply inside the child', async () => {
  const rules = new RuleSet({ cwd: '/proj' }).add('deny', 'Bash(rm:*)', 'projectSettings');
  const { h, log } = setup({
    rules,
    parentScript: [uses(['Agent', { description: 'd', prompt: 'p' }]), text('ok')],
    childScript: [uses(['Bash', { command: 'rm -rf build' }]), text('done')],
  });
  await h.run('go');
  assert.match(log.child[1].messages.at(-1).content[0].content, /denied by rule Bash\(rm:\*\) \(projectSettings\)/);
});

test('SubagentStart/Stop fire in order; a child ends via SubagentStop (not Stop) and can be blocked once', async () => {
  const order = [];
  let blocked = false;
  const hooks = {
    SubagentStart: [(p) => { order.push(`start:${p.agentType}`); }],
    SubagentStop: [() => { order.push('stop-hook'); if (!blocked) { blocked = true; return { decision: 'block', reason: 'verify first' }; } }],
    Stop: [() => { order.push('PARENT-STOP-ON-CHILD?'); }],
  };
  const { h, log } = setup({
    hooks,
    parentScript: [uses(['Agent', { description: 'd', prompt: 'p' }]), text('done')],
    childScript: [text('first'), text('second')],
  });
  await h.run('go');
  assert.equal(order[0], 'start:general-purpose');
  assert.equal(order.filter((x) => x === 'stop-hook').length, 3);        // child blocked once, then finished; + SubagentStop event
  assert.equal(log.child.length, 2);                                     // blocked once -> second child turn
  assert.equal(order.filter((x) => x === 'PARENT-STOP-ON-CHILD?').length, 1);   // only the parent's own final Stop
});

test('two Agent calls in one turn run in parallel', async () => {
  let active = 0, peak = 0;
  const { h } = setup({
    parentScript: [uses(['Agent', { description: 'a', prompt: 'one' }], ['Agent', { description: 'b', prompt: 'two' }]), text('merged')],
    childScript: [async () => { active++; peak = Math.max(peak, active); await sleep(30); active--; return text('child done'); }],
  });
  await h.run('go');
  assert.equal(peak, 2);
  assert.equal(toolResult(h).length, 2);
});

test('validation: unknown type lists the available ones; background is rejected; no nesting inside a child', async () => {
  const { h } = setup({
    parentScript: [uses(['Agent', { description: 'd', prompt: 'p', subagent_type: 'Nope' }], ['Agent', { description: 'd', prompt: 'p', run_in_background: true }]), text('ok')],
    childScript: [text('x')],
  });
  await h.run('go');
  const [a, b] = toolResult(h);
  assert.match(a.content, /Unknown agent type "Nope"\. Available: general-purpose, Explore, Plan/);
  assert.match(b.content, /run_in_background is not supported/);
});

test('child hitting its turn limit says so; a failing child surfaces as a tool error', async () => {
  const loop = uses(['Read', { file_path: 'a' }]);
  const defs = [{ ...BUILT_IN_AGENTS[0], maxTurns: 2 }];
  const { h } = setup({ defs, parentScript: [uses(['Agent', { description: 'd', prompt: 'p' }]), text('ok')], childScript: [loop] });
  await h.run('go');
  assert.match(toolResult(h)[0].content, /stopped after 2 turns/);

  const boom = async () => { const e = new Error('upstream down'); e.kind = 'server'; throw e; };
  const { h: h2 } = setup({ parentScript: [uses(['Agent', { description: 'd', prompt: 'p' }]), text('ok')], childScript: [boom] });
  await h2.run('go');
  const r = toolResult(h2)[0];
  assert.equal(r.is_error, true);
  assert.match(r.content, /sub-agent failed: upstream down/);
});

test('custom agent definition drives prompt, tools and turn limit', async () => {
  const def = parseAgentFile('---\nname: greper\ndescription: only greps\ntools: Grep\nmaxTurns: 3\n---\nCUSTOM_AGENT: grep only', 'greper.md');
  const { h, log } = setup({ defs: [...BUILT_IN_AGENTS, def],
    parentScript: [uses(['Agent', { description: 'd', prompt: 'p', subagent_type: 'greper' }]), text('ok')], childScript: [text('found')] });
  await h.run('go');
  assert.deepEqual(log.child[0].tools.map((t) => t.name), ['Grep']);
  assert.match(log.child[0].system, /CUSTOM_AGENT: grep only/);
});

test('sidechain transcript is written under the session dir and is not listed as a session', async () => {
  const home = tmp(), cwd = tmp();
  const store = new SessionStore({ cwd, home });
  const { h } = setup({ store, parentScript: [uses(['Agent', { description: 'd', prompt: 'p' }]), text('ok')], childScript: [text('child text')] });
  await h.run('go');
  const sub = path.join(store.dir, store.sessionId, 'subagents');
  assert.ok(existsSync(sub));
  const files = readdirSync(sub);
  assert.equal(files.length, 1);
  assert.match(files[0], /^agent-[0-9a-f]{8}\.jsonl$/);
  assert.equal(listSessions(cwd, home).length, 1);          // only the parent session
});
