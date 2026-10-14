import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseNotebook, renderNotebook, editNotebook, cellId, findCellIndex, notebookLanguage, NOT_VALID_MESSAGE,
  NotebookReadTool, NotebookEditTool, createNotebookTools,
} from '../src/notebook.js';
import { createState } from '../src/tools.js';
import { Harness } from '../src/harness.js';
import { RuleSet } from '../src/permissions.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'rea-nb-'));
const sampleNb = () => ({
  metadata: { kernelspec: { language: 'python' } }, nbformat: 4, nbformat_minor: 5,
  cells: [
    { id: 'c1', cell_type: 'markdown', source: ['# Title\n'], metadata: {} },
    { id: 'c2', cell_type: 'code', source: ['x = 1\n', 'print(x)'], metadata: {}, execution_count: 1, outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }] },
    { cell_type: 'code', source: 'y = 2', metadata: {}, execution_count: null, outputs: [] },   // no id: falls back to cell-2
  ],
});
const writeNb = (dir, nb = sampleNb(), name = 'nb.ipynb') => { const f = path.join(dir, name); writeFileSync(f, JSON.stringify(nb)); return f; };

test('parseNotebook: missing file, oversized, invalid JSON, missing cells array', () => {
  const dir = tmp();
  assert.throws(() => parseNotebook(path.join(dir, 'missing.ipynb')), /not found/);
  const bad = path.join(dir, 'bad.ipynb'); writeFileSync(bad, 'not json');
  assert.throws(() => parseNotebook(bad), new RegExp(NOT_VALID_MESSAGE.replace(/[.]/g, '\\.')));
  const noCells = path.join(dir, 'noc.ipynb'); writeFileSync(noCells, JSON.stringify({ metadata: {} }));
  assert.throws(() => parseNotebook(noCells), new RegExp(NOT_VALID_MESSAGE.replace(/[.]/g, '\\.')));
  const big = path.join(dir, 'big.ipynb'); writeFileSync(big, JSON.stringify({ cells: [] }) + ' '.repeat(11 * 1024 * 1024));
  assert.throws(() => parseNotebook(big), /exceeds the maximum size/);
});

test('cellId falls back to a positional id; notebookLanguage reads kernelspec', () => {
  const nb = sampleNb();
  assert.equal(cellId(nb.cells[0], 0), 'c1');
  assert.equal(cellId(nb.cells[2], 2), 'cell-2');
  assert.equal(findCellIndex(nb, 'cell-2'), 2);
  assert.equal(findCellIndex(nb, 'nope'), -1);
  assert.equal(notebookLanguage(nb), 'python');
  assert.equal(notebookLanguage({ metadata: {} }), 'python');           // default fallback
  assert.equal(notebookLanguage({ metadata: { language_info: { name: 'rust' } } }), 'rust');
});

test('renderNotebook: shows every cell with id/type/source and code-cell output, truncated when huge', () => {
  const nb = sampleNb();
  const out = renderNotebook(nb);
  assert.match(out, /Notebook \(python, 3 cells\):/);
  assert.match(out, /\[cell 0 markdown id=c1\]\n# Title/);
  assert.match(out, /\[cell 1 code id=c2\]\nx = 1\nprint\(x\)/);
  assert.match(out, /--- output ---\n1/);
  assert.match(out, /\[cell 2 code id=cell-2\]\ny = 2/);
  const bigOut = { ...sampleNb() };
  bigOut.cells[1].outputs = [{ output_type: 'stream', text: 'z'.repeat(3000) }];
  assert.match(renderNotebook(bigOut, { maxOutputChars: 100 }), /\[output truncated\]/);
});

test('editNotebook: replace updates source (and cell_type when changed)', () => {
  const nb = sampleNb();
  const r = editNotebook(nb, { cell_id: 'c2', new_source: 'z = 3\nprint(z)' });
  assert.equal(r.ok, true);
  assert.deepEqual(nb.cells[1].source, ['z = 3\n', 'print(z)']);
  const r2 = editNotebook(nb, { cell_id: 'c1', new_source: 'code now', cell_type: 'code' });
  assert.equal(r2.ok, true);
  assert.equal(nb.cells[0].cell_type, 'code');
  assert.deepEqual(nb.cells[0].outputs, []);
  assert.equal(r2.ok, true);
  assert.deepEqual(editNotebook(sampleNb(), { cell_id: 'nope', new_source: 'x' }), { ok: false, message: 'No cell with id "nope".' });
  assert.match(editNotebook(sampleNb(), { new_source: 'x' }).message, /cell_id.*required.*replace/);
  assert.match(editNotebook(sampleNb(), { cell_id: 'c1' }).message, /new_source.*required/);
});

test('editNotebook: insert after a cell, at the start, and requires cell_type + new_source', () => {
  const nb = sampleNb();
  const r = editNotebook(nb, { cell_id: 'c1', cell_type: 'code', new_source: 'inserted()', edit_mode: 'insert' });
  assert.equal(r.ok, true);
  assert.equal(nb.cells.length, 4);
  assert.equal(nb.cells[1].cell_type, 'code');
  assert.deepEqual(nb.cells[1].source, ['inserted()']);
  assert.equal(nb.cells[1].execution_count, null);
  const r2 = editNotebook(nb, { cell_type: 'markdown', new_source: 'intro', edit_mode: 'insert' });
  assert.equal(nb.cells[0].cell_type, 'markdown');
  assert.deepEqual(nb.cells[0].source, ['intro']);
  assert.match(editNotebook(sampleNb(), { edit_mode: 'insert', new_source: 'x' }).message, /cell_type.*required/);
  assert.match(editNotebook(sampleNb(), { edit_mode: 'insert', cell_type: 'code' }).message, /new_source.*required/);
  assert.match(editNotebook(sampleNb(), { edit_mode: 'insert', cell_type: 'code', new_source: 'x', cell_id: 'nope' }).message, /No cell with id/);
});

test('editNotebook: delete removes the cell and needs only cell_id', () => {
  const nb = sampleNb();
  const r = editNotebook(nb, { cell_id: 'c2', edit_mode: 'delete' });
  assert.equal(r.ok, true);
  assert.equal(nb.cells.length, 2);
  assert.equal(findCellIndex(nb, 'c2'), -1);
  assert.match(editNotebook(sampleNb(), { edit_mode: 'delete', cell_id: 'nope' }).message, /No cell with id/);
});

// ---- tool-level behaviour -------------------------------------------------------------------------------------
test('NotebookReadTool renders the file and records it as read', () => {
  const dir = tmp(); writeNb(dir);
  const state = createState();
  const tool = NotebookReadTool({ cwd: dir, state });
  const out = tool.call({ notebook_path: 'nb.ipynb' });
  assert.match(out, /Notebook \(python, 3 cells\)/);
  assert.equal(state.readFiles.size, 1);
});

test('NotebookEditTool: requires a prior Read (like Edit), validates before writing, and round-trips through disk', () => {
  const dir = tmp(); const file = writeNb(dir);
  const state = createState();
  const read = NotebookReadTool({ cwd: dir, state });
  const edit = NotebookEditTool({ cwd: dir, state });

  const premature = edit.validateInput({ notebook_path: 'nb.ipynb', cell_id: 'c2', new_source: 'z=9', edit_mode: 'replace' });
  assert.match(premature.message, /has not been read yet/);

  read.call({ notebook_path: 'nb.ipynb' });
  const bad = edit.validateInput({ notebook_path: 'nb.ipynb', cell_id: 'nope', new_source: 'z', edit_mode: 'replace' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /No cell with id/);

  const ok = edit.validateInput({ notebook_path: 'nb.ipynb', cell_id: 'c2', new_source: 'z = 9', edit_mode: 'replace' });
  assert.equal(ok.ok, true);
  const msg = edit.call({ notebook_path: 'nb.ipynb', cell_id: 'c2', new_source: 'z = 9', edit_mode: 'replace' });
  assert.match(msg, /Replaced cell c2/);

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk.cells[1].source, ['z = 9']);
  assert.equal(onDisk.nbformat, 4);                                       // other notebook metadata preserved
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'));

  // the file changed on disk again (we just wrote it) so a second blind edit is fine (we recorded it after writing)
  const again = edit.validateInput({ notebook_path: 'nb.ipynb', cell_id: 'c2', new_source: 'w = 1', edit_mode: 'replace' });
  assert.equal(again.ok, true);
});

test('permissionAlias: NotebookRead/NotebookEdit are governed by Read/Edit path rules, not their own tool name', async () => {
  const dir = tmp(); writeNb(dir);
  const rules = new RuleSet({ cwd: dir }).add('deny', 'Read(nb.ipynb)', 'projectSettings');
  const [nbRead, nbEdit] = createNotebookTools({ cwd: dir, state: createState() });
  const denied = rules.evaluate(nbRead, { notebook_path: 'nb.ipynb' });
  assert.equal(denied.behavior, 'deny');
  assert.equal(denied.source, 'projectSettings');

  const rulesEdit = new RuleSet({ cwd: dir }).add('allow', 'Edit(./nb.ipynb)');
  assert.equal(rulesEdit.evaluate(nbEdit, { notebook_path: 'nb.ipynb' }).behavior, 'allow');
  assert.equal(rulesEdit.evaluate(nbRead, { notebook_path: 'nb.ipynb' }).behavior, undefined);   // Edit rule does not leak into Read
});

test('end to end through a Harness: read then edit a notebook, with the same Read-before-Edit guard as files', async () => {
  const dir = tmp(); writeNb(dir);
  const [nbRead, nbEdit] = createNotebookTools({ cwd: dir, state: createState() });
  let n = 0;
  const model = async () => (++n === 1 ? { content: [{ type: 'tool_use', id: 'u1', name: 'NotebookRead', input: { notebook_path: 'nb.ipynb' } }], stop_reason: 'tool_use' }
    : n === 2 ? { content: [{ type: 'tool_use', id: 'u2', name: 'NotebookEdit', input: { notebook_path: 'nb.ipynb', cell_id: 'c2', new_source: 'done=1', edit_mode: 'replace' } }], stop_reason: 'tool_use' }
    : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' });
  const h = new Harness({ model, tools: [nbRead, nbEdit], rules: new RuleSet({ cwd: dir }), cwd: dir, permissionMode: 'bypassPermissions' });
  await h.run('edit the notebook');
  const results = h.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_result') : []));
  assert.equal(results.length, 2);
  assert.equal(results[1].is_error, undefined);
  assert.match(results[1].content, /Replaced cell c2/);
});
