// Built-in tools. Shared `state.readFiles` records files the model has Read, so Edit/Write can refuse
// blind overwrites (Claude Code's Edit prompt: "you MUST use the Read tool first").
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineTool } from './harness.js';
import { grep, glob } from './search.js';

const truncNote = (n) => `\n[truncated at ${n}; use offset/head_limit to page]`;
const MAX_OUTPUT = 30000;
// `cwd` may be a plain string, or a function returning the live directory (used by EnterWorktree to move it mid-session).
export const resolveCwd = (cwd) => (typeof cwd === 'function' ? cwd() : cwd);
const abs = (cwd, p) => path.resolve(resolveCwd(cwd), p);

export const createState = () => {
  const order = [];                       // file paths, least recent first
  return {
    readFiles: new Map(),
    touch(p) { const i = order.indexOf(p); if (i >= 0) order.splice(i, 1); order.push(p); },
    /** Most recently read/written files first (used to re-attach context after compaction). */
    recentFiles(n = 10) { return order.slice(-n).reverse(); },
  };
};

export const GrepTool = ({ cwd = process.cwd() } = {}) => defineTool({
  name: 'Grep',
  description: 'Content search built on ripgrep. Output modes: content, files_with_matches (default), count. '
    + 'Filter with glob or type. head_limit defaults to 250 (0 = unlimited).',
  inputSchema: {
    type: 'object', required: ['pattern'],
    properties: {
      pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, type: { type: 'string' },
      output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      '-A': { type: 'number' }, '-B': { type: 'number' }, '-C': { type: 'number' },
      '-n': { type: 'boolean' }, '-i': { type: 'boolean' }, multiline: { type: 'boolean' },
      head_limit: { type: 'number' }, offset: { type: 'number' },
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permissionContent: (i) => ({ kind: 'path', value: abs(cwd, i.path ?? '.') }),
  call: (i) => {
    const r = grep({
      cwd: resolveCwd(cwd), pattern: i.pattern, path: i.path, glob: i.glob, type: i.type, outputMode: i.output_mode,
      after: i['-A'] ?? 0, before: i['-B'] ?? 0, context: i['-C'], lineNumbers: i['-n'] ?? true,
      ignoreCase: i['-i'], multiline: i.multiline, headLimit: i.head_limit ?? 250, offset: i.offset ?? 0,
    });
    if (!r.lines.length) return 'No matches found';
    return r.lines.join('\n') + (r.truncated ? truncNote(r.appliedLimit) : '');
  },
});

export const GlobTool = ({ cwd = process.cwd() } = {}) => defineTool({
  name: 'Glob',
  description: 'Fast file pattern matching. Supports "**/*.js". Returns paths sorted by modification time.',
  inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string' } } },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permissionContent: (i) => ({ kind: 'path', value: abs(cwd, i.path ?? '.') }),
  call: (i) => {
    const r = glob({ cwd: resolveCwd(cwd), pattern: i.pattern, path: i.path });
    if (!r.files.length) return 'No files found';
    return r.files.join('\n') + (r.truncated ? '\n[truncated; refine the pattern]' : '');
  },
});

export const ReadTool = ({ cwd = process.cwd(), state = createState() } = {}) => defineTool({
  name: 'Read',
  description: 'Read a file; returns cat -n style numbered lines. Use offset/limit for large files.',
  inputSchema: {
    type: 'object', required: ['file_path'],
    properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  permissionContent: ({ file_path }) => ({ kind: 'path', value: abs(cwd, file_path) }),
  call: ({ file_path, offset = 0, limit = 2000 }) => {
    const p = abs(cwd, file_path);
    const text = readFileSync(p, 'utf8');
    state.readFiles.set(p, statSync(p).mtimeMs);
    state.touch?.(p);
    const lines = text.split('\n');
    return lines.slice(offset, offset + limit).map((l, i) => `${offset + i + 1}\t${l}`).join('\n');
  },
});

// A file may be modified only if it was Read and has not changed on disk since.
export function staleCheck(cwd, state, file_path) {
  const p = abs(cwd, file_path);
  if (!existsSync(p)) return { ok: true, p, exists: false };
  const seen = state.readFiles.get(p);
  if (seen === undefined) return { ok: false, message: `File has not been read yet. Read ${file_path} first before modifying it.`, remedy: 'read_first' };
  if (statSync(p).mtimeMs > seen) return { ok: false, message: `File ${file_path} has been modified since it was read. Read it again.`, remedy: 'read_again' };
  return { ok: true, p, exists: true };
}

export const record = (state, p) => { state.readFiles.set(p, statSync(p).mtimeMs); state.touch?.(p); };

export const WriteTool = ({ cwd = process.cwd(), state = createState() } = {}) => defineTool({
  name: 'Write',
  description: 'Write a file, overwriting it. An existing file must have been Read first.',
  inputSchema: { type: 'object', required: ['file_path', 'content'], properties: { file_path: { type: 'string' }, content: { type: 'string' } } },
  isEdit: () => true,
  permissionContent: ({ file_path }) => ({ kind: 'path', value: abs(cwd, file_path) }),
  validateInput: ({ file_path }) => staleCheck(cwd, state, file_path),
  call: ({ file_path, content }) => {
    const p = abs(cwd, file_path);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    record(state, p);
    return `Wrote ${content.length} bytes to ${file_path}`;
  },
});

export const EditTool = ({ cwd = process.cwd(), state = createState() } = {}) => defineTool({
  name: 'Edit',
  description: 'Exact string replacement in a file. old_string must be unique unless replace_all is true. Read the file first.',
  inputSchema: {
    type: 'object', required: ['file_path', 'old_string', 'new_string'],
    properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
  },
  isEdit: () => true,
  permissionContent: ({ file_path }) => ({ kind: 'path', value: abs(cwd, file_path) }),
  validateInput: ({ file_path, old_string, new_string, replace_all }) => {
    if (old_string === new_string) return { ok: false, message: 'old_string and new_string are identical; nothing to change.' };
    const s = staleCheck(cwd, state, file_path);
    if (!s.ok) return s;
    if (!s.exists) return { ok: false, message: `File does not exist: ${file_path}` };
    const text = readFileSync(s.p, 'utf8');
    const n = text.split(old_string).length - 1;
    if (n === 0) return { ok: false, message: `String to replace not found in ${file_path}.` };
    if (n > 1 && !replace_all) return { ok: false, message: `Found ${n} matches of old_string; add context to make it unique or set replace_all.` };
    return { ok: true };
  },
  call: ({ file_path, old_string, new_string, replace_all }) => {
    const p = abs(cwd, file_path);
    const text = readFileSync(p, 'utf8');
    const out = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
    writeFileSync(p, out);
    record(state, p);
    return `Edited ${file_path}`;
  },
});

import { analyzeCommand } from './shell.js';
import { wrapShellCommand } from './sandbox.js';

/** Read-only means: every simple command is recognized, cannot write or execute, and nothing is redirected to a file. */
export function isReadOnlyCommand(cmd, opts = {}) {
  return analyzeCommand(cmd, opts).readOnly;
}

export const BashTool = ({ cwd = process.cwd(), sandbox } = {}) => defineTool({
  name: 'Bash',
  description: 'Run a shell command in the working directory. Output is truncated at 30000 characters. Default timeout 120000ms (max 600000).',
  inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' }, timeout: { type: 'number' } } },
  permissionContent: ({ command }) => ({ kind: 'command', value: command }),
  isReadOnly: ({ command }) => isReadOnlyCommand(command, { cwd: resolveCwd(cwd) }),
  isConcurrencySafe: ({ command }) => isReadOnlyCommand(command, { cwd: resolveCwd(cwd) }),
  /** True when this command will run inside the OS sandbox (the permission layer may then auto-approve it). */
  sandboxed: () => Boolean(sandbox?.active?.()),
  isDestructive: ({ command }) => /\brm\b|\bmv\b|git\s+(reset|clean|push)/.test(command),
  call: ({ command, timeout = 120000 }, _ctx, signal) => new Promise((resolve, reject) => {
    const ms = Math.min(Math.max(timeout, 1), 600000);
    const useSandbox = Boolean(sandbox?.active?.());
    const wrapped = useSandbox ? wrapShellCommand(command, sandbox.options()) : { file: '/bin/sh', args: ['-c', command] };
    const child = spawn(wrapped.file, wrapped.args, { cwd: resolveCwd(cwd), signal });
    let out = '', timedOut = false;
    const collect = (b) => { if (out.length < MAX_OUTPUT * 2) out += b; };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, ms);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n[output truncated]` : out;
      if (timedOut) return resolve(`${body}\n[command timed out after ${ms}ms]`);
      const hint = useSandbox && code !== 0 && /Operation not permitted|not permitted|denied/i.test(body)
        ? `\n[This command ran in the OS sandbox: it can only write under the working directory and temp dirs${sandbox.options().network === 'deny' ? ', and has no network access' : ''}. Protected paths such as .rea/ and .git/hooks are read-only.]` : '';
      resolve((code === 0 ? (body || '(no output)') : `${body}\n[exit code ${code}]`) + hint);
    });
  }),
});

export function defaultTools({ cwd = process.cwd(), state = createState(), sandbox } = {}) {
  const o = { cwd, state };
  return [GrepTool(o), GlobTool(o), ReadTool(o), EditTool(o), WriteTool(o), BashTool({ ...o, sandbox })];
}
