import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Harness, defineTool } from '../src/harness.js';
import { createPlanTools, createAskTool, planFilePath, planModeReminder, MAIN_SESSION_ONLY } from '../src/plan.js';
import { filterTools } from '../src/agents.js';
import { RuleSet } from '../src/permissions.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'rea-plan-'));
const text = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
const use = (...calls) => ({ content: calls.map(([name, input], i) => ({ type: 'tool_use', id: `u${i}`, name, input })), stop_reason: 'tool_use' });

function setup({ script, approvePlan, askQuestions, mode = 'default', home = tmp(), extraTools = [] } = {}) {
  const seenSystems = [];
  let i = 0;
  const model = async (req) => { seenSystems.push(req.system); return script[Math.min(i++, script.length - 1)]; };
  const writes = [];
  const base = [
    defineTool({ name: 'Read', isReadOnly: () => true, isConcurrencySafe: () => true, call: () => 'contents' }),
    defineTool({ name: 'Write', isEdit: () => true, permissionContent: ({ file_path }) => ({ kind: 'path', value: file_path }), call: ({ file_path }) => { writes.push(file_path); return 'written'; } }),
    defineTool({ name: 'Bash', permissionContent: ({ command }) => ({ kind: 'command', value: command }), isReadOnly: ({ command }) => /^ls\b/.test(command), call: ({ command }) => `ran ${command}` }),
    ...extraTools,
  ];
  let h;
  const tools = [...base, ...createPlanTools({ getHarness: () => h, approvePlan }), createAskTool({ askQuestions })];
  h = new Harness({ model, tools, permissionMode: mode, rules: new RuleSet({ cwd: '/proj' }), cwd: '/proj', system: 'BASE', askUser: () => false });
  h.planFile = planFilePath('abcdef123456', home);
  return { h, seenSystems, writes, home };
}
const results = (h) => h.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result').flatMap((m) => m.content);

test('planFilePath is per session under ~/.rea/plans; reminder names the file and the two ways a turn may end', () => {
  assert.equal(planFilePath('abcdef123456', '/h'), '/h/.rea/plans/abcdef12.md');
  const r = planModeReminder('/h/.rea/plans/x.md');
  assert.match(r, /\/h\/\.rea\/plans\/x\.md/);
  assert.match(r, /AskUserQuestion/); assert.match(r, /ExitPlanMode/); assert.match(r, /MUST NOT/);
});

test('EnterPlanMode switches mode, remembers the previous one, and the reminder is added to the system prompt', async () => {
  const { h, seenSystems } = setup({ mode: 'acceptEdits', script: [use(['EnterPlanMode', {}]), text('exploring')] });
  await h.run('add feature');
  assert.equal(h.permissionMode, 'plan');
  assert.equal(h.prePlanMode, 'acceptEdits');
  assert.doesNotMatch(seenSystems[0], /Plan mode is active/);       // first request: not yet in plan mode
  assert.match(seenSystems[1], /# Plan mode is active/);            // after entering
  assert.match(results(h)[0].content, /Entered plan mode/);
});

test('in plan mode: reads and read-only Bash run; edits and mutating Bash are denied; the plan file is writable', async () => {
  const home = tmp();
  const planFile = planFilePath('abcdef123456', home);
  const { h, writes } = setup({ home, mode: 'plan',
    script: [use(['Read', {}], ['Bash', { command: 'ls' }], ['Bash', { command: 'touch x' }], ['Write', { file_path: '/proj/src/a.js' }], ['Write', { file_path: planFile }]), text('done')] });
  await h.run('plan it');
  const r = results(h);
  assert.equal(r[0].content, 'contents');
  assert.equal(r[1].content, 'ran ls');
  assert.match(r[2].content, /plan mode: only read-only tools may run/);
  assert.match(r[3].content, /plan mode: only read-only tools may run/);
  assert.equal(r[4].content, 'written');
  assert.deepEqual(writes, [planFile]);
});

test('in plan mode the plan file and its directory are readable even though they are outside the workspace', async () => {
  const home = tmp();
  const planFile = planFilePath('abcdef123456', home);
  const glob = defineTool({ name: 'Glob', isReadOnly: () => true, isConcurrencySafe: () => true, permissionContent: ({ path: p }) => ({ kind: 'path', value: p }), call: () => 'listing' });
  const read = defineTool({ name: 'ReadAny', isReadOnly: () => true, isConcurrencySafe: () => true, permissionContent: ({ file_path }) => ({ kind: 'path', value: file_path }), call: () => 'plan text' });
  const { h } = setup({ home, mode: 'plan', extraTools: [glob, read],
    script: [use(['Glob', { path: path.dirname(planFile) }], ['ReadAny', { file_path: planFile }], ['ReadAny', { file_path: '/etc/hosts' }]), text('ok')] });
  await h.run('go');
  const r = results(h);
  assert.equal(r[0].content, 'listing');
  assert.equal(r[1].content, 'plan text');
  assert.match(r[2].content, /needs approval/);              // other outside paths stay blocked
});

test('ExitPlanMode: validation (not in plan mode, no plan), approval restores or sets the mode, rejection keeps planning with feedback', async () => {
  // not in plan mode
  const a = setup({ script: [use(['ExitPlanMode', { plan: 'x' }]), text('ok')] });
  await a.h.run('go');
  assert.match(results(a.h)[0].content, /only valid in plan mode/);

  // plan mode, no plan file and no text
  const b = setup({ mode: 'plan', script: [use(['ExitPlanMode', {}]), text('ok')], approvePlan: async () => ({ approved: true }) });
  await b.h.run('go');
  assert.match(results(b.h)[0].content, /No plan found/);

  // rejected with feedback: stays in plan mode, plan saved
  const seen = [];
  const c = setup({ mode: 'plan', script: [use(['ExitPlanMode', { plan: '# Plan\n1. do it' }]), text('revising')],
    approvePlan: async (x) => { seen.push(x); return { approved: false, feedback: 'also add tests' }; } });
  await c.h.run('go');
  assert.equal(c.h.permissionMode, 'plan');
  assert.match(results(c.h)[0].content, /did not approve.*also add tests.*still in plan mode/s);
  assert.equal(readFileSync(c.h.planFile, 'utf8'), '# Plan\n1. do it');
  assert.equal(seen[0].plan, '# Plan\n1. do it');

  // approved with a chosen mode; previous mode used when none chosen
  const d = setup({ mode: 'plan', script: [use(['ExitPlanMode', { plan: 'P' }]), text('go')], approvePlan: async () => ({ approved: true, mode: 'acceptEdits' }) });
  await d.h.run('go');
  assert.equal(d.h.permissionMode, 'acceptEdits');
  assert.match(results(d.h)[0].content, /user approved your plan[\s\S]*\nP$/);
  const e = setup({ mode: 'bypassPermissions', script: [use(['EnterPlanMode', {}], ), use(['ExitPlanMode', { plan: 'P' }]), text('ok')], approvePlan: async () => ({ approved: true }) });
  await e.h.run('go');
  assert.equal(e.h.permissionMode, 'bypassPermissions');             // restored
  assert.equal(e.h.prePlanMode, null);
});

test('without an approver (non-interactive) ExitPlanMode explains and does not leave plan mode', async () => {
  const { h } = setup({ mode: 'plan', script: [use(['ExitPlanMode', { plan: 'P' }]), text('here is the plan')] });
  await h.run('go');
  assert.equal(h.permissionMode, 'plan');
  assert.match(results(h)[0].content, /needs an interactive session/);
});

test('sub-agents never get EnterPlanMode / ExitPlanMode / AskUserQuestion; sub-agent harness refuses to enter plan mode', async () => {
  const names = ['Read', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'Agent'].map((name) => ({ name }));
  assert.deepEqual(filterTools(names, { tools: ['*'], disallowedTools: [] }).map((t) => t.name), ['Read']);
  assert.deepEqual(MAIN_SESSION_ONLY.sort(), ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
  const { h } = setup({ script: [use(['EnterPlanMode', {}]), text('x')] });
  h.isSubAgent = true;
  await h.run('go');
  assert.match(results(h)[0].content, /Only the main session can enter plan mode/);
  assert.equal(h.permissionMode, 'default');
});

test('AskUserQuestion: validation, answers returned in order, declined and non-interactive paths', async () => {
  const ask = createAskTool({ askQuestions: null });
  const q = (o = {}) => ({ question: 'Which store?', header: 'Store', options: [{ label: 'Redis' }, { label: 'Memory' }], ...o });
  assert.equal(ask.validateInput({ questions: [] }).ok, false);
  assert.equal(ask.validateInput({ questions: [q(), q(), q(), q(), q()] }).ok, false);
  assert.match(ask.validateInput({ questions: [q({ options: [{ label: 'only' }] })] }).message, /2-4 options/);
  assert.match(ask.validateInput({ questions: [q({ header: 'waytoolongheader' })] }).message, /at most 12/);
  assert.equal(ask.validateInput({ questions: [q()] }).ok, true);
  await assert.rejects(ask.call({ questions: [q()] }), /no interactive user/);

  const got = [];
  const tool = createAskTool({ askQuestions: async ({ questions }) => { got.push(questions.length); return ['Redis', 'Memory, Disk']; } });
  const out = await tool.call({ questions: [q(), q({ question: 'Where?', header: 'Where' })] });
  assert.match(out, /\[Store\] Which store\?\n\s+=> Redis/);
  assert.match(out, /\[Where\] Where\?\n\s+=> Memory, Disk/);
  await assert.rejects(createAskTool({ askQuestions: async () => null }).call({ questions: [q()] }), /declined/);
});
