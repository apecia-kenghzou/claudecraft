// Tests for the five "port out" additions: StructuredOutput, ToolSearch (deferred tools), per-model windows.
// Worktrees have their own file (test/worktree.test.js); session fork is covered by the CLI e2e test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredOutputTool, STRUCTURED_OUTPUT_TOOL_NAME, STRUCTURED_OUTPUT_REMINDER } from '../src/structured.js';
import { createToolSearchTool, matchDeferredTools } from '../src/toolsearch.js';
import { windowForModel, MODEL_WINDOWS } from '../src/models.js';
import { Harness, defineTool } from '../src/harness.js';
import { DEFAULT_CONTEXT_WINDOW } from '../src/context.js';

const text = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
const use = (...calls) => ({ content: calls.map(([name, input], i) => ({ type: 'tool_use', id: `u${i}`, name, input })), stop_reason: 'tool_use' });
async function drive(h, p = 'go') { const g = h.query(p); let s; while (!(s = await g.next()).done); return s.value; }

// ---- StructuredOutput ------------------------------------------------------------------------------------------
test('createStructuredOutputTool requires a schema and uses it as the input schema', () => {
  assert.throws(() => createStructuredOutputTool({}), /JSON schema/);
  const t = createStructuredOutputTool({ schema: { type: 'object', required: ['x'], properties: { x: { type: 'number' } } } });
  assert.equal(t.name, STRUCTURED_OUTPUT_TOOL_NAME);
  assert.deepEqual(t.inputSchema, { type: 'object', required: ['x'], properties: { x: { type: 'number' } } });
  assert.equal(t.isReadOnly(), true);
});

test('harness: a successful StructuredOutput call ends the turn with structuredOutput and the reminder is in the system prompt', async () => {
  const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
  const seen = [];
  const model = async (req) => { seen.push(req.system); return use(['StructuredOutput', { answer: '42' }]); };
  const h = new Harness({ model, tools: [createStructuredOutputTool({ schema })], permissionMode: 'bypassPermissions', system: 'BASE' });
  const t = await drive(h);
  assert.equal(t.reason, 'completed');
  assert.deepEqual(t.structuredOutput, { answer: '42' });
  assert.match(seen[0], new RegExp(STRUCTURED_OUTPUT_REMINDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const run = await h.run('go2');
  assert.deepEqual(run.structuredOutput, { answer: '42' });                 // run() wrapper also surfaces it
});

test('harness: an invalid/erroring StructuredOutput call does not end the turn early', async () => {
  const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
  const tool = { ...createStructuredOutputTool({ schema }), call: () => { throw new Error('boom'); } };
  let n = 0;
  const model = async () => (++n === 1 ? use(['StructuredOutput', { answer: 'x' }]) : text('recovered'));
  const h = new Harness({ model, tools: [tool], permissionMode: 'bypassPermissions' });
  const t = await drive(h);
  assert.equal(t.reason, 'completed');
  assert.equal(t.structuredOutput, undefined);
  assert.equal(t.text, 'recovered');
});

test('no StructuredOutput tool registered: no reminder, no structuredOutput field', async () => {
  const seen = [];
  const h = new Harness({ model: async (req) => { seen.push(req.system); return text('plain'); }, tools: [] });
  const t = await drive(h);
  assert.doesNotMatch(seen[0], /StructuredOutput/);
  assert.equal(t.structuredOutput, undefined);
});

// ---- ToolSearch / deferred tools -------------------------------------------------------------------------------
const deferredTool = (name, description = '') => ({ name, description, deferred: true, inputSchema: { type: 'object', properties: {} } });

test('matchDeferredTools: select:, +required, and plain keyword forms', () => {
  const tools = [deferredTool('mcp__slack__send_message', 'Send a Slack message'), deferredTool('mcp__slack__list_channels', 'List Slack channels'), deferredTool('mcp__notion__search', 'Search Notion pages')];
  assert.deepEqual(matchDeferredTools('select:mcp__notion__search', tools).map((t) => t.name), ['mcp__notion__search']);
  assert.deepEqual(matchDeferredTools('select:mcp__slack__send_message,mcp__notion__search', tools).map((t) => t.name), ['mcp__slack__send_message', 'mcp__notion__search']);
  assert.deepEqual(matchDeferredTools('select:nope', tools), []);
  const plus = matchDeferredTools('+slack send', tools);
  assert.equal(plus[0].name, 'mcp__slack__send_message');                   // "send" scores higher than "list_channels"
  assert.ok(plus.every((t) => t.name.includes('slack')));
  assert.deepEqual(matchDeferredTools('notion search', tools).map((t) => t.name), ['mcp__notion__search']);
  assert.deepEqual(matchDeferredTools('xyz unrelated', tools), []);
});

test('harness: deferred tools are withheld from the model, named in a reminder, and unlocked by ToolSearch', async () => {
  const locked = defineTool({ name: 'mcp__big__rare_op', description: 'A rarely used operation', deferred: true, call: () => 'did the rare op' });
  const always = defineTool({ name: 'Read', isReadOnly: () => true, call: () => 'x' });
  const seenReqs = [];
  let n = 0;
  const model = async (req) => {
    seenReqs.push(req);
    n++;
    if (n === 1) return use(['ToolSearch', { query: 'select:mcp__big__rare_op' }]);
    if (n === 2) return use(['mcp__big__rare_op', {}]);
    return text('done');
  };
  let h;
  const search = createToolSearchTool({ getHarness: () => h });
  h = new Harness({ model, tools: [locked, always, search], permissionMode: 'bypassPermissions' });
  const t = await drive(h);

  assert.deepEqual(seenReqs[0].tools.map((x) => x.name).sort(), ['Read', 'ToolSearch'].sort());   // locked tool not sent
  assert.match(seenReqs[0].system, /mcp__big__rare_op/);                     // but its name is in the deferred-tool reminder
  assert.ok(h.unlockedDeferred.has('mcp__big__rare_op'));
  assert.ok(seenReqs[1].tools.some((x) => x.name === 'mcp__big__rare_op'));  // unlocked on the next request
  assert.equal(t.reason, 'completed');
  const results = h.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : []));
  assert.ok(results.some((r) => r.content === 'did the rare op'));
});

test('ToolSearch tool: no-match and no-deferred-tools messages', async () => {
  let h;
  const locked = defineTool({ name: 'mcp__x__y', description: 'something', deferred: true, call: () => 'x' });
  h = new Harness({ model: async () => text('x'), tools: [locked] });
  const search = createToolSearchTool({ getHarness: () => h });
  assert.match(await search.call({ query: 'zzz-nothing-like-this' }), /No deferred tool matched.*mcp__x__y/);
  h.unlockedDeferred.add('mcp__x__y');
  assert.match(await search.call({ query: 'anything' }), /No deferred tools are pending/);
});

// ---- per-model context windows ----------------------------------------------------------------------------------
test('windowForModel: known families match, unknown falls back to the default', () => {
  assert.equal(windowForModel('claude-sonnet-5-5'), 200_000);
  assert.equal(windowForModel('claude-opus-4-1[1m]'), 1_000_000);
  assert.equal(windowForModel('gpt-5.5'), 200_000);
  assert.equal(windowForModel('gpt-4o-mini'), 128_000);
  assert.equal(windowForModel('gemini-2.0-flash'), 1_000_000);
  assert.equal(windowForModel('llama-3.1-70b'), 128_000);
  assert.equal(windowForModel('some-unknown-model-xyz'), DEFAULT_CONTEXT_WINDOW);
  assert.equal(windowForModel(undefined), DEFAULT_CONTEXT_WINDOW);
  assert.equal(windowForModel('x', 12345), 12345);
  assert.ok(MODEL_WINDOWS.length > 5);
});
