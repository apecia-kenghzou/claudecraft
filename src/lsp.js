// LSP (Language Server Protocol) client: definitions, references, hover and document symbols.
// Tool name and scope ("code intelligence (definitions, references, symbols, hover)") come from the bundle's tool
// `searchHint` string (EVIDENCE.md §21); the wire protocol is the public LSP spec, and everything else here
// (server registry, symbol-based position resolution, diagnostics capture, result formatting) is original.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { defineTool } from './harness.js';

export class LspError extends Error {
  constructor(message, { kind } = {}) { super(message); this.name = 'LspError'; this.kind = kind; }
}

// ---- wire protocol: `Content-Length: N\r\n\r\n<json>`, byte length of the UTF-8 body --------------------------
class LspConnection {
  constructor({ command, args = [], cwd, env }) {
    this.spec = { command, args, cwd, env };
    this.nextId = 1; this.pending = new Map(); this.diagnostics = new Map(); this.openDocs = new Set();
    this.closed = false; this.stderr = '';
  }

  start() {
    const { command, args, cwd, env } = this.spec;
    this.child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = Buffer.alloc(0);
    this.child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const header = buf.slice(0, headerEnd).toString('ascii');
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) { buf = buf.slice(headerEnd + 4); continue; }         // malformed header: drop and resync
        const len = Number(m[1]), bodyStart = headerEnd + 4;
        if (buf.length < bodyStart + len) break;                       // wait for the rest of the body
        const body = buf.slice(bodyStart, bodyStart + len).toString('utf8');
        buf = buf.slice(bodyStart + len);
        this.#onMessage(body);
      }
    });
    this.child.stderr.on('data', (b) => { this.stderr = (this.stderr + b).slice(-2000); });
    this.child.stdin.on('error', () => {});
    this.exited = new Promise((resolve) => {
      this.child.on('error', (e) => { this.#failAll(new LspError(`could not start "${command}": ${e.message}`, { kind: 'spawn' })); resolve(); });
      this.child.on('close', (code) => {
        this.closed = true;
        this.#failAll(new LspError(`server exited${code === null ? '' : ` with code ${code}`}${this.stderr ? `: ${this.stderr.trim().slice(-300)}` : ''}`, { kind: 'closed' }));
        resolve();
      });
    });
  }

  #onMessage(body) {
    let msg; try { msg = JSON.parse(body); } catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new LspError(msg.error.message ?? 'LSP error', { kind: 'rpc' })); else p.resolve(msg.result);
    } else if (msg.method === 'textDocument/publishDiagnostics') {
      this.diagnostics.set(msg.params.uri, msg.params.diagnostics ?? []);
    } else if (msg.method && msg.id !== undefined) {
      this.#write({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'workspace/configuration' ? [] : null });   // answer politely, do nothing
    }
  }

  #write(obj) {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  #failAll(err) { for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(id); } }

  request(method, params, { timeoutMs = 15000 } = {}) {
    if (this.closed) return Promise.reject(new LspError('server is not running', { kind: 'closed' }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new LspError(`${method} timed out after ${timeoutMs}ms`, { kind: 'timeout' })); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this.#write({ jsonrpc: '2.0', method, params }); }

  async initialize(rootUri) {
    const init = await this.request('initialize', {
      processId: process.pid, rootUri, capabilities: { textDocument: { synchronization: { didSave: true } } },
      workspaceFolders: [{ uri: rootUri, name: path.basename(fileURLToPath(rootUri)) }],
    }, { timeoutMs: 30000 });
    this.notify('initialized', {});
    return init;
  }

  /** Open (or re-sync) a document so position-based queries see current content. Waits briefly for diagnostics. */
  async open(uri, languageId, text) {
    if (this.openDocs.has(uri)) { this.notify('textDocument/didClose', { textDocument: { uri } }); }
    this.openDocs.add(uri);
    this.diagnostics.delete(uri);
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    await new Promise((r) => setTimeout(r, 300));           // give the server a moment to analyze and publish diagnostics
  }

  async close() {
    if (this.closed) return;
    try { await this.request('shutdown', null, { timeoutMs: 3000 }); this.notify('exit', null); } catch { /* best effort */ }
    const killer = setTimeout(() => this.child?.kill('SIGTERM'), 500);
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2000))]);
    clearTimeout(killer);
  }
}

// ---- language server registry (overridable) --------------------------------------------------------------------
export const DEFAULT_SERVERS = {
  '.rs': { command: 'rust-analyzer', args: [] },
  '.c': { command: 'clangd', args: [] }, '.h': { command: 'clangd', args: [] },
  '.cpp': { command: 'clangd', args: [] }, '.cc': { command: 'clangd', args: [] }, '.hpp': { command: 'clangd', args: [] },
  '.ts': { command: 'typescript-language-server', args: ['--stdio'] }, '.tsx': { command: 'typescript-language-server', args: ['--stdio'] },
  '.js': { command: 'typescript-language-server', args: ['--stdio'] }, '.jsx': { command: 'typescript-language-server', args: ['--stdio'] },
  '.py': { command: 'pylsp', args: [] },
  '.go': { command: 'gopls', args: ['serve'] },
};
const LANGUAGE_ID = { '.rs': 'rust', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.py': 'python', '.go': 'go' };

export function serverForFile(filePath, servers = DEFAULT_SERVERS) {
  return servers[path.extname(filePath).toLowerCase()];
}

// ---- position resolution: model gives a line + symbol text, not a UTF-16 column it would have to guess -------
/** Find the 0-based LSP character offset of `symbol` on `lineText`, preferring a whole-word match. */
export function resolveColumn(lineText, symbol, occurrence = 1) {
  const re = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  let n = 0, m;
  while ((m = re.exec(lineText))) { if (++n === occurrence) return m.index; }
  return null;   // no silent substring fallback: a near-miss should surface as "not found", not a wrong position
}

function locationsToText(locs, { cwd }) {
  const arr = [].concat(locs ?? []).map((l) => l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l);
  if (!arr.length) return null;
  return arr.map((l) => {
    const file = fileURLToPath(l.uri);
    const rel = path.relative(cwd, file) || file;
    const line = l.range.start.line + 1;
    let snippet = '';
    try { snippet = readFileSync(file, 'utf8').split('\n')[l.range.start.line]?.trim() ?? ''; } catch { /* unreadable */ }
    return `${rel}:${line}${snippet ? `: ${snippet}` : ''}`;
  }).join('\n');
}

function hoverToText(hover) {
  if (!hover?.contents) return null;
  const c = hover.contents;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x.value)).join('\n\n');
  return c.value ?? null;
}

function symbolsToText(symbols, depth = 0) {
  if (!symbols?.length) return null;
  return symbols.map((s) => {
    const kind = SYMBOL_KINDS[s.kind] ?? `kind ${s.kind}`;
    const range = s.range ?? s.location?.range;
    const line = (range?.start.line ?? 0) + 1;
    const head = `${'  '.repeat(depth)}${s.name} (${kind}) :${line}`;
    const children = s.children?.length ? symbolsToText(s.children, depth + 1) : null;
    return children ? `${head}\n${children}` : head;
  }).join('\n');
}
const SYMBOL_KINDS = { 5: 'class', 6: 'method', 9: 'constructor', 12: 'function', 13: 'variable', 11: 'interface', 23: 'struct', 10: 'enum' };

function diagnosticsToText(diags) {
  if (!diags?.length) return null;
  const sev = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
  return diags.map((d) => `${sev[d.severity] ?? 'note'} ${d.range.start.line + 1}:${d.range.start.character + 1}: ${d.message}`).join('\n');
}

// ---- tool ---------------------------------------------------------------------------------------------------
export function createLspTool({ cwd = process.cwd(), servers = DEFAULT_SERVERS, warn = () => {} } = {}) {
  try { cwd = realpathSync(cwd); } catch { /* keep as given if it does not exist yet */ }
  const connections = new Map();   // command key -> { conn, ready }

  async function connectionFor(ext) {
    const spec = servers[ext];
    if (!spec) throw new LspError(`No language server is configured for "${ext}" files.`);
    const key = `${spec.command} ${spec.args.join(' ')}`;
    if (!connections.has(key)) {
      const conn = new LspConnection({ command: spec.command, args: spec.args, cwd, env: spec.env });
      const ready = (async () => {
        conn.start();
        try { await conn.initialize(pathToFileURL(`${cwd}/`).toString()); }
        catch (e) { connections.delete(key); throw new LspError(`${spec.command}: ${e.message}`, { kind: e.kind }); }
      })();
      connections.set(key, { conn, ready });
    }
    const entry = connections.get(key);
    await entry.ready;
    return entry.conn;
  }

  async function withOpenDoc(filePath) {
    const abs = path.resolve(cwd, filePath);
    if (!existsSync(abs)) throw new LspError(`File not found: ${filePath}`);
    const ext = path.extname(abs).toLowerCase();
    const conn = await connectionFor(ext);
    const uri = pathToFileURL(abs).toString();
    const text = readFileSync(abs, 'utf8');
    await conn.open(uri, LANGUAGE_ID[ext] ?? 'plaintext', text);
    return { conn, uri, text };
  }

  function positionFor(text, { line, character, symbol }) {
    if (!Number.isInteger(line) || line < 1) throw new LspError('"line" must be a positive integer (1-based).');
    const lineText = text.split('\n')[line - 1];
    if (lineText === undefined) throw new LspError(`Line ${line} is past the end of the file.`);
    // Prefer "symbol": it's verified against the real line text, whereas a model-supplied "character" is an unchecked
    // guess (and models reliably send both, with "character" left at a meaningless default like 0 or 1).
    if (symbol) {
      const col = resolveColumn(lineText, symbol);
      if (col === null) throw new LspError(`"${symbol}" was not found on line ${line}.`);
      return { line: line - 1, character: col };
    }
    if (character !== undefined && character >= 1) return { line: line - 1, character: character - 1 };
    throw new LspError('Provide either "symbol" (the identifier text on that line) or a 1-based "character".');
  }

  const tool = defineTool({
    name: 'LSP',
    description: 'Code intelligence via a language server: find where a symbol is defined, find its references, show its type/'
      + 'documentation (hover), or list the symbols in a file. Identify a position with "line" (1-based) plus either "symbol" '
      + '(the exact identifier text on that line) or a 1-based "character". Needs the matching language server installed '
      + '(rust-analyzer, clangd, typescript-language-server, pylsp, gopls, ...).',
    inputSchema: {
      type: 'object', required: ['action', 'file_path'],
      properties: {
        action: { type: 'string', enum: ['definition', 'typeDefinition', 'references', 'hover', 'documentSymbol'] },
        file_path: { type: 'string' }, line: { type: 'number' }, symbol: { type: 'string' }, character: { type: 'number' },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    validateInput: ({ action, file_path }) => {
      if (action !== 'documentSymbol' && serverForFile(file_path, servers) === undefined) {
        return { ok: false, message: `No language server configured for "${path.extname(file_path) || '(no extension)'}". Configured: ${Object.keys(servers).join(', ')}` };
      }
      return { ok: true };
    },
    async call({ action, file_path, line, symbol, character }) {
      const { conn, uri, text } = await withOpenDoc(file_path);
      const diags = diagnosticsToText(conn.diagnostics.get(uri));
      const diagNote = diags ? `\n\nDiagnostics for ${file_path}:\n${diags}` : '';

      if (action === 'documentSymbol') {
        const symbols = await conn.request('textDocument/documentSymbol', { textDocument: { uri } });
        return (symbolsToText(symbols) ?? `No symbols found in ${file_path}.`) + diagNote;
      }
      const position = positionFor(text, { line, symbol, character });
      if (action === 'hover') {
        const hover = await conn.request('textDocument/hover', { textDocument: { uri }, position });
        return (hoverToText(hover) ?? `No hover information at ${file_path}:${line}.`) + diagNote;
      }
      const method = { definition: 'textDocument/definition', typeDefinition: 'textDocument/typeDefinition', references: 'textDocument/references' }[action];
      const params = { textDocument: { uri }, position, ...(action === 'references' ? { context: { includeDeclaration: true } } : {}) };
      const result = await conn.request(method, params);
      return (locationsToText(result, { cwd }) ?? `No ${action} found for "${symbol ?? `col ${character}`}" at ${file_path}:${line}.`) + diagNote;
    },
  });
  tool.close = () => Promise.all([...connections.values()].map((e) => e.conn.close().catch(() => {})));
  tool.status = () => [...connections.entries()].map(([key, e]) => ({ server: key, running: !e.conn.closed }));
  return tool;
}
