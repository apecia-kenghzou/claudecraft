// NotebookRead / NotebookEdit: read and edit Jupyter (.ipynb) notebook cells.
// Tool names, the `notebook_path`/`cell_id`/`new_source`/`cell_type`/`edit_mode` fields, the "replace" default mode,
// the `cell_id ?? `cell-${index}`` fallback for notebooks without cell ids, that NotebookRead/NotebookEdit are
// governed by Read/Edit path rules (not their own tool name), and the "too large" / "not a valid Jupyter notebook"
// error wording all come from the bundle (EVIDENCE.md §22). Parsing, rendering and the edit implementation are
// original since the bundle's own notebook logic was not read function-by-function.
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { defineTool } from './harness.js';
import { staleCheck, record, resolveCwd } from './tools.js';

export const MAX_NOTEBOOK_BYTES = 10 * 1024 * 1024;
export const NOT_VALID_MESSAGE = 'Notebook file is not a valid Jupyter notebook.';
const abs = (cwd, p) => path.resolve(resolveCwd(cwd), p);

const asLines = (source) => (Array.isArray(source) ? source.join('') : String(source ?? ''));
/** Jupyter stores `source` as an array of lines, each (but the last) ending in \n. */
const toSourceArray = (text) => {
  const lines = String(text).split('\n');
  return lines.map((l, i) => (i < lines.length - 1 ? `${l}\n` : l)).filter((l, i) => l !== '' || i < lines.length - 1);
};

export function parseNotebook(filePath) {
  if (!existsSync(filePath)) throw new Error(`Notebook not found: ${filePath}`);
  if (statSync(filePath).size > MAX_NOTEBOOK_BYTES) {
    throw new Error(`Notebook file exceeds the maximum size this tool can read (${(MAX_NOTEBOOK_BYTES / 1e6).toFixed(0)}MB).`);
  }
  let nb;
  try { nb = JSON.parse(readFileSync(filePath, 'utf8')); } catch { throw new Error(NOT_VALID_MESSAGE); }
  if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells)) throw new Error(NOT_VALID_MESSAGE);
  return nb;
}

export function notebookLanguage(nb) {
  return nb.metadata?.kernelspec?.language ?? nb.metadata?.language_info?.name ?? 'python';
}

/** cell_id falls back to a positional id when the notebook predates nbformat cell ids. */
export function cellId(cell, index) { return cell.id ?? `cell-${index}`; }

export function findCellIndex(nb, cell_id) {
  return nb.cells.findIndex((c, i) => cellId(c, i) === cell_id);
}

function outputText(outputs) {
  if (!outputs?.length) return '';
  return outputs.map((o) => {
    if (o.output_type === 'stream') return asLines(o.text);
    if (o.output_type === 'error') return `${o.ename}: ${o.evalue}`;
    const data = o.data?.['text/plain'];
    return data ? asLines(data) : o.data ? `[${Object.keys(o.data).join(', ')} output]` : '';
  }).filter(Boolean).join('\n').trim();
}

export function renderNotebook(nb, { maxOutputChars = 2000 } = {}) {
  const lang = notebookLanguage(nb);
  const parts = [`Notebook (${lang}, ${nb.cells.length} cell${nb.cells.length === 1 ? '' : 's'}):`];
  nb.cells.forEach((cell, i) => {
    const id = cellId(cell, i);
    const source = asLines(cell.source).replace(/\n$/, '');
    parts.push(`\n[cell ${i} ${cell.cell_type} id=${id}]\n${source || '(empty)'}`);
    if (cell.cell_type === 'code') {
      const out = outputText(cell.outputs);
      if (out) parts.push(`--- output ---\n${out.length > maxOutputChars ? `${out.slice(0, maxOutputChars)}\n[output truncated]` : out}`);
    }
  });
  return parts.join('\n');
}

export function editNotebook(nb, { cell_id, new_source, cell_type, edit_mode = 'replace' }) {
  if (edit_mode === 'delete') {
    const i = findCellIndex(nb, cell_id);
    if (i === -1) return { ok: false, message: `No cell with id "${cell_id}".` };
    nb.cells.splice(i, 1);
    return { ok: true, message: `Deleted cell ${cell_id}.` };
  }
  if (edit_mode === 'insert') {
    if (!cell_type) return { ok: false, message: '"cell_type" is required when edit_mode is "insert".' };
    if (new_source === undefined) return { ok: false, message: '"new_source" is required when edit_mode is "insert".' };
    let at = 0;
    if (cell_id !== undefined) {
      const i = findCellIndex(nb, cell_id);
      if (i === -1) return { ok: false, message: `No cell with id "${cell_id}".` };
      at = i + 1;
    }
    const newId = `cell-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    const cell = { id: newId, cell_type, source: toSourceArray(new_source), metadata: {}, ...(cell_type === 'code' ? { execution_count: null, outputs: [] } : {}) };
    nb.cells.splice(at, 0, cell);
    return { ok: true, message: `Inserted a new ${cell_type} cell${cell_id !== undefined ? ` after ${cell_id}` : ' at the start'} (id=${newId}).` };
  }
  // replace
  if (cell_id === undefined) return { ok: false, message: '"cell_id" is required when edit_mode is "replace".' };
  if (new_source === undefined) return { ok: false, message: '"new_source" is required when edit_mode is "replace".' };
  const i = findCellIndex(nb, cell_id);
  if (i === -1) return { ok: false, message: `No cell with id "${cell_id}".` };
  nb.cells[i].source = toSourceArray(new_source);
  if (cell_type && cell_type !== nb.cells[i].cell_type) {
    nb.cells[i].cell_type = cell_type;
    if (cell_type === 'code') { nb.cells[i].execution_count = null; nb.cells[i].outputs = []; }
    else { delete nb.cells[i].execution_count; delete nb.cells[i].outputs; }
  }
  return { ok: true, message: `Replaced cell ${cell_id}.` };
}

export const NotebookReadTool = ({ cwd = process.cwd(), state } = {}) => defineTool({
  name: 'NotebookRead',
  description: 'Read a Jupyter notebook (.ipynb) and show every cell with its id, type and source, plus code-cell output.',
  inputSchema: { type: 'object', required: ['notebook_path'], properties: { notebook_path: { type: 'string' } } },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permissionAlias: 'Read',
  permissionContent: ({ notebook_path }) => ({ kind: 'path', value: abs(cwd, notebook_path) }),
  call: ({ notebook_path }) => {
    const p = abs(cwd, notebook_path);
    const nb = parseNotebook(p);
    if (state) { state.readFiles.set(p, statSync(p).mtimeMs); state.touch?.(p); }
    return renderNotebook(nb);
  },
});

export const NotebookEditTool = ({ cwd = process.cwd(), state } = {}) => defineTool({
  name: 'NotebookEdit',
  description: 'Edit a Jupyter notebook cell. edit_mode: "replace" (default, needs cell_id + new_source), '
    + '"insert" (needs cell_type + new_source; inserted after cell_id, or at the start if cell_id is omitted), '
    + '"delete" (needs cell_id only). Read the notebook first to see cell ids.',
  inputSchema: {
    type: 'object', required: ['notebook_path', 'edit_mode'],
    properties: {
      notebook_path: { type: 'string' }, cell_id: { type: 'string' }, new_source: { type: 'string' },
      cell_type: { type: 'string', enum: ['code', 'markdown'] }, edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
    },
  },
  isEdit: () => true,
  permissionAlias: 'Edit',
  permissionContent: ({ notebook_path }) => ({ kind: 'path', value: abs(cwd, notebook_path) }),
  validateInput: ({ notebook_path, cell_id, new_source, cell_type, edit_mode = 'replace' }) => {
    const p = abs(cwd, notebook_path);
    if (state) {
      const s = staleCheck(cwd, state, notebook_path);
      if (!s.ok) return s;
      if (!s.exists) return { ok: false, message: `Notebook does not exist: ${notebook_path}` };
    }
    let nb;
    try { nb = parseNotebook(p); } catch (e) { return { ok: false, message: e.message }; }
    const probe = editNotebook(structuredClone(nb), { cell_id, new_source, cell_type, edit_mode });
    return probe.ok ? { ok: true } : { ok: false, message: probe.message };
  },
  call: ({ notebook_path, cell_id, new_source, cell_type, edit_mode = 'replace' }) => {
    const p = abs(cwd, notebook_path);
    const nb = parseNotebook(p);
    const r = editNotebook(nb, { cell_id, new_source, cell_type, edit_mode });
    if (!r.ok) throw new Error(r.message);
    writeFileSync(p, `${JSON.stringify(nb, null, 1)}\n`);
    if (state) record(state, p);
    return r.message;
  },
});

export const createNotebookTools = (o = {}) => [NotebookReadTool(o), NotebookEditTool(o)];
