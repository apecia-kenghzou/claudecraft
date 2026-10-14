import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  parseRule, formatRule, splitRuleList, bashRuleKind, matchBashContent, splitCommand, hasFileRedirect,
  matchPathContent, isInWorkspace, RuleSet,
} from '../src/permissions.js';
import { Harness, defineTool } from '../src/harness.js';

test('parseRule / formatRule: bare, call, empty and * content, escapes, malformed', () => {
  assert.deepEqual(parseRule('Read'), { toolName: 'Read' });
  assert.deepEqual(parseRule('Bash(git status:*)'), { toolName: 'Bash', ruleContent: 'git status:*' });
  assert.deepEqual(parseRule('Bash()'), { toolName: 'Bash' });
  assert.deepEqual(parseRule('Bash(*)'), { toolName: 'Bash' });
  assert.deepEqual(parseRule('Bash(echo \\(hi\\))'), { toolName: 'Bash', ruleContent: 'echo (hi)' });
  assert.equal(parseRule('Bash(unclosed').malformed, true);
  assert.equal(parseRule('Ba(sh)x').malformed, true);
  const r = { toolName: 'Bash', ruleContent: 'echo (a\\b)' };
  assert.deepEqual(parseRule(formatRule(r)), r);
  assert.deepEqual(splitRuleList('Read, Bash(git log:*,x) ,Edit'), ['Read', 'Bash(git log:*,x)', 'Edit']);
});

test('bash content kinds and matching', () => {
  assert.equal(bashRuleKind('git status:*').type, 'prefix');
  assert.equal(bashRuleKind('npm run *').type, 'wildcard');
  assert.equal(bashRuleKind('echo \\*').type, 'exact');
  assert.equal(bashRuleKind('ls').type, 'exact');
  assert.ok(matchBashContent('git status:*', 'git status'));
  assert.ok(matchBashContent('git status:*', 'git status -s'));
  assert.ok(!matchBashContent('git status:*', 'git statuses'));
  assert.ok(matchBashContent('npm run *', 'npm run build --prod'));
  assert.ok(matchBashContent('git *', 'git'));                      // trailing " *" makes args optional
  assert.ok(!matchBashContent('git *', 'gitk'));
  assert.ok(matchBashContent('ls', '  ls  '));
  assert.ok(!matchBashContent('ls', 'ls -la'));
  assert.ok(matchBashContent('echo \\* *', 'echo * hi'));          // escaped star is a literal inside a wildcard rule
  assert.ok(!matchBashContent('echo \\* *', 'echo x hi'));
  assert.ok(matchBashContent('echo \\*', 'echo \\*'));            // exact rules keep the text as written
  assert.ok(matchBashContent('git   commit *', 'git commit -m x')); // whitespace normalised
});

test('splitCommand: operators, quotes, substitutions', () => {
  assert.deepEqual(splitCommand('a && b || c; d | e').segments, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitCommand('echo "a && b" && ls').segments, ['echo "a && b"', 'ls']);
  assert.equal(splitCommand('echo $(rm -rf /)').unsafe, true);
  assert.equal(splitCommand('echo `id`').unsafe, true);
  assert.equal(splitCommand('echo "unbalanced').unsafe, true);
  assert.deepEqual(splitCommand('make 2>&1 | tee log').segments, ['make 2>&1', 'tee log']);
  assert.equal(hasFileRedirect('echo hi > out.txt'), true);
  assert.equal(hasFileRedirect('echo hi 2>&1'), false);
  assert.equal(hasFileRedirect('cmd > /dev/null'), false);
  assert.equal(hasFileRedirect('echo "a > b"'), false);
});

test('path rules: roots, globs, directories cover children, basename patterns', () => {
  const ctx = { cwd: '/proj/app', root: '/proj', home: '/home/u' };
  assert.ok(matchPathContent('//etc/hosts', '/etc/hosts', ctx));
  assert.ok(matchPathContent('~/.ssh/**', '/home/u/.ssh/id_rsa', ctx));
  assert.ok(matchPathContent('/secrets/**', '/proj/secrets/a/b.txt', ctx));       // root-relative
  assert.ok(matchPathContent('./src/*.js', '/proj/app/src/a.js', ctx));
  assert.ok(!matchPathContent('./src/*.js', '/proj/app/src/deep/a.js', ctx));
  assert.ok(matchPathContent('src/**', '/proj/app/src/deep/a.js', ctx));
  assert.ok(matchPathContent('.env', '/proj/app/sub/.env', ctx));                // bare name matches anywhere
  assert.ok(matchPathContent('*.pem', '/proj/app/keys/a.pem', ctx));
  assert.ok(matchPathContent('./build', '/proj/app/build/out/x.js', ctx));       // dir rule covers children
  assert.ok(!matchPathContent('./build', '/proj/app/builder/x.js', ctx));
  assert.ok(isInWorkspace('/proj/app/a', { cwd: '/proj/app' }));
  assert.ok(!isInWorkspace('/proj/other/a', { cwd: '/proj/app' }));
  assert.ok(isInWorkspace('/proj/other/a', { cwd: '/proj/app', additionalDirectories: ['/proj/other'] }));
});

const bash = defineTool({ name: 'Bash', permissionContent: ({ command }) => ({ kind: 'command', value: command }), call: () => 'ran' });
const read = defineTool({ name: 'Read', isReadOnly: () => true, permissionContent: ({ file_path }) => ({ kind: 'path', value: path.resolve('/proj/app', file_path) }), call: () => 'read' });

test('RuleSet precedence deny > ask > allow, with sources', () => {
  const r = new RuleSet({ cwd: '/proj/app' })
    .add('allow', 'Bash', 'userSettings').add('ask', 'Bash(git push:*)', 'projectSettings').add('deny', 'Bash(git push --force:*)', 'localSettings');
  assert.deepEqual(r.evaluate(bash, { command: 'ls' }), { behavior: 'allow', rule: 'Bash', source: 'userSettings' });
  assert.equal(r.evaluate(bash, { command: 'git push origin' }).behavior, 'ask');
  const d = r.evaluate(bash, { command: 'git push --force origin' });
  assert.equal(d.behavior, 'deny'); assert.equal(d.source, 'localSettings');
});

test('compound commands: deny/ask on ANY part, allow only if ALL parts allowed; substitutions never auto-allowed', () => {
  const r = new RuleSet({ cwd: '/p' }).add('allow', 'Bash(git status:*)').add('allow', 'Bash(ls:*)').add('deny', 'Bash(rm:*)');
  assert.equal(r.evaluate(bash, { command: 'git status && ls -la' }).behavior, 'allow');
  assert.equal(r.evaluate(bash, { command: 'git status && rm -rf /' }).behavior, 'deny');
  assert.equal(r.evaluate(bash, { command: 'git status && curl x' }).behavior, undefined);
  assert.equal(r.evaluate(bash, { command: 'ls $(cat /etc/passwd)' }).behavior, undefined);
  assert.equal(r.evaluate(bash, { command: 'ls > out.txt' }).behavior, undefined);  // redirect escapes a prefix rule
  assert.equal(r.evaluate(bash, { command: 'ls 2>&1' }).behavior, 'allow');
  const exact = new RuleSet({ cwd: '/p' }).add('allow', 'Bash(echo hi > out.txt)');
  assert.equal(exact.evaluate(bash, { command: 'echo hi > out.txt' }).behavior, 'allow');   // exact rule is explicit
});

test('path rules apply to file tools; mcp server-prefix rules match its tools', () => {
  const r = new RuleSet({ cwd: '/proj/app', home: '/h' }).add('deny', 'Read(.env)').add('allow', 'Read(./src/**)');
  assert.equal(r.evaluate(read, { file_path: '.env' }).behavior, 'deny');
  assert.equal(r.evaluate(read, { file_path: 'src/a.js' }).behavior, 'allow');
  assert.equal(r.evaluate(read, { file_path: 'README.md' }).behavior, undefined);
  const m = new RuleSet().add('allow', 'mcp__github');
  assert.equal(m.evaluate({ name: 'mcp__github__create_issue' }, {}).behavior, 'allow');
  assert.equal(m.evaluate({ name: 'mcp__githubx__a' }, {}).behavior, undefined);
  assert.throws(() => new RuleSet().add('allow', 'Bash(oops'), /malformed/);
});

// ---- harness integration ------------------------------------------------------------------------------------
const use = (name, input) => ({ content: [{ type: 'tool_use', id: 'u', name, input }], stop_reason: 'tool_use' });
async function result(h, call) {
  let n = 0;
  h.model = async () => (++n === 1 ? use(...call) : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' });
  await h.run('go');
  return h.messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result').content[0];
}
const mk = (o = {}) => new Harness({ model: null, tools: [bash, read], cwd: '/proj/app', ...o });

test('harness: deny rule beats bypassPermissions and a hook allow; message names rule and source', async () => {
  const rules = new RuleSet({ cwd: '/proj/app' }).add('deny', 'Bash(rm:*)', 'projectSettings');
  const h = mk({ rules, permissionMode: 'bypassPermissions', hooks: { PreToolUse: [() => ({ permission: 'allow' })] } });
  const r = await result(h, ['Bash', { command: 'rm -rf x' }]);
  assert.equal(r.is_error, true);
  assert.match(r.content, /denied by rule Bash\(rm:\*\) \(projectSettings\)/);
});

test('harness: ask rule prompts even in bypass mode and over a hook allow; allow rule skips the prompt', async () => {
  const asked = [];
  const askUser = (q) => { asked.push(q.label); return true; };
  const rules = new RuleSet({ cwd: '/proj/app' }).add('ask', 'Bash(git push:*)').add('allow', 'Bash(ls:*)');
  const h = mk({ rules, permissionMode: 'bypassPermissions', askUser, hooks: { PreToolUse: [() => ({ permission: 'allow' })] } });
  assert.equal((await result(h, ['Bash', { command: 'git push origin' }])).content, 'ran');
  assert.equal(asked.length, 1);
  const h2 = mk({ rules, askUser });
  assert.equal((await result(h2, ['Bash', { command: 'ls -la' }])).content, 'ran');
  assert.equal(asked.length, 1);                                   // no new prompt
});

test('harness: reading outside the working directory asks; additionalDirectories lifts that', async () => {
  const asked = [];
  const askUser = (q) => { asked.push(q.outsideWorkspace); return false; };
  const h = mk({ askUser });
  const r = await result(h, ['Read', { file_path: '/etc/hosts' }]);
  assert.match(r.content, /user denied/);
  assert.deepEqual(asked, [true]);
  const rules = new RuleSet({ cwd: '/proj/app', additionalDirectories: ['/etc'] });
  const h2 = mk({ rules, askUser });
  assert.equal((await result(h2, ['Read', { file_path: '/etc/hosts' }])).content, 'read');
  assert.equal(asked.length, 1);
});

test('harness: answering "always" adds a session allow rule so the next call is silent', async () => {
  let asks = 0;
  const askUser = () => { asks++; return 'always'; };
  const h = mk({ askUser });
  await result(h, ['Bash', { command: 'make build' }]);
  assert.equal(asks, 1);
  assert.deepEqual(h.rules.list().map((r) => [r.behavior, r.rule, r.source]), [['allow', 'Bash(make build)', 'session']]);
  h.messages.length = 0;
  await result(h, ['Bash', { command: 'make build' }]);
  assert.equal(asks, 1);
  // a different command is not covered
  h.messages.length = 0;
  await result(h, ['Bash', { command: 'make deploy' }]);
  assert.equal(asks, 2);
});

test('harness: legacy allow/deny name lists still work', async () => {
  const h = mk({ deny: ['Bash'] });
  assert.match((await result(h, ['Bash', { command: 'ls' }])).content, /denied by policy/);
  const h2 = mk({ allow: ['Bash'] });
  assert.equal((await result(h2, ['Bash', { command: 'make' }])).content, 'ran');
});
