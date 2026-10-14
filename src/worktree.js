// EnterWorktree / ExitWorktree: isolate edits in a separate git worktree and checked-out branch, then return.
// Tool names, hints and hook payload shape follow the bundle (EVIDENCE.md §20 — "create an isolated git worktree and
// switch into it" / "exit a worktree session and return to the original directory"; `WorktreeCreate` hook gives
// `worktreePath`/`worktreeBranch`). Git plumbing, worktree placement and the one-level-deep restriction are original.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { defineTool } from './harness.js';

export const ENTER_WORKTREE = 'EnterWorktree';
export const EXIT_WORKTREE = 'ExitWorktree';
/** Tools a sub-agent must never receive: they move the shared session's working directory. */
export const WORKTREE_MAIN_SESSION_ONLY = [ENTER_WORKTREE, EXIT_WORKTREE];

class GitError extends Error {}

function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { throw new GitError((e.stderr ?? '').toString().trim() || e.message); }
}

export function findRepoRoot(cwd) { try { return git(['rev-parse', '--show-toplevel'], cwd); } catch { return null; } }

const slugify = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'work';
const branchExists = (repoRoot, branch) => Boolean(git(['branch', '--list', branch], repoRoot));

/** Create a sibling worktree (`<repo>.worktrees/<branch>`, numbered on collision) and check out `branch`. */
export function createWorktree({ repoRoot, branch, baseRef }) {
  const dir = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}.worktrees`);
  mkdirSync(dir, { recursive: true });
  let target = path.join(dir, slugify(branch));
  for (let n = 2; existsSync(target); n++) target = path.join(dir, `${slugify(branch)}-${n}`);
  const args = branchExists(repoRoot, branch)
    ? ['worktree', 'add', target, branch]
    : ['worktree', 'add', '-b', branch, target, ...(baseRef ? [baseRef] : [])];
  git(args, repoRoot);
  return { path: target, branch };
}

export function removeWorktree({ repoRoot, worktreePath, force = true }) {
  git(['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], repoRoot);
  try { git(['worktree', 'prune'], repoRoot); } catch { /* best effort */ }
}

export function createWorktreeTools({ getHarness }) {
  const enter = defineTool({
    name: ENTER_WORKTREE,
    description: 'Create an isolated git worktree on a new (or existing) branch and switch the session into it, so edits '
      + "and commands run there instead of the main checkout. Call ExitWorktree to return. Main session only; one level deep.",
    inputSchema: { type: 'object', required: ['branch'], properties: { branch: { type: 'string' }, base_ref: { type: 'string' } } },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    validateInput: ({ branch }) => {
      const h = getHarness();
      if (h.isSubAgent) return { ok: false, message: 'Only the main session can use worktrees.' };
      if (h.activeWorktree) return { ok: false, message: `Already in a worktree (${h.activeWorktree.path}); call ExitWorktree first.` };
      if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return { ok: false, message: `"${branch}" is not a valid branch name.` };
      if (!findRepoRoot(h.rules.cwd)) return { ok: false, message: `Not inside a git repository: ${h.rules.cwd}` };
      return { ok: true };
    },
    call: async ({ branch, base_ref }) => {
      const h = getHarness();
      const repoRoot = findRepoRoot(h.rules.cwd);
      let created;
      try { created = createWorktree({ repoRoot, branch, baseRef: base_ref }); }
      catch (e) { throw new Error(`git worktree add failed: ${e.message}`); }
      const originalCwd = h.rules.cwd;
      h.activeWorktree = { path: created.path, branch: created.branch, originalCwd };
      h.rules.cwd = created.path; h.rules.root = created.path;
      await h.emitHook('WorktreeCreate', { worktreePath: created.path, worktreeBranch: created.branch });
      return `Entered worktree at ${created.path} on branch "${created.branch}" (based on ${base_ref ?? 'HEAD'}). `
        + `Files and commands now operate here, not in ${originalCwd}. Call ExitWorktree when done.`;
    },
  });

  const exit = defineTool({
    name: EXIT_WORKTREE,
    description: 'Leave the current worktree and return to the original working directory. By default the worktree is removed.',
    inputSchema: { type: 'object', properties: { remove: { type: 'boolean' } } },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    validateInput: () => {
      const h = getHarness();
      if (h.isSubAgent) return { ok: false, message: 'Only the main session can use worktrees.' };
      if (!h.activeWorktree) return { ok: false, message: 'Not in a worktree.' };
      return { ok: true };
    },
    call: async ({ remove = true }) => {
      const h = getHarness();
      const { path: worktreePath, branch, originalCwd } = h.activeWorktree;
      const repoRoot = findRepoRoot(originalCwd);
      h.rules.cwd = originalCwd; h.rules.root = originalCwd;
      h.activeWorktree = null;
      let removal = '';
      if (remove) {
        try { removeWorktree({ repoRoot, worktreePath }); removal = ` The worktree directory and branch "${branch}" were removed.`; }
        catch (e) { removal = ` (could not remove the worktree: ${e.message}; it is left at ${worktreePath})`; }
      } else removal = ` The worktree is left at ${worktreePath} on branch "${branch}" for later.`;
      await h.emitHook('WorktreeRemove', { worktreePath, worktreeBranch: branch });
      return `Returned to ${originalCwd}.${removal}`;
    },
  });
  return [enter, exit];
}
