import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskList, createTaskTools } from '../src/tasks.js';
import { renderTranscript } from '../src/export.js';
import { Harness } from '../src/harness.js';

test('TaskList: create, update status, dependencies (completed blockers stop blocking), delete, persistence callback', () => {
  const saved = [];
  const l = new TaskList([], (items) => saved.push(items.length));
  const a = l.create({ subject: 'write parser' });
  const b = l.create({ subject: 'write tests' });
  l.update(b.id, { addBlockedBy: [a.id] });
  assert.deepEqual(l.get(a.id).blocks, [b.id]);
  assert.match(l.render(), /☐ #2 \[pending\] write tests \(blocked by #1\)/);
  l.update(a.id, { status: 'completed' });
  assert.doesNotMatch(l.render(), /blocked by/);
  assert.equal(l.update(b.id, { status: 'deleted' }).deleted, true);
  assert.equal(l.items.length, 1);
  assert.throws(() => l.update('99', { status: 'completed' }), /No task with id 99/);
  assert.throws(() => l.update(a.id, { addBlockedBy: ['42'] }), /No task with id 42/);
  assert.ok(saved.length >= 4);
  const r = new TaskList([{ id: '7', subject: 'x', status: 'pending', blocks: [], blockedBy: [] }]);
  assert.equal(r.create({ subject: 'y' }).id, '8');                               // ids continue after a restore
});

test('task tools: messages, validation, completion note', async () => {
  const list = new TaskList();
  const [create, get, listTool, update] = createTaskTools(list);
  assert.equal(create.call({ subject: 'a' }), 'Task #1 created: a');
  create.call({ subject: 'b' });
  assert.match(listTool.call({}), /#1 \[pending\] a\n.*#2 \[pending\] b/);
  assert.match(update.call({ id: '1', status: 'in_progress' }), /Task #1 is now in_progress\. 2 tasks remaining/);
  assert.match(update.call({ id: '1', status: 'completed' }), /1 task remaining/);
  assert.match(update.call({ id: '2', status: 'completed' }), /All tasks are completed/);
  assert.equal(JSON.parse(get.call({ id: '1' })).status, 'completed');
  assert.throws(() => get.call({ id: '9' }), /No task/);
  assert.equal(update.isConcurrencySafe(), false);
  assert.equal(get.isConcurrencySafe(), true);
});

test('renderTranscript: roles, tool calls and results clipped, summaries labelled, synthetic skipped', () => {
  const md = renderTranscript([
    { role: 'user', content: 'fix the bug' },
    { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'x.js' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'y'.repeat(3000), is_error: false }] },
    { role: 'user', content: 'SUMMARY TEXT', isCompactSummary: true },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z', content: 'interrupted' }], synthetic: true },
  ], { title: 'T', model: 'm', cwd: '/c' });
  assert.match(md, /^# T\n\n- model: m\n- cwd: \/c/);
  assert.match(md, /## User\n\nfix the bug/);
  assert.match(md, /\*\*Tool call:\*\* `Read`/);
  assert.match(md, /… \[1500 more characters\]/);
  assert.match(md, /## Summary of earlier conversation\n\nSUMMARY TEXT/);
  assert.doesNotMatch(md, /interrupted/);
});

test('harness.complete() is a tool-less one-shot and usage totals accumulate', async () => {
  const seen = [];
  const model = async (req) => { seen.push(req); return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4 } }; };
  const h = new Harness({ model, tools: [] });
  assert.equal(await h.complete({ system: 'S', prompt: 'P' }), 'ok');
  assert.deepEqual(seen[0].tools, []);
  assert.equal(seen[0].messages[0].content, 'P');
  await h.run('hello'); await h.run('again');
  assert.deepEqual(h.usageTotals, { requests: 2, input_tokens: 20, output_tokens: 6, cache_read_input_tokens: 8 });
});
