// MCP (Model Context Protocol) client: stdio and streamable-HTTP transports, tool/resource discovery, tool calls,
// config loading with trust approval. Config shape (`.mcp.json` / `mcpServers`), the `mcp__<server>__<tool>` naming,
// the description cap and the `<invoke>`-markup screen follow the bundle (EVIDENCE.md §12). Client code is original.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from './harness.js';

export const PROTOCOL_VERSION = '2025-06-18';
export const MAX_DESCRIPTION = Number(process.env.REA_MCP_MAX_DESCRIPTION) || 2048;
export const MAX_OUTPUT_CHARS = Number(process.env.REA_MCP_MAX_OUTPUT_CHARS) || 100_000;
const STARTUP_MS = Number(process.env.MCP_TIMEOUT) || 30_000;
const TOOL_MS = Number(process.env.REA_MCP_TOOL_TIMEOUT_MS) || 600_000;

export const normalizeServerName = (n) => n.replace(/[^a-zA-Z0-9_-]/g, '_');
export const mcpToolName = (server, tool) => `mcp__${normalizeServerName(server)}__${tool}`;

export class McpError extends Error {
  constructor(message, { code, kind } = {}) { super(message); this.name = 'McpError'; Object.assign(this, { code, kind }); }
}

// ---- transports ---------------------------------------------------------------------------------------------
class StdioRpc {
  constructor({ command, args = [], env = {}, cwd }) {
    this.spec = { command, args, env, cwd };
    this.nextId = 1; this.pending = new Map(); this.stderr = ''; this.closed = false; this.handlers = {};
  }

  start() {
    const { command, args, env, cwd } = this.spec;
    this.child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.child.stdout.on('data', (b) => {
      buf += b;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line) this.#onLine(line);
      }
    });
    this.child.stderr.on('data', (b) => { this.stderr = (this.stderr + b).slice(-2000); });
    this.child.stdin.on('error', () => {});
    this.exited = new Promise((resolve) => {
      this.child.on('error', (e) => { this.#failAll(new McpError(`could not start "${command}": ${e.message}`, { kind: 'spawn' })); resolve(); });
      this.child.on('close', (code) => {
        this.closed = true;
        this.#failAll(new McpError(`server exited${code === null ? '' : ` with code ${code}`}${this.stderr ? `: ${this.stderr.trim().slice(-300)}` : ''}`, { kind: 'closed' }));
        resolve();
      });
    });
  }

  #onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }                  // ignore non-JSON noise on stdout
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new McpError(msg.error.message ?? 'MCP error', { code: msg.error.code, kind: 'rpc' })); else p.resolve(msg.result);
    } else if (msg.method) {
      if (msg.id !== undefined) this.#serverRequest(msg); else this.handlers.notification?.(msg);
    }
  }

  // Server -> client requests: answer ping and roots, refuse everything else politely.
  #serverRequest(msg) {
    const reply = (o) => this.#write({ jsonrpc: '2.0', id: msg.id, ...o });
    if (msg.method === 'ping') return reply({ result: {} });
    if (msg.method === 'roots/list') return reply({ result: { roots: [] } });
    if (msg.method === 'elicitation/create' && this.handlers.elicit) {
      this.handlers.elicit(msg.params).then((r) => reply({ result: r })).catch((e) => reply({ error: { code: -32000, message: e.message } }));
      return;
    }
    return reply({ error: { code: -32601, message: `client does not support ${msg.method}` } });
  }

  #write(obj) { if (!this.closed) this.child.stdin.write(`${JSON.stringify(obj)}\n`); }
  #failAll(err) { for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(id); } }

  request(method, params, { timeoutMs = STARTUP_MS, signal } = {}) {
    if (this.closed) return Promise.reject(new McpError('server is not running', { kind: 'closed' }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.#write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } });
        reject(new McpError(`${method} timed out after ${timeoutMs}ms`, { kind: 'timeout' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        this.#write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'aborted' } });
        reject(new McpError('aborted', { kind: 'aborted' }));
      }, { once: true });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this.#write({ jsonrpc: '2.0', method, params }); }

  async close() {
    if (this.closed || !this.child) return;
    this.child.stdin.end();
    const killer = setTimeout(() => this.child.kill('SIGTERM'), 500);
    const hard = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await this.exited;
    clearTimeout(killer); clearTimeout(hard);
  }
}

class HttpRpc {
  constructor({ url, headers = {}, fetchImpl = globalThis.fetch }) { this.url = url; this.headers = headers; this.fetchImpl = fetchImpl; this.nextId = 1; this.sessionId = null; this.version = PROTOCOL_VERSION; }
  start() {}
  #headers() {
    return { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': this.version,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}), ...this.headers };
  }

  async request(method, params, { timeoutMs = STARTUP_MS, signal } = {}) {
    const id = this.nextId++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new McpError(`${method} timed out after ${timeoutMs}ms`, { kind: 'timeout' })), timeoutMs);
    signal?.addEventListener('abort', () => ac.abort(new McpError('aborted', { kind: 'aborted' })), { once: true });
    try {
      let res;
      try { res = await this.fetchImpl(this.url, { method: 'POST', headers: this.#headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: ac.signal }); }
      catch (e) { throw ac.signal.reason instanceof McpError ? ac.signal.reason : new McpError(`HTTP request failed: ${e.message}`, { kind: 'network' }); }
      if (!res.ok) throw new McpError(`HTTP ${res.status} from MCP server`, { kind: 'http' });
      const sid = res.headers.get('mcp-session-id'); if (sid) this.sessionId = sid;
      const type = res.headers.get('content-type') ?? '';
      let msg;
      if (type.includes('text/event-stream')) {
        const text = await res.text();
        for (const block of text.split(/\r?\n\r?\n/)) {
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          try { const m = JSON.parse(data); if (m.id === id) { msg = m; break; } } catch { /* skip */ }
        }
      } else msg = await res.json();
      if (!msg) throw new McpError('no response for request in MCP stream', { kind: 'protocol' });
      if (msg.error) throw new McpError(msg.error.message ?? 'MCP error', { code: msg.error.code, kind: 'rpc' });
      return msg.result;
    } finally { clearTimeout(timer); }
  }

  async notify(method, params) {
    try { await this.fetchImpl(this.url, { method: 'POST', headers: this.#headers(), body: JSON.stringify({ jsonrpc: '2.0', method, params }) }); } catch { /* best effort */ }
  }

  async close() {
    if (!this.sessionId) return;
    try { await this.fetchImpl(this.url, { method: 'DELETE', headers: this.#headers() }); } catch { /* best effort */ }
  }
}

// ---- client -----------------------------------------------------------------------------------------------
export class McpClient {
  constructor(name, config, { cwd = process.cwd(), fetchImpl, onElicit } = {}) {
    this.name = name; this.config = config; this.status = 'pending'; this.error = null;
    this.tools = []; this.resources = []; this.capabilities = {}; this.serverInfo = null;
    this.onElicit = onElicit;
    const type = config.type ?? (config.url ? 'http' : 'stdio');
    this.type = type;
    if (type === 'stdio') {
      if (!config.command) throw new McpError(`server "${name}": stdio server needs "command"`, { kind: 'config' });
      this.rpc = new StdioRpc({ command: config.command, args: config.args ?? [], env: config.env ?? {}, cwd });
      // elicitation/create only works over stdio here: it needs a server-initiated request, and the HTTP transport
      // below is request/response only (no SSE listener for server pushes - a known gap, EVIDENCE.md §12/§26).
      if (onElicit) this.rpc.handlers.elicit = (params) => this.#elicit(params);
    } else if (type === 'http' || type === 'streamable-http') {
      if (!config.url) throw new McpError(`server "${name}": http server needs "url"`, { kind: 'config' });
      this.rpc = new HttpRpc({ url: config.url, headers: config.headers ?? {}, fetchImpl });
    } else {
      throw new McpError(`server "${name}": transport "${type}" is not supported (use stdio or http)`, { kind: 'config' });
    }
  }

  async connect({ timeoutMs = STARTUP_MS } = {}) {
    try {
      this.rpc.start();
      const init = await this.rpc.request('initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: this.rpc.handlers?.elicit ? { elicitation: {} } : {}, clientInfo: { name: 'rea', version: '0.9.0' },
      }, { timeoutMs });
      this.capabilities = init.capabilities ?? {};
      this.serverInfo = init.serverInfo ?? null;
      if (this.rpc instanceof HttpRpc && init.protocolVersion) this.rpc.version = init.protocolVersion;
      await this.rpc.notify('notifications/initialized', {});
      if (this.capabilities.tools) this.tools = await this.#list('tools/list', 'tools', timeoutMs);
      if (this.capabilities.resources) this.resources = await this.#list('resources/list', 'resources', timeoutMs).catch(() => []);
      this.status = 'connected';
    } catch (e) {
      this.status = 'failed'; this.error = e.message;
      await this.close().catch(() => {});
      throw e;
    }
    return this;
  }

  /**
   * Handles a server-initiated `elicitation/create` request (EVIDENCE.md §26: the MCP spec's elicitation flow -
   * a server asking the user for input mid-call, params `{message, requestedSchema}`). `mode: "form"` is the only
   * mode implemented; the bundle's "url" mode (opening a browser, e.g. for OAuth-style flows) is a known gap.
   * `onElicit` (injected by the caller, cli.js) decides the response, usually via the Elicitation/ElicitationResult
   * hooks and/or a UI prompt; this method only handles the MCP protocol shape.
   */
  async #elicit(params) {
    const r = await this.onElicit({
      mcp_server_name: this.name, elicitation_id: randomUUID(), mode: 'form',
      message: params?.message, requested_schema: params?.requestedSchema,
    });
    return { action: r.action, ...(r.action === 'accept' && r.content !== undefined ? { content: r.content } : {}) };
  }

  async #list(method, key, timeoutMs) {
    const out = []; let cursor;
    for (let page = 0; page < 50; page++) {
      const r = await this.rpc.request(method, cursor ? { cursor } : {}, { timeoutMs });
      out.push(...(r[key] ?? []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name, args, { signal, timeoutMs = TOOL_MS } = {}) {
    return this.rpc.request('tools/call', { name, arguments: args ?? {} }, { timeoutMs, signal });
  }

  async readResource(uri, { signal, timeoutMs = STARTUP_MS } = {}) {
    return this.rpc.request('resources/read', { uri }, { timeoutMs, signal });
  }

  async close() { this.status = this.status === 'failed' ? 'failed' : 'closed'; await this.rpc.close(); }
}

// ---- result handling and tool wrappers ----------------------------------------------------------------------
export function formatToolResult(result, max = MAX_OUTPUT_CHARS) {
  const parts = [];
  for (const b of result?.content ?? []) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'image') parts.push(`[image: ${b.mimeType ?? 'unknown'}, ${(b.data ?? '').length} base64 chars]`);
    else if (b.type === 'resource') parts.push(b.resource?.text ?? `[resource: ${b.resource?.uri ?? 'unknown'}]`);
    else if (b.type === 'resource_link') parts.push(`[resource link: ${b.uri}]`);
    else parts.push(`[${b.type} content]`);
  }
  if (result?.structuredContent && parts.length === 0) parts.push(JSON.stringify(result.structuredContent));
  let text = parts.join('\n') || '(no output)';
  if (text.length > max) text = `${text.slice(0, max)}\n[output truncated at ${max} characters]`;
  return text;
}

/** Tool metadata is attacker-controlled text that goes into the prompt: drop tools that embed fake tool-call markup. */
export function screenTool(tool) {
  const texts = [tool.description ?? '', ...Object.values(tool.inputSchema?.properties ?? {}).map((p) => p?.description ?? '')];
  const bad = texts.some((t) => /<\/?invoke[\s>]|<\/?function_calls>|<\/?antml:/i.test(t));
  return bad ? 'tool metadata contains tool-call markup' : null;
}

export function wrapTools(client, { warn = () => {}, deferred = false } = {}) {
  const out = [];
  for (const t of client.tools) {
    const why = screenTool(t);
    if (why) { warn(`mcp server "${client.name}": ignoring tool "${t.name}": ${why}`); continue; }
    const desc = (t.description ?? '').slice(0, MAX_DESCRIPTION);
    out.push(defineTool({
      name: mcpToolName(client.name, t.name),
      description: `[MCP server ${client.name}] ${desc}`.trim(),
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      mcp: { server: client.name, tool: t.name },
      deferred,                                       // schema withheld until ToolSearch unlocks it (large tool catalogs)
      isReadOnly: () => false,                       // a server's own hints are not trusted; allow rules decide
      isConcurrencySafe: () => false,
      call: async (input, _ctx, signal) => {
        const r = await client.callTool(t.name, input, { signal });
        const text = formatToolResult(r);
        if (r.isError) throw new Error(text);
        return text;
      },
    }));
  }
  return out;
}

export function createResourceTools(clients) {
  const live = () => clients.filter((c) => c.status === 'connected' && c.capabilities.resources);
  return [
    defineTool({
      name: 'ListMcpResources',
      description: 'List resources exposed by connected MCP servers (optionally for one server).',
      inputSchema: { type: 'object', properties: { server: { type: 'string' } } },
      isReadOnly: () => true, isConcurrencySafe: () => true,
      call: ({ server }) => {
        const rows = live().filter((c) => !server || c.name === server).flatMap((c) => c.resources.map((r) => ({ server: c.name, uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })));
        return rows.length ? JSON.stringify(rows, null, 1) : 'No resources found.';
      },
    }),
    defineTool({
      name: 'ReadMcpResource',
      description: 'Read one resource by URI from a connected MCP server.',
      inputSchema: { type: 'object', required: ['server', 'uri'], properties: { server: { type: 'string' }, uri: { type: 'string' } } },
      isReadOnly: () => true, isConcurrencySafe: () => true,
      validateInput: ({ server }) => (live().some((c) => c.name === server) ? { ok: true } : { ok: false, message: `No connected MCP server with resources named "${server}"` }),
      call: async ({ server, uri }, _c, signal) => {
        const r = await live().find((c) => c.name === server).readResource(uri, { signal });
        return formatToolResult({ content: (r.contents ?? []).map((c) => (c.text !== undefined ? { type: 'text', text: c.text } : { type: 'text', text: `[binary resource ${c.uri}, ${c.mimeType ?? 'unknown type'}]` })) });
      },
    }),
  ];
}

// ---- configuration ----------------------------------------------------------------------------------------
/** `${VAR}` and `${VAR:-default}` expansion in strings, arrays and objects. */
export function expandEnv(value, env = process.env) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, n, d) => env[n] ?? d ?? '');
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)]));
  return value;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new McpError(`${file}: ${e.message}`, { kind: 'config' }); }
}

/**
 * Collect server definitions. `trusted` sources start without asking (user settings, --mcp-config files);
 * project sources (`.mcp.json`, project settings) need approval because they execute commands.
 */
export function loadMcpConfig(cwd, { home = os.homedir(), explicitFiles = [], env = process.env } = {}) {
  const out = new Map();
  const add = (servers, source, trusted) => {
    for (const [name, cfg] of Object.entries(servers ?? {})) out.set(name, { name, config: expandEnv(cfg, env), source, trusted });
  };
  const settings = (file, source, trusted) => { if (existsSync(file)) add(readJson(file).mcpServers, source, trusted); };
  settings(path.join(home, '.rea', 'settings.json'), 'userSettings', true);
  const projMcp = path.join(cwd, '.mcp.json');
  if (existsSync(projMcp)) add(readJson(projMcp).mcpServers, '.mcp.json', false);
  settings(path.join(cwd, '.rea', 'settings.json'), 'projectSettings', false);
  settings(path.join(cwd, '.rea', 'settings.local.json'), 'localSettings', true);
  for (const f of explicitFiles) add(readJson(path.resolve(cwd, f)).mcpServers, `--mcp-config ${f}`, true);
  return [...out.values()];
}

/** Project servers are approved by name in settings.local.json, or wholesale with enableAllProjectMcpServers. */
export function approvedProjectServers(cwd, home = os.homedir()) {
  const f = path.join(cwd, '.rea', 'settings.local.json');
  const s = existsSync(f) ? readJson(f) : {};
  return { all: s.enableAllProjectMcpServers === true, names: new Set(s.enabledMcpjsonServers ?? []) };
}

export async function connectAll(entries, { cwd, timeoutMs = STARTUP_MS, warn = () => {}, onElicit } = {}) {
  const clients = [];
  await Promise.all(entries.map(async (e) => {
    try {
      const c = new McpClient(e.name, e.config, { cwd, onElicit });
      await c.connect({ timeoutMs });
      clients.push(c);
    } catch (err) { warn(`mcp server "${e.name}" failed to start: ${err.message}`); }
  }));
  return clients.sort((a, b) => a.name.localeCompare(b.name));
}
