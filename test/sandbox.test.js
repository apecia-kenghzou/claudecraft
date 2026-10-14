import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildProfile, patternToFilters, sandboxOptionsFor, wrapShellCommand, sandboxAvailable, realish, protectedWritePaths,
  buildBwrapArgs, bwrapAvailable, sandboxKind, resolveBwrap,
} from '../src/sandbox.js';
import { RuleSet } from '../src/permissions.js';
import { Harness } from '../src/harness.js';
import { BashTool } from '../src/tools.js';

const AVAILABLE = sandboxAvailable();
const real = (p) => realpathSync(p);
const tmp = (pre = 'rea-sbx-') => real(mkdtempSync(path.join(tmpdir(), pre)));
// a directory that is NOT under the (deliberately writable) temp dirs
const notTmp = () => real(mkdtempSync(path.join(process.cwd(), '.sbx-outside-')));
const sbx = { skip: AVAILABLE ? false : 'Seatbelt (sandbox-exec) not available on this platform' };

function run(command, opts) {
  const w = wrapShellCommand(command, opts);
  const r = spawnSync(w.file, w.args, { cwd: opts.cwd, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

test('profile text: default allow, write confinement, protected paths, network switch', () => {
  const cwd = tmp();
  const p = buildProfile({ cwd, network: 'deny', denyRead: [{ kind: 'subpath', path: '/secret' }], denyWrite: [{ kind: 'literal', path: '/x/y' }] });
  assert.match(p, /^\(version 1\)\n\(allow default\)/);
  assert.match(p, new RegExp(`\\(subpath ${JSON.stringify(cwd).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
  assert.match(p, /\(deny file-write\*\)/);
  assert.match(p, /\(deny file-read\* \(subpath "\/secret"\)\)/);
  assert.match(p, /\(deny file-write\* \(literal "\/x\/y"\)\)/);
  assert.match(p, /\.rea"\)\)/);                     // protected settings directory
  assert.match(p, /\.git\/hooks"\)\)/);
  assert.match(p, /\(deny network\*\)/);
  assert.doesNotMatch(buildProfile({ cwd }), /deny network/);
  assert.ok(protectedWritePaths('/p').some((x) => x.path === '/p/.git/config' && x.kind === 'literal'));
});

test('rule patterns become kernel filters; Read/Edit deny rules feed the sandbox options', () => {
  const ctx = { cwd: '/w/p', home: '/h' };
  assert.deepEqual(patternToFilters('//etc/shadow', ctx), [{ kind: 'subpath', path: realish('/etc/shadow') }]);
  assert.deepEqual(patternToFilters('~/.ssh/**', ctx), [{ kind: 'subpath', path: realish('/h/.ssh') }]);
  assert.deepEqual(patternToFilters('./secrets', ctx), [{ kind: 'subpath', path: realish('/w/p/secrets') }]);
  const bare = patternToFilters('.env', ctx)[0];
  assert.equal(bare.kind, 'regex');
  assert.ok(new RegExp(bare.value).test('/w/p/sub/.env'));
  assert.ok(!new RegExp(bare.value).test('/w/p/sub/.envrc'));
  const glob = patternToFilters('./src/**/*.key', ctx)[0];
  assert.equal(glob.kind, 'regex');
  assert.ok(new RegExp(glob.value).test(`${realish('/w/p')}/src/a/b/c.key`));

  const rules = new RuleSet({ cwd: '/w/p', home: '/h', additionalDirectories: ['/w/shared'] })
    .add('deny', 'Read(.env)').add('deny', 'Edit(./src/**)').add('allow', 'Read(./docs/**)');
  const o = sandboxOptionsFor({ cwd: '/w/p', rules, settings: { network: 'deny', allowWrite: ['out'], denyRead: ['~/.aws'] }, home: '/h' });
  assert.equal(o.network, 'deny');
  assert.equal(o.denyRead.length, 2);               // Read(.env) + ~/.aws
  assert.equal(o.denyWrite.length, 1);               // Edit(./src/**); allow rules are not restrictions
  assert.deepEqual(o.writeRoots, ['out', '/w/shared']);
});

test('real confinement: writes inside succeed; outside, protected paths and interpreter escapes fail', sbx, () => {
  const cwd = tmp(), outside = notTmp();
  mkdirSync(path.join(cwd, '.rea')); mkdirSync(path.join(cwd, '.git', 'hooks'), { recursive: true });
  try {
    assert.equal(run('echo hi > inside.txt && cat inside.txt', { cwd }).out, 'hi');
    assert.equal(run('mkdir -p nested/dir && touch nested/dir/f && ls nested/dir', { cwd }).out, 'f');
    const out = run(`echo x > ${outside}/pwn.txt`, { cwd });
    assert.notEqual(out.code, 0);
    assert.match(out.out, /Operation not permitted/);
    assert.equal(existsSync(path.join(outside, 'pwn.txt')), false);
    // the case path analysis cannot see
    const py = run(`python3 -c "open('${outside}/py.txt','w').write('x')"`, { cwd });
    assert.notEqual(py.code, 0);
    assert.equal(existsSync(path.join(outside, 'py.txt')), false);
    // protected inside the allowed root
    assert.notEqual(run('echo {} > .rea/settings.json', { cwd }).code, 0);
    assert.notEqual(run('echo x > .git/hooks/pre-commit', { cwd }).code, 0);
    assert.notEqual(run('echo x > .git/config', { cwd }).code, 0);
    assert.notEqual(run('rm -rf .rea', { cwd }).code, 0);
    assert.equal(existsSync(path.join(cwd, '.rea')), true);
    // temp dirs and exit codes behave normally
    assert.equal(run('t=$(mktemp) && echo ok > $t && cat $t', { cwd }).out, 'ok');
    assert.equal(run('exit 7', { cwd }).code, 7);
    // extra write roots
    assert.equal(run(`echo y > ${outside}/allowed.txt && cat ${outside}/allowed.txt`, { cwd, writeRoots: [outside] }).out, 'y');
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('real confinement: read denies and write denies from rules, including via symlink', sbx, () => {
  const cwd = tmp();
  mkdirSync(path.join(cwd, 'src')); writeFileSync(path.join(cwd, '.env'), 'TOKEN=abc');
  writeFileSync(path.join(cwd, 'src', 'a.js'), 'orig'); writeFileSync(path.join(cwd, 'ok.txt'), 'fine');
  symlinkSync(path.join(cwd, '.env'), path.join(cwd, 'link.txt'));
  const rules = new RuleSet({ cwd }).add('deny', 'Read(.env)').add('deny', 'Edit(./src/**)');
  const o = { cwd, ...sandboxOptionsFor({ cwd, rules }) };
  try {
    assert.equal(run('cat ok.txt', o).out, 'fine');
    for (const c of ['cat .env', 'cat link.txt', 'python3 -c "print(open(\'.env\').read())"', 'head -c 3 .env']) {
      const r = run(c, o);
      assert.notEqual(r.code, 0, c);
      assert.doesNotMatch(r.out, /TOKEN/, c);
    }
    assert.notEqual(run('echo changed > src/a.js', o).code, 0);
    assert.equal(readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), 'orig');
    assert.equal(run('echo new > src2.txt && cat src2.txt', o).out, 'new');       // unrelated writes still work
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

function runAsync(command, opts) {
  const w = wrapShellCommand(command, opts);
  return new Promise((resolve) => execFile(w.file, w.args, { cwd: opts.cwd, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}`.trim() })));
}

test('real confinement: network can be switched off (localhost stays reachable for local tools)', sbx, async () => {
  const server = http.createServer((_q, res) => res.end('pong'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const cwd = tmp();
  const probe = (host) => `python3 -c "import socket,sys; s=socket.socket(); s.settimeout(3)
try:
    s.connect(('${host}',80)); print('connected')
except Exception as e:
    print(type(e).__name__, e)"`;
  try {
    // a local server answers in both modes
    assert.equal((await runAsync(`curl -s -m 5 --noproxy '*' ${url}`, { cwd, network: 'allow' })).out, 'pong');
    assert.equal((await runAsync(`curl -s -m 5 --noproxy '*' ${url}`, { cwd, network: 'deny' })).out, 'pong');
    // a remote address is refused by the kernel with EPERM when the network is off (not merely unreachable)
    const denied = await runAsync(probe('93.184.216.34'), { cwd, network: 'deny' });
    assert.match(denied.out, /PermissionError.*Operation not permitted/);
    const allowed = await runAsync(probe('93.184.216.34'), { cwd, network: 'allow' });
    assert.doesNotMatch(allowed.out, /Operation not permitted/);       // connected, timed out or unreachable: but not blocked by the sandbox
  } finally { server.close(); rmSync(cwd, { recursive: true, force: true }); }
});

test('BashTool: sandboxed() reflects the switch, commands are wrapped, and failures carry an explanatory hint', sbx, async () => {
  const cwd = tmp(), outside = notTmp();
  let on = false;
  const tool = BashTool({ cwd, sandbox: { active: () => on, options: () => ({ cwd, network: 'allow' }) } });
  try {
    assert.equal(tool.sandboxed({ command: 'ls' }), false);
    assert.equal(await tool.call({ command: `echo x > ${outside}/f` }, {}, undefined), '(no output)');   // unsandboxed: allowed
    on = true;
    assert.equal(tool.sandboxed({ command: 'ls' }), true);
    const out = await tool.call({ command: `echo y > ${outside}/g` }, {}, undefined);
    assert.match(out, /Operation not permitted/);
    assert.match(out, /ran in the OS sandbox: it can only write under the working directory/);
    assert.equal(existsSync(path.join(outside, 'g')), false);
    assert.equal((await tool.call({ command: 'echo fine' }, {}, undefined)).trim(), 'fine');
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

// ---- Linux bubblewrap companion (args are pure/testable on any platform; execution is gated on real bwrap) ----
test('bwrap args: whole tree read-only, roots writable, protected paths pulled back read-only, denied paths hidden', () => {
  const cwd = tmp();
  mkdirSync(path.join(cwd, '.rea')); mkdirSync(path.join(cwd, 'secretdir')); writeFileSync(path.join(cwd, 'secret.txt'), 'x');
  writeFileSync(path.join(cwd, 'locked.txt'), 'y');
  const args = buildBwrapArgs({
    cwd, writeRoots: [], network: 'deny',
    denyRead: [{ kind: 'subpath', path: path.join(cwd, 'secretdir') }, { kind: 'subpath', path: path.join(cwd, 'secret.txt') }],
    denyWrite: [{ kind: 'literal', path: path.join(cwd, 'locked.txt') }],
  });
  assert.deepEqual(args.slice(0, 6), ['--die-with-parent', '--unshare-pid', '--proc', '/proc', '--dev', '/dev']);
  assert.ok(args.includes('--unshare-net'));
  assert.deepEqual(args.slice(args.indexOf('--ro-bind'), args.indexOf('--ro-bind') + 3), ['--ro-bind', '/', '/']);
  const bindIdx = args.indexOf('--bind');
  assert.deepEqual(args.slice(bindIdx, bindIdx + 3), ['--bind', cwd, cwd]);
  // protected .rea/ (always protected) and locked.txt (explicit denyWrite) come back as --ro-bind, after the writable bind
  const roBindIdx = args.indexOf('--ro-bind', bindIdx);
  assert.ok(roBindIdx > bindIdx);
  assert.ok(args.includes(path.join(cwd, '.rea')));
  assert.ok(args.includes(path.join(cwd, 'locked.txt')));
  // denied dir hidden with tmpfs, denied file hidden by binding /dev/null over it
  const tmpfsIdx = args.indexOf('--tmpfs');
  assert.equal(args[tmpfsIdx + 1], path.join(cwd, 'secretdir'));
  const nullIdx = args.indexOf('/dev/null');
  assert.equal(args[nullIdx + 1], path.join(cwd, 'secret.txt'));
  assert.deepEqual(args.slice(-2), ['--chdir', cwd]);
  assert.doesNotMatch(buildBwrapArgs({ cwd }).join(' '), /--unshare-net/);
  rmSync(cwd, { recursive: true, force: true });
});

test('wrapShellCommand(platform: "linux") produces a bwrap invocation regardless of the host platform', () => {
  const cwd = tmp();
  const w = wrapShellCommand('echo hi', { cwd, network: 'allow' }, { platform: 'linux' });
  assert.equal(w.file, resolveBwrap());
  assert.deepEqual(w.args.slice(-3), ['/bin/sh', '-c', 'echo hi']);
  assert.ok(w.args.includes('--die-with-parent'));
  rmSync(cwd, { recursive: true, force: true });
});

test('sandboxKind / sandboxAvailable / bwrapAvailable: platform dispatch', () => {
  assert.equal(sandboxKind('darwin'), 'macOS Seatbelt');
  assert.equal(sandboxKind('linux'), 'Linux bubblewrap');
  assert.equal(sandboxKind('win32'), null);
  assert.equal(bwrapAvailable('darwin'), false);
  assert.equal(sandboxAvailable('win32'), false);
});

const bwrapSbx = { skip: bwrapAvailable() ? false : 'bwrap not available on this platform' };
test('real bubblewrap confinement: writes inside succeed, outside fails, network can be switched off', bwrapSbx, () => {
  const cwd = tmp(), outside = notTmp();
  try {
    assert.equal(run('echo hi > inside.txt && cat inside.txt', { cwd, network: 'allow' }).out, 'hi');
    const out = run(`echo x > ${outside}/pwn.txt`, { cwd, network: 'allow' });
    assert.notEqual(out.code, 0);
    assert.equal(existsSync(path.join(outside, 'pwn.txt')), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

// ---- permission semantics (no kernel needed) -------------------------------------------------------------
const sandboxedBash = (extra = {}) => ({
  name: 'Bash', description: '', inputSchema: { type: 'object', properties: {}, required: [] },
  permissionContent: ({ command }) => ({ kind: 'command', value: command }),
  isReadOnly: () => false, isConcurrencySafe: () => false, isEnabled: () => true, isDestructive: () => false,
  sandboxed: () => true, call: () => 'ran', ...extra,
});
async function permit(opts, command = 'make build') {
  let n = 0; const asked = [];
  const h = new Harness({
    tools: [sandboxedBash()], cwd: '/w/p', rules: opts.rules ?? new RuleSet({ cwd: '/w/p' }),
    permissionMode: opts.mode ?? 'default', sandboxAutoAllow: opts.auto ?? true, hooks: opts.hooks,
    askUser: () => { asked.push(1); return false; },
    model: async () => (++n === 1 ? { content: [{ type: 'tool_use', id: 'u', name: 'Bash', input: { command } }], stop_reason: 'tool_use' } : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }),
  });
  await h.run('go');
  return { out: h.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result').content[0].content, asked: asked.length };
}

test('auto-approve: sandboxed commands skip the prompt; deny/ask rules, hook denials and plan mode still apply', async () => {
  assert.deepEqual(await permit({}), { out: 'ran', asked: 0 });
  assert.deepEqual(await permit({ auto: false }), { out: '<tool_use_error>Permission denied: user denied permission</tool_use_error>', asked: 1 });
  const denied = await permit({ rules: new RuleSet({ cwd: '/w/p' }).add('deny', 'Bash(make:*)') });
  assert.match(denied.out, /denied by rule/);
  const ask = await permit({ rules: new RuleSet({ cwd: '/w/p' }).add('ask', 'Bash(make:*)') });
  assert.equal(ask.asked, 1);
  const plan = await permit({ mode: 'plan' });
  assert.match(plan.out, /plan mode/);
  const hook = await permit({ hooks: { PreToolUse: [() => ({ permission: 'deny', reason: 'no' })] } });
  assert.match(hook.out, /no/);
});
