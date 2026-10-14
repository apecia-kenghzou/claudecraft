#!/usr/bin/env node
// Minimal LSP server over stdio (Content-Length framing) for tests.
import { appendFileSync } from 'node:fs';

const log = (o) => process.env.MOCK_LSP_LOG && appendFileSync(process.env.MOCK_LSP_LOG, `${JSON.stringify(o)}\n`);
const mode = process.env.MOCK_LSP_MODE ?? '';
if (mode === 'crash') { process.stderr.write('fatal: cannot start'); process.exit(9); }

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, headerEnd).toString('ascii'));
    if (!m) { buf = buf.slice(headerEnd + 4); continue; }
    const len = Number(m[1]), bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + len) break;
    const body = buf.slice(bodyStart, bodyStart + len).toString('utf8');
    buf = buf.slice(bodyStart + len);
    let msg; try { msg = JSON.parse(body); } catch { continue; }
    handle(msg);
  }
});

function handle(msg) {
  log({ in: msg.method ?? `response:${msg.id}`, id: msg.id });
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
    return;
  }
  if (msg.method === 'textDocument/didOpen') {
    if (mode === 'diagnostics') {
      setTimeout(() => send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: msg.params.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'mock error' }] } }), 50);
    }
    return;
  }
  if (msg.method === 'textDocument/documentSymbol') {
    send({ jsonrpc: '2.0', id: msg.id, result: [{ name: 'foo', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } }] });
    return;
  }
  if (msg.method === 'textDocument/definition') {
    if (mode === 'no-result') { send({ jsonrpc: '2.0', id: msg.id, result: [] }); return; }
    send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: msg.params.textDocument.uri, range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } } }] });
    return;
  }
  if (msg.method === 'textDocument/references') {
    send({ jsonrpc: '2.0', id: msg.id, result: [
      { uri: msg.params.textDocument.uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
      { uri: msg.params.textDocument.uri, range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } } },
    ] });
    return;
  }
  if (msg.method === 'textDocument/hover') {
    send({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'markdown', value: '```ts\nfunction foo(): void\n```' } } });
    return;
  }
  if (msg.method === 'shutdown') { send({ jsonrpc: '2.0', id: msg.id, result: null }); return; }
  if (msg.method === 'exit') { process.exit(0); }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
}
