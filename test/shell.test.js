import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, analyzeCommand, unwrap, splitSimple } from '../src/shell.js';
import { RuleSet, splitCommand } from '../src/permissions.js';
import { Harness, defineTool } from '../src/harness.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CWD = '/w/p', HOME = '/h';
const an = (c) => analyzeCommand(c, { cwd: CWD, home: HOME });
const words = (c) => tokenize(c).commands.map((x) => x.argv.map((w) => w.value));

test('tokenizer: quotes, escapes, operators, comments, assignments', () => {
  assert.deepEqual(words(`echo 'a b' "c d" e\\ f`), [['echo', 'a b', 'c d', 'e f']]);
  assert.deepEqual(words('a && b || c; d | e & f'), [['a'], ['b'], ['c'], ['d'], ['e'], ['f']]);
  assert.deepEqual(words('echo "a && b; c | d" && ls'), [['echo', 'a && b; c | d'], ['ls']]);
  assert.deepEqual(words('ls # trailing comment ; rm -rf /'), [['ls']]);
  assert.deepEqual(words('echo a#b'), [['echo', 'a#b']]);
  const t = tokenize('FOO=1 BAR="x y" cmd arg');
  assert.deepEqual(t.commands[0].assigns, ['FOO=1', 'BAR=x y']);
  assert.deepEqual(t.commands[0].argv.map((w) => w.value), ['cmd', 'arg']);
  assert.equal(tokenize('echo "it\'s"').commands[0].argv[1].value, "it's");
  assert.equal(tokenize("echo 'unbalanced").unsafe.includes('unbalanced-quote'), true);
});

test('tokenizer: structural hazards are reported, not guessed', () => {
  const u = (c) => tokenize(c).unsafe;
  assert.ok(u('echo $(whoami)').includes('command-substitution'));
  assert.ok(u('echo `id`').includes('command-substitution'));
  assert.ok(u('echo "x $(id)"').includes('command-substitution'));
  assert.ok(u('diff <(ls a) <(ls b)').includes('process-substitution'));
  assert.ok(u('(cd /tmp && rm -rf x)').includes('subshell-or-grouping'));
  assert.ok(u('{ ls; rm x; }').includes('grouping'));
  assert.ok(u('for f in *; do rm $f; done').includes('compound-statement'));
  assert.ok(u('$CMD arg').includes('dynamic-command-name'));
  assert.ok(u('PATH=/tmp/evil ls').includes('environment-assignment'));
  assert.ok(u('LD_PRELOAD=/x.so ls').includes('environment-assignment'));
  assert.deepEqual(u("echo 'it'; ls -la"), []);
});

test('redirections: file targets, fd duplication, /dev/null, here-docs and here-strings', () => {
  const a = an('echo hi > out.txt 2>&1');
  assert.deepEqual(a.paths.map((p) => `${p.op}:${p.path}`), ['write:/w/p/out.txt']);
  assert.deepEqual(an('make 2>&1 | tee build.log').paths.map((p) => `${p.op}:${p.path}`), ['write:/w/p/build.log']);
  assert.equal(an('cmd > /dev/null 2>&1').paths.length, 0);
  assert.deepEqual(an('cat < in.txt').paths.map((p) => `${p.op}:${p.path}`), ['read:/w/p/in.txt']);
  assert.deepEqual(an('echo a >> log.txt').paths.map((p) => p.op), ['write']);
  assert.deepEqual(an('cmd &> all.log').paths.map((p) => p.op), ['write']);
  assert.equal(an('cat <<< "text"').paths.length, 0);

  const h = an('cat <<EOF > notes.txt\nline one\nline two\nEOF\nls');
  assert.deepEqual(h.commands.map((c) => c.name), ['cat', 'ls']);
  assert.deepEqual(h.paths.filter((p) => p.op === 'write').map((p) => p.path), ['/w/p/notes.txt']);
  assert.equal(h.unsafe.length, 0);
  assert.ok(an('cat <<EOF\n$(rm -rf /)\nEOF').unsafe.includes('heredoc-expansion'));
  assert.deepEqual(an("cat <<'EOF'\n$(not run)\nEOF").unsafe, []);          // quoted delimiter: literal body
  assert.ok(an('cat <<EOF\nnever closed').unsafe.includes('unterminated-heredoc'));
});

test('wrappers are stripped so the real command is analyzed', () => {
  const real = (c) => unwrap(tokenize(c).commands[0].argv).argv.map((w) => w.value);
  assert.deepEqual(real('time nice -n 5 cat a'), ['cat', 'a']);
  assert.deepEqual(real('env FOO=1 -i cat a'), ['cat', 'a']);
  assert.deepEqual(real('timeout 10 cat a'), ['cat', 'a']);
  assert.deepEqual(real('nohup command ls'), ['ls']);
  assert.deepEqual(an('time cat .env').paths.map((p) => p.path), ['/w/p/.env']);
  assert.deepEqual(an('env -C /etc cat passwd').paths.map((p) => p.path), ['/etc/passwd']);   // env -C changes the directory
});

test('path operands per command: grep/rg patterns, head -n, sed script, find, cp/mv, tee, sort -o, ~ expansion', () => {
  const p = (c) => an(c).paths.map((x) => `${x.op}:${x.path ?? '?'}`);
  assert.deepEqual(p('grep -n foo a.js b.js'), ['read:/w/p/a.js', 'read:/w/p/b.js']);     // "foo" is the pattern, not a path
  assert.deepEqual(p('grep -e foo -f pats.txt src'), ['read:/w/p/pats.txt', 'read:/w/p/src']);
  assert.deepEqual(p('rg TODO'), ['read:/w/p']);                                          // implicit search root
  assert.deepEqual(p('rg -g "*.js" TODO src'), ['read:/w/p/src']);
  assert.deepEqual(p('head -n 5 a.txt'), ['read:/w/p/a.txt']);
  assert.deepEqual(p("sed -n '1,5p' file.txt"), ['read:/w/p/file.txt']);
  assert.deepEqual(p("sed -i 's/a/b/' file.txt"), ['write:/w/p/file.txt']);
  assert.deepEqual(p('find src -name "*.js" -type f'), ['read:/w/p/src']);
  assert.deepEqual(p('find'), ['read:/w/p']);
  assert.deepEqual(p('cp a.txt b.txt'), ['write:/w/p/a.txt', 'write:/w/p/b.txt']);
  assert.deepEqual(p('mkdir -p out/x'), ['create:/w/p/out/x']);
  assert.deepEqual(p('tee a.log'), ['write:/w/p/a.log']);
  assert.deepEqual(p('sort -o sorted.txt in.txt'), ['write:/w/p/sorted.txt', 'read:/w/p/in.txt']);
  assert.deepEqual(p('cat ~/.ssh/id_rsa'), ['read:/h/.ssh/id_rsa']);
  assert.deepEqual(p('cat -- -weird-name'), ['read:/w/p/-weird-name']);
  assert.deepEqual(p('cd sub && cat x'), ['read:/w/p/sub', 'read:/w/p/sub/x']);          // cd is tracked
});

test('read-only classification: allowed shapes and the shapes that must NOT qualify', () => {
  for (const c of ['ls -la', 'cat a b', 'grep -rn foo src | head -20', 'git status', 'git diff HEAD~1', 'git log --oneline -5', 'wc -l *.js'.replace('*.js', 'a.js'),
    'echo hello', 'pwd', 'cd src && ls', 'find . -name "*.js"', 'sort a.txt | uniq', 'git branch --show-current', 'diff a b']) {
    assert.equal(an(c).readOnly, true, c);
  }
  for (const c of ['rm a', 'mv a b', 'touch f', 'echo x > f', 'tee f', 'sed -i s/a/b/ f', "sed 's/a/b/' f", 'awk \'{print}\' f', 'find . -delete', 'find . -exec rm {} ;',
    'find . -fprint out.txt', 'sort -o out in', 'git branch -D x', 'git remote add o u', 'git push', 'git commit -m x', 'git -c core.pager=sh log',
    'git diff --output=patch.txt', 'rg --pre ./evil foo', 'date -s tomorrow', 'curl http://x', 'npm test', 'python3 -c 1', 'env', 'xargs rm',
    'cat $FILE', 'cat *.txt', 'ls $(pwd)', 'echo `id`', 'bash -c "ls"', 'ls; rm x', 'cat a > b', 'uniq in out']) {
    assert.equal(an(c).readOnly, false, c);
  }
});

test('splitCommand (used by rule matching) now comes from the real tokenizer', () => {
  assert.deepEqual(splitCommand('a && b || c; d | e').segments, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitCommand('echo "a && b" && ls').segments, ['echo "a && b"', 'ls']);
  assert.equal(splitCommand('echo $(rm -rf /)').unsafe, true);
  assert.equal(splitCommand('echo "unbalanced').unsafe, true);
  assert.deepEqual(splitCommand('make 2>&1 | tee log').segments, ['make 2>&1', 'tee log']);
  assert.deepEqual(splitSimple('ls -la').segments, ['ls -la']);
});

// ---- integration with permission rules ----------------------------------------------------------------------
const bash = defineTool({ name: 'Bash', permissionContent: ({ command }) => ({ kind: 'command', value: command }), call: () => 'ran' });
const rs = () => new RuleSet({ cwd: CWD, home: HOME });
const verdict = (r, command) => r.evaluate(bash, { command });

test('Read deny rules apply to what Bash reads: cat, grep, redirection, wrappers, cd, ~', () => {
  const r = rs().add('deny', 'Read(.env)', 'projectSettings').add('deny', 'Read(~/.ssh/**)', 'userSettings');
  for (const c of ['cat .env', 'grep SECRET .env', 'cat < .env', 'time cat .env', 'head -n 1 sub/.env', 'cat ~/.ssh/id_rsa', 'cd sub && cat .env', 'ls . && cat ./.env']) {
    const v = verdict(r, c);
    assert.equal(v.behavior, 'deny', c);
    assert.match(v.detail, /reads /);
  }
  assert.equal(verdict(r, 'cat README.md').behavior, undefined);
  assert.equal(verdict(r, 'echo ".env is ignored"').behavior, undefined);        // mentioning a name is not reading it
});

test('Edit/Write deny rules apply to what Bash writes: rm, redirects, tee, sed -i, cp/mv targets', () => {
  const r = rs().add('deny', 'Edit(./src/**)', 'projectSettings').add('deny', 'Write(.git/**)', 'projectSettings');
  for (const c of ['rm src/a.js', 'echo x > src/a.js', 'echo x >> src/deep/b.js', 'tee src/c.js', "sed -i 's/a/b/' src/a.js", 'cp new.js src/a.js', 'mv a src/a', 'touch src/n.js', 'echo x > .git/config']) {
    assert.equal(verdict(r, c).behavior, 'deny', c);
  }
  assert.equal(verdict(r, 'cat src/a.js').behavior, undefined);                   // reading is not writing
  assert.equal(verdict(r, 'rm build/out.js').behavior, undefined);
});

test('ask rules on paths; unresolvable paths ask only when path rules exist', () => {
  const r = rs().add('ask', 'Read(./secrets/**)').add('deny', 'Read(.env)');
  assert.equal(verdict(r, 'cat secrets/key.pem').behavior, 'ask');
  const u = verdict(r, 'cat $FILE');
  assert.equal(u.behavior, 'ask');
  assert.match(u.detail, /cannot be checked/);
  assert.equal(verdict(r, 'cat *.txt').behavior, 'ask');                          // glob could match .env-like names
  assert.equal(verdict(rs().add('allow', 'Bash(cat:*)'), 'cat $FILE').behavior, 'allow');    // an explicit allow rule is the user's choice (no path rules to violate)
  assert.equal(verdict(rs(), 'cat $FILE').behavior, undefined);                     // no rules at all: nothing to violate here
});

test('allow rules still work, but never cover chained or redirected commands, and deny/ask from paths win over allow', () => {
  const r = rs().add('allow', 'Bash(git status:*)').add('allow', 'Bash(cat:*)').add('deny', 'Read(.env)');
  assert.equal(verdict(r, 'git status -s').behavior, 'allow');
  assert.equal(verdict(r, 'git status && cat notes.md').behavior, 'allow');
  assert.equal(verdict(r, 'git status > status.txt').behavior, undefined);          // redirect escapes a prefix rule
  assert.equal(verdict(r, 'cat .env').behavior, 'deny');                           // allow rule does not override a path deny
  assert.equal(verdict(r, 'git status && cat .env').behavior, 'deny');
  assert.equal(verdict(r, 'cat a $(id)').behavior, 'ask');                         // substitution can name any path: ask, never allow
});

// ---- harness behaviour --------------------------------------------------------------------------------------
async function runBash(command, { rules = rs(), mode = 'default', askUser } = {}) {
  let n = 0;
  const asked = [];
  const h = new Harness({
    tools: [defineTool({ name: 'Bash', permissionContent: ({ command: c }) => ({ kind: 'command', value: c }),
      isReadOnly: ({ command: c }) => analyzeCommand(c, { cwd: CWD, home: HOME }).readOnly, call: ({ command: c }) => `ran ${c}` })],
    rules, cwd: CWD, permissionMode: mode,
    askUser: askUser ?? ((q) => { asked.push(q); return false; }),
    model: async () => (++n === 1 ? { content: [{ type: 'tool_use', id: 'u', name: 'Bash', input: { command } }], stop_reason: 'tool_use' }
      : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }),
  });
  await h.run('go');
  const r = h.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result').content[0].content;
  return { out: r, asked };
}

test('harness: workspace-local read-only commands run silently; outside paths, cd+write and unknown paths ask with a reason', async () => {
  assert.equal((await runBash('cat notes.md | head -3')).out, 'ran cat notes.md | head -3');
  assert.equal((await runBash('cat notes.md')).asked.length, 0);

  const outside = await runBash('cat /etc/hosts');
  assert.equal(outside.asked.length, 1);
  assert.match(outside.asked[0].note, /touches \/etc\/hosts, outside the working directories/);

  const dyn = await runBash('cat $SECRET_FILE');
  assert.match(dyn.asked[0].note, /cannot be checked/);

  const cdw = await runBash('cd /tmp && echo hi > out.txt');
  assert.equal(cdw.asked.length, 1);

  const denied = await runBash('cat .env', { rules: rs().add('deny', 'Read(.env)', 'projectSettings') });
  assert.match(denied.out, /denied by rule Read\(\.env\) \(projectSettings\): command reads \/w\/p\/\.env/);
  assert.equal(denied.asked.length, 0);

  // deny wins even in bypass mode (uses a real directory so the recursive check has something to protect)
  const real = mkdtempSync(path.join(tmpdir(), 'rea-sh-h-'));
  mkdirSync(path.join(real, 'src'));
  const byp = await runBash('rm -rf src', { mode: 'bypassPermissions', rules: new RuleSet({ cwd: real, home: HOME }).add('deny', 'Edit(./src/**)') });
  assert.match(byp.out, /denied by rule Edit/);
});


import { ruleOverlapsDirectory } from '../src/permissions.js';

test('recursive operations are checked against what is inside the directory (rm -r, mv, rg, grep -r)', () => {
  const ctx = { cwd: '/w/p', root: '/w/p', home: '/h' };
  assert.equal(ruleOverlapsDirectory('./src/**', '/w/p/src', ctx), true);
  assert.equal(ruleOverlapsDirectory('./src/**', '/w/p', ctx), true);           // parent of the protected area
  assert.equal(ruleOverlapsDirectory('./src/**', '/w/p/docs', ctx), false);
  assert.equal(ruleOverlapsDirectory('.env', '/w/p/docs', ctx), true);          // basename patterns can be anywhere
  assert.equal(ruleOverlapsDirectory('//etc/**', '/w/p', ctx), false);
  assert.equal(ruleOverlapsDirectory('./config/prod.json', '/w/p/config', ctx), true);

  const dir = mkdtempSync(path.join(tmpdir(), 'rea-sh-'));
  mkdirSync(path.join(dir, 'src')); mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'src', 'a.js'), 'x'); writeFileSync(path.join(dir, '.env'), 'S=1');
  const r = new RuleSet({ cwd: dir, home: HOME }).add('deny', 'Edit(./src/**)', 'projectSettings').add('deny', 'Read(.env)', 'projectSettings');
  const v = (c) => r.evaluate(bash, { command: c });
  assert.equal(v('rm -rf src').behavior, 'deny');
  assert.equal(v('rm -rf .').behavior, 'deny');                                  // contains src/
  assert.equal(v('mv src old-src').behavior, 'deny');
  assert.equal(v('rm -rf docs').behavior, undefined);
  assert.equal(v('rm file.txt').behavior, undefined);
  assert.equal(v('rg TODO').behavior, 'ask');                                    // would read .env
  assert.equal(v('rg TODO docs').behavior, 'ask');                               // basename rule could match inside docs
  assert.equal(v('grep -r SECRET .').behavior, 'ask');
  assert.equal(v('grep SECRET docs/a.txt').behavior, undefined);                 // a plain file operand
  assert.equal(v('ls -R').behavior, undefined);                                  // listing names is not reading contents
});


import { symlinkSync, realpathSync } from 'node:fs';

test('a symlink to a protected file is checked by its real path', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'rea-link-')));   // /var -> /private/var on macOS
  writeFileSync(path.join(dir, '.env'), 'S=1');
  symlinkSync(path.join(dir, '.env'), path.join(dir, 'innocent.txt'));
  const r = new RuleSet({ cwd: dir, home: HOME }).add('deny', `Read(/${path.join(dir, '.env')})`, 'projectSettings');   // //abs form
  const v = r.evaluate(bash, { command: 'cat innocent.txt' });
  assert.equal(v.behavior, 'deny');
  assert.match(v.detail, /a link to .*\.env/);
  assert.equal(r.evaluate(bash, { command: 'cat other.txt' }).behavior, undefined);
});
