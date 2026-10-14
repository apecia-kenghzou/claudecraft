import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findRepoRoot, createWorktree, removeWorktree, createWorktreeTools, ENTER_WORKTREE, EXIT_WORKTREE, WORKTREE_MAIN_SESSION_ONLY } from '../src/worktree.js';
import { Harness, defineTool } from '../src/harness.js';
import { RuleSet } from '../src/permissions.js';
import { filterTools } from '../src/agents.js';

function initRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rea-wt-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'a@b.c']); run(['config', 'user.name', 'rea']);
  writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  run(['add', '.']); run(['commit', '-q', '-m', 'init']);
  return dir;
}

test('findRepoRoot: null outside a repo, the root inside one', () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'rea-noot-'));
  assert.equal(findRepoRoot(outside), null);
  const repo = initRepo();
  assert.equal(findRepoRoot(repo), execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim());
});

test('createWorktree / removeWorktree: real git plumbing, sibling directory, branch checked out, collision-safe naming', () => {
  const repo = initRepo();
  const a = createWorktree({ repoRoot: repo, branch: 'feature-x' });
  assert.ok(existsSync(a.path));
  assert.equal(path.dirname(a.path), path.join(path.dirname(repo), `${path.basename(repo)}.worktrees`));
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: a.path, encoding: 'utf8' }).trim(), 'feature-x');
  assert.ok(existsSync(path.join(a.path, 'a.txt')));
  // re-entering the same branch name again must not collide with the first worktree's directory
  removeWorktree({ repoRoot: repo, worktreePath: a.path });
  assert.equal(existsSync(a.path), false);
  const list = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
  assert.doesNotMatch(list, new RegExp(a.path));
});

const nextHarness = ({ cwd, isSubAgent = false, activeWorktree = null } = {}) => {
  const h = new Harness({ model: async () => ({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }), tools: [], rules: new RuleSet({ cwd }), cwd });
  h.isSubAgent = isSubAgent; h.activeWorktree = activeWorktree;
  return h;
};

test('EnterWorktree/ExitWorktree tools: validation, cwd switch, hook payloads, nested and sub-agent refusal', async () => {
  const repo = initRepo();
  const hookCalls = [];
  const h = nextHarness({ cwd: repo });
  h.hooks = { WorktreeCreate: [(p) => hookCalls.push(['create', p])], WorktreeRemove: [(p) => hookCalls.push(['remove', p])] };
  const [enter, exit] = createWorktreeTools({ getHarness: () => h });

  assert.equal((await enter.validateInput({ branch: 'bad name!' })).ok, false);
  assert.equal((await exit.validateInput({})).ok, false);                    // not in a worktree yet

  const result = await enter.call({ branch: 'feat/thing' });
  assert.match(result, /Entered worktree at .*feat-thing/);
  assert.notEqual(h.rules.cwd, repo);
  assert.equal(h.activeWorktree.branch, 'feat/thing');
  assert.deepEqual(hookCalls[0][0], 'create');
  assert.equal(hookCalls[0][1].worktreeBranch, 'feat/thing');
  const worktreePath = h.activeWorktree.path;
  assert.ok(existsSync(worktreePath));

  assert.equal((await enter.validateInput({ branch: 'other' })).ok, false);  // already in one: refused, one level deep

  const back = await exit.call({});
  assert.match(back, new RegExp(`Returned to ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(h.rules.cwd, repo);
  assert.equal(h.activeWorktree, null);
  assert.equal(existsSync(worktreePath), false);                            // removed by default
  assert.equal(hookCalls[1][0], 'remove');

  // sub-agents are refused outright
  const sub = nextHarness({ cwd: repo, isSubAgent: true });
  const [subEnter] = createWorktreeTools({ getHarness: () => sub });
  assert.match((await subEnter.validateInput({ branch: 'x' })).message, /Only the main session/);
});

test('ExitWorktree with remove:false keeps the directory and branch', async () => {
  const repo = initRepo();
  const h = nextHarness({ cwd: repo });
  const [enter, exit] = createWorktreeTools({ getHarness: () => h });
  await enter.call({ branch: 'keep-me' });
  const wp = h.activeWorktree.path;
  const msg = await exit.call({ remove: false });
  assert.match(msg, /left at .*keep-me.*for later/);
  assert.equal(existsSync(wp), true);
});

test('worktree tools are excluded from sub-agent tool lists', () => {
  const names = ['Read', ENTER_WORKTREE, EXIT_WORKTREE, 'Agent'].map((name) => ({ name }));
  assert.deepEqual(filterTools(names, { tools: ['*'], disallowedTools: [] }).map((t) => t.name), ['Read']);
  assert.deepEqual(WORKTREE_MAIN_SESSION_ONLY.sort(), [ENTER_WORKTREE, EXIT_WORKTREE].sort());
});

test('live cwd: BashTool follows rules.cwd once EnterWorktree switches it mid-session', async () => {
  const { realpathSync } = await import('node:fs');
  const { BashTool } = await import('../src/tools.js');
  const repo = initRepo();
  const rules = new RuleSet({ cwd: repo });
  const h = new Harness({ model: async () => ({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }), tools: [], rules, cwd: repo });
  const [enter] = createWorktreeTools({ getHarness: () => h });
  const bash = BashTool({ cwd: () => rules.cwd });

  assert.equal((await bash.call({ command: 'pwd' })).trim(), realpathSync(repo));
  await enter.call({ branch: 'moved' });
  assert.equal((await bash.call({ command: 'pwd' })).trim(), realpathSync(h.activeWorktree.path));
});
