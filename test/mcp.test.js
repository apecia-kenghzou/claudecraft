import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  McpClient, McpError, mcpToolName, normalizeServerName, formatToolResult, screenTool, wrapTools, createResourceTools,
  expandEnv, loadMcpConfig, approvedProjectServers, connectAll,
} from '../src/mcp.js';
import { Harness } from '../src/harness.js';
import { RuleSet } from '../src/permissions.js';

const SERVER = path.resolve('test/fixtures/mock-mcp-server.mjs');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'rea-mcp-'));
const stdio = (env = {}) => ({ command: process.execPath, args: [SERVER], env });
const connect = async (env, name = 'mock') => new McpClient(name, stdio(env)).connect({ timeoutMs: 5000 });

test('naming: server names are normalized into mcp__<server>__<tool>', () => {
  assert.equal(normalizeServerName('my server.v2'), 'my_server_v2');
  assert.equal(mcpToolName('my server', 'do_it'), 'mcp__my_server__do_it');
});

test('stdio client: initialize handshake, paginated tool list, resources, echo call', async () => {
  const log = path.join(tmp(), 'log.jsonl');
  const c = await connect({ MOCK_MCP_LOG: log });
  try {
    assert.equal(c.status, 'connected');
    assert.equal(c.serverInfo.name, 'mock');
    assert.deepEqual(c.tools.map((t) => t.name), ['echo', 'boom', 'big', 'slow', 'evil', 'ask_user']);   // two pages
    assert.equal(c.resources[0].uri, 'mock://readme');
    const r = await c.callTool('echo', { text: 'hi' });
    assert.equal(formatToolResult(r), 'echo: hi');
    const methods = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).in);
    assert.deepEqual(methods.slice(0, 2), ['initialize', 'notifications/initialized']);   // handshake order
  } finally { await c.close(); }
});

test('server noise on stdout is ignored; server ping requests are answered', async () => {
  const log = path.join(tmp(), 'log.jsonl');
  const c = await connect({ MOCK_MCP_MODE: 'noise' });
  assert.equal(c.tools.length, 6);
  await c.close();
  const c2 = await connect({ MOCK_MCP_MODE: 'ping', MOCK_MCP_LOG: log });
  await c2.close();
  const entries = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.in === 'response' && e.id === 'srv-1'));          // our reply to its ping
});

test('startup failures: crash reports stderr, bad command, bad config, unsupported transport', async () => {
  await assert.rejects(connect({ MOCK_MCP_MODE: 'crash' }), /exited with code 7.*cannot start/);
  await assert.rejects(new McpClient('x', { command: '/no/such/binary' }).connect({ timeoutMs: 3000 }), /could not start/);
  assert.throws(() => new McpClient('x', {}), /needs "command"/);
  assert.throws(() => new McpClient('x', { type: 'ws', url: 'ws://h' }), /not supported/);
  assert.throws(() => new McpClient('x', { type: 'http' }), /needs "url"/);
});

test('tool results: errors, truncation, rpc errors, timeout, abort', async () => {
  const c = await connect();
  try {
    const tools = Object.fromEntries(wrapTools(c).map((t) => [t.name, t]));
    assert.equal(await tools.mcp__mock__echo.call({ text: 'x' }), 'echo: x');
    await assert.rejects(tools.mcp__mock__boom.call({}), /it broke/);                 // isError -> thrown -> tool_use_error
    const big = await tools.mcp__mock__big.call({});
    assert.ok(big.length < 100100 && /output truncated/.test(big));
    await assert.rejects(c.callTool('missing', {}), (e) => e instanceof McpError && e.kind === 'rpc' && e.code === -32602);
    await assert.rejects(c.callTool('slow', {}, { timeoutMs: 80 }), /timed out/);
    const ac = new AbortController();
    const p = c.callTool('slow', {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(p, /aborted/);
    assert.equal(formatToolResult(await c.callTool('echo', { text: 'still alive' })), 'echo: still alive');
  } finally { await c.close(); }
});

test('screenTool drops tool-call markup in metadata; wrapped tools carry naming, caps and no trusted read-only hint', async () => {
  const c = await connect();
  try {
    assert.match(screenTool({ description: 'a <invoke name="x">' }), /markup/);
    assert.equal(screenTool({ description: 'fine', inputSchema: { properties: { a: { description: 'ok' } } } }), null);
    const warns = [];
    const tools = wrapTools(c, { warn: (m) => warns.push(m) });
    assert.deepEqual(tools.map((t) => t.name), ['mcp__mock__echo', 'mcp__mock__boom', 'mcp__mock__big', 'mcp__mock__slow', 'mcp__mock__ask_user']);   // evil dropped
    assert.equal(warns.length, 1);
    assert.equal(tools[0].isReadOnly(), false);
    assert.match(tools[0].description, /^\[MCP server mock\] Echo text back/);
  } finally { await c.close(); }
});

test('resource tools list and read through the right server', async () => {
  const c = await connect();
  try {
    const [list, read] = createResourceTools([c]);
    assert.match(await list.call({}), /mock:\/\/readme/);
    assert.equal(await read.call({ server: 'mock', uri: 'mock://readme' }), 'README CONTENT');
    assert.equal(read.validateInput({ server: 'nope', uri: 'u' }).ok, false);
  } finally { await c.close(); }
});

test('harness: MCP tools go through permissions (ask by default, server-prefix allow rule, deny wins)', async () => {
  const c = await connect();
  try {
    const run = async (rules, askUser, mode = 'default') => {
      let n = 0;
      const h = new Harness({ tools: wrapTools(c), rules, askUser, permissionMode: mode, cwd: '/p',
        model: async () => (++n === 1 ? { content: [{ type: 'tool_use', id: 'u', name: 'mcp__mock__echo', input: { text: 'yo' } }], stop_reason: 'tool_use' } : { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }) });
      await h.run('go');
      return h.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result').content[0].content;
    };
    let asks = 0;
    assert.equal(await run(new RuleSet({ cwd: '/p' }), () => { asks++; return true; }), 'echo: yo');
    assert.equal(asks, 1);
    assert.equal(await run(new RuleSet({ cwd: '/p' }).add('allow', 'mcp__mock'), () => { asks++; return false; }), 'echo: yo');
    assert.equal(asks, 1);
    assert.match(await run(new RuleSet({ cwd: '/p' }).add('allow', 'mcp__mock').add('deny', 'mcp__mock__echo'), null, 'bypassPermissions'), /denied by rule/);
    assert.match(await run(new RuleSet({ cwd: '/p' }), null, 'plan'), /plan mode/);
  } finally { await c.close(); }
});

test('http transport: JSON and SSE responses, session id, notifications', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, session: req.headers['mcp-session-id'], body: body && JSON.parse(body) });
      if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
      const m = JSON.parse(body);
      if (m.id === undefined) { res.writeHead(202); return res.end(); }
      const ok = (result, asSse) => {
        const msg = { jsonrpc: '2.0', id: m.id, result };
        if (asSse) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(`event: message\ndata: ${JSON.stringify(msg)}\n\n`); }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }); res.end(JSON.stringify(msg));
      };
      if (m.method === 'initialize') return ok({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'http-mock' } });
      if (m.method === 'tools/list') return ok({ tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }] }, true);
      if (m.method === 'tools/call') return ok({ content: [{ type: 'text', text: 'pong' }] }, true);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const c = await new McpClient('h', { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { 'x-api': 'k' } }).connect({ timeoutMs: 3000 });
    assert.equal(c.tools[0].name, 'ping');
    assert.equal(formatToolResult(await c.callTool('ping', {})), 'pong');
    await c.close();
    assert.ok(seen.some((s) => s.body?.method === 'tools/list' && s.session === 'sess-1'));
    assert.equal(seen.at(-1).method, 'DELETE');
  } finally { server.close(); }
});

test('config: env expansion, sources, trust, explicit files, approvals; connectAll tolerates failures', async () => {
  assert.deepEqual(expandEnv({ a: '${HOME_X}/bin', b: ['${NOPE:-dflt}', 'plain'] }, { HOME_X: '/h' }), { a: '/h/bin', b: ['dflt', 'plain'] });
  const home = tmp(), cwd = tmp();
  mkdirSync(path.join(home, '.rea'), { recursive: true });
  mkdirSync(path.join(cwd, '.rea'), { recursive: true });
  writeFileSync(path.join(home, '.rea/settings.json'), JSON.stringify({ mcpServers: { user: { command: 'u' } } }));
  writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { proj: { command: 'p', env: { TOKEN: '${T:-none}' } } } }));
  writeFileSync(path.join(cwd, '.rea/settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['proj'], mcpServers: { local: { command: 'l' } } }));
  writeFileSync(path.join(cwd, 'extra.json'), JSON.stringify({ mcpServers: { extra: { command: 'e' } } }));
  const cfg = loadMcpConfig(cwd, { home, explicitFiles: ['extra.json'], env: {} });
  const by = Object.fromEntries(cfg.map((c) => [c.name, c]));
  assert.equal(by.user.trusted, true);
  assert.equal(by.proj.trusted, false);                         // project file: needs approval
  assert.equal(by.proj.config.env.TOKEN, 'none');
  assert.equal(by.local.trusted, true);
  assert.equal(by.extra.trusted, true);
  assert.deepEqual([...approvedProjectServers(cwd).names], ['proj']);
  const warns = [];
  const clients = await connectAll([{ name: 'ok', config: stdio() }, { name: 'bad', config: { command: '/no/such' } }], { cwd, timeoutMs: 3000, warn: (m) => warns.push(m) });
  assert.deepEqual(clients.map((c) => c.name), ['ok']);
  assert.match(warns[0], /"bad" failed to start/);
  await Promise.all(clients.map((c) => c.close()));
});

test('elicitation: a server-initiated elicitation/create is answered via onElicit, over stdio only', async () => {
  const onElicit = async (payload) => {
    assert.equal(payload.mcp_server_name, 'mock');
    assert.equal(payload.mode, 'form');
    assert.equal(payload.message, 'Need input');
    assert.deepEqual(payload.requested_schema.required, ['answer']);
    assert.ok(payload.elicitation_id);
    return { action: 'accept', content: { answer: 'forty-two' } };
  };
  const c = new McpClient('mock', stdio({}), { onElicit });
  await c.connect({ timeoutMs: 5000 });
  try {
    const r = await c.callTool('ask_user', { message: 'Need input' });
    assert.deepEqual(JSON.parse(formatToolResult(r)), { action: 'accept', content: { answer: 'forty-two' } });
  } finally { await c.close(); }
});

test('elicitation: declining omits content; a client with no onElicit does not advertise the capability', async () => {
  const c = new McpClient('mock', stdio({}), { onElicit: async () => ({ action: 'decline' }) });
  await c.connect({ timeoutMs: 5000 });
  try {
    const r = await c.callTool('ask_user', {});
    assert.deepEqual(JSON.parse(formatToolResult(r)), { action: 'decline' });
  } finally { await c.close(); }

  const plain = await connect({});
  try { assert.equal(plain.rpc.handlers.elicit, undefined); } finally { await plain.close(); }
});
