import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, defineTool } from '../src/harness.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const use = (...calls) => ({ content: calls.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}`, name, input })) });
const scripted = (...replies) => { let i = 0; return async () => replies[i++]; };

const echo = defineTool({
  name: 'Echo', inputSchema: { type: 'object', required: ['s'], properties: { s: { type: 'string' } } },
  isReadOnly: () => true, isConcurrencySafe: () => true, call: ({ s }) => s,
});
const write = defineTool({ name: 'Write', call: () => 'written' });

test('loop runs tool then finishes with final text', async () => {
  const h = new Harness({ model: scripted(use(['Echo', { s: 'hi' }]), text('done')), tools: [echo] });
  const r = await h.run('go');
  assert.equal(r.text, 'done');
  assert.equal(r.messages[2].content[0].content, 'hi');
});

test('invalid input and unknown tools return is_error results, not throws', async () => {
  const h = new Harness({ model: scripted(use(['Echo', {}], ['Nope', {}]), text('ok')), tools: [echo] });
  const r = await h.run('go');
  assert.ok(r.messages[2].content.every((c) => c.is_error));
  assert.match(r.messages[2].content[0].content, /missing required field "s"/);
});

test('permission modes', async () => {
  const run = (permissionMode, extra = {}) =>
    new Harness({ model: scripted(use(['Write', {}]), text('x')), tools: [write], permissionMode, ...extra }).run('go');
  assert.match((await run('plan')).messages[2].content[0].content, /plan mode/);
  assert.match((await run('default')).messages[2].content[0].content, /no askUser/);
  assert.equal((await run('default', { askUser: () => true })).messages[2].content[0].content, 'written');
  assert.equal((await run('bypassPermissions')).messages[2].content[0].content, 'written');
  assert.match((await run('bypassPermissions', { deny: ['Write'] })).messages[2].content[0].content, /denied by policy/);
});

test('PreToolUse hook can deny or rewrite input; PostToolUse can rewrite output', async () => {
  const hooks = {
    PreToolUse: [({ input }) => (input.s === 'secret' ? { decision: 'deny', reason: 'no secrets' } : { updatedInput: { s: input.s.toUpperCase() } })],
    PostToolUse: [({ output }) => ({ replaceOutput: `[${output}]` })],
  };
  const h = new Harness({ model: scripted(use(['Echo', { s: 'secret' }], ['Echo', { s: 'ok' }]), text('d')), tools: [echo], hooks });
  const [a, b] = (await h.run('go')).messages[2].content;
  assert.match(a.content, /no secrets/);
  assert.equal(b.content, '[OK]');
});

test('concurrency-safe tools run in parallel; unsafe ones serialize; order preserved', async () => {
  let active = 0, peak = 0;
  const slow = (name, safe) => defineTool({
    name, isReadOnly: () => true, isConcurrencySafe: () => safe,
    call: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active--; return name; },
  });
  const h = new Harness({
    model: scripted(use(['A', {}], ['B', {}], ['C', {}]), text('d')),
    tools: [slow('A', true), slow('B', true), slow('C', false)],
  });
  const r = await h.run('go');
  assert.equal(peak, 2);
  assert.deepEqual(r.messages[2].content.map((c) => c.content), ['A', 'B', 'C']);
});

test('Stop hook can force another turn; maxTurns bounds the loop', async () => {
  let blocked = false;
  const hooks = { Stop: [() => (blocked ? {} : ((blocked = true), { decision: 'block', reason: 'run tests first' }))] };
  const h = new Harness({ model: scripted(text('a'), text('b')), tools: [], hooks });
  const r = await h.run('go');
  assert.equal(r.text, 'b'); assert.equal(r.turns, 2);
  const loop = new Harness({ model: async () => use(['Echo', { s: 'x' }]), tools: [echo], maxTurns: 3 });
  assert.equal((await loop.run('go')).stopped, 'max_turns');
});

import { validateInput } from '../src/harness.js';

test('validateInput: arrays, objects, integers, numbers, null and union types are checked correctly', () => {
  const schema = { required: ['a'], properties: {
    a: { type: 'array' }, o: { type: 'object' }, i: { type: 'integer' }, n: { type: 'number' }, b: { type: 'boolean' },
    s: { type: 'string', enum: ['x', 'y'] }, u: { type: ['string', 'null'] },
  } };
  assert.equal(validateInput(schema, { a: [1, 2], o: { k: 1 }, i: 3, n: 1.5, b: true, s: 'x', u: null }), null);
  assert.match(validateInput(schema, { a: 'no' }), /field "a" must be array/);
  assert.match(validateInput(schema, { a: [], o: [] }), /field "o" must be object/);
  assert.match(validateInput(schema, { a: [], o: null }), /field "o" must be object/);
  assert.match(validateInput(schema, { a: [], i: 1.5 }), /field "i" must be integer/);
  assert.match(validateInput(schema, { a: [], n: NaN }), /field "n" must be number/);
  assert.match(validateInput(schema, { a: [], s: 'z' }), /must be one of x, y/);
  assert.match(validateInput(schema, { a: [], u: 5 }), /must be string or null/);
  assert.equal(validateInput({ properties: { weird: { type: 'unknown-type' } } }, { weird: 1 }), null);   // unknown types pass
  assert.equal(validateInput(schema, []), 'input must be an object');
});
