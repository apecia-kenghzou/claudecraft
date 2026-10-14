// Search layer modelled on Claude Code's Grep/Glob tools (see EVIDENCE.md §1).
// Uses ripgrep when available (REA_RG or `rg` on PATH); otherwise a pure-Node fallback.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const VCS_DIRS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];
export const DEFAULT_HEAD_LIMIT = 250;
export const DEFAULT_GLOB_LIMIT = 100;

let rgPath;
function findRg() {
  if (rgPath !== undefined) return rgPath;
  const candidate = process.env.REA_RG || 'rg';
  const r = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  rgPath = r.error || r.status !== 0 ? null : candidate;
  return rgPath;
}

// Same glob splitting rule as Claude Code: split on whitespace, then on commas,
// but never inside {a,b} brace groups.
export function splitGlobs(glob) {
  const out = [];
  for (const part of glob.split(/\s+/)) {
    if (part.includes('{') && part.includes('}')) out.push(part);
    else out.push(...part.split(',').filter(Boolean));
  }
  return out.filter(Boolean);
}

function baseArgs(globs = []) {
  const args = ['--hidden'];
  for (const d of VCS_DIRS) args.push('--glob', `!${d}`);
  for (const g of globs) args.push('--glob', g);
  return args;
}

function runRg(args, cwd) {
  const r = spawnSync(findRg(), args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status === 1) return []; // rg: 1 == no matches
  if (r.status !== 0) throw new Error(`rg failed: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter(Boolean);
}

const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
const byMtimeDesc = (cwd) => (a, b) => mtime(path.resolve(cwd, b)) - mtime(path.resolve(cwd, a));

function page(items, offset, limit) {
  const start = Math.max(0, offset);
  if (limit === 0) return { items: items.slice(start), truncated: false };
  const end = start + limit;
  return { items: items.slice(start, end), truncated: items.length > end };
}

// ---- pure-Node fallback ---------------------------------------------------
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      const alts = glob.slice(i + 1, end).split(',').map((a) => globToRegExp(a).source.slice(1, -1));
      re += `(?:${alts.join('|')})`; i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function walk(root) {
  const out = [];
  const rec = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (VCS_DIRS.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) rec(full);
      else if (e.isFile()) out.push(path.relative(root, full));
    }
  };
  rec(root);
  return out;
}

function matchesGlobs(rel, globs) {
  if (!globs.length) return true;
  const base = path.basename(rel);
  return globs.some((g) => {
    const re = globToRegExp(g);
    return re.test(rel) || (!g.includes('/') && re.test(base));
  });
}

function nodeGrep(o, root) {
  const flags = 'g' + (o.ignoreCase ? 'i' : '') + (o.multiline ? 'ms' : '');
  const re = new RegExp(o.pattern, flags);
  const globs = o.glob ? splitGlobs(o.glob) : [];
  const lines = [];
  for (const rel of walk(root)) {
    if (!matchesGlobs(rel, globs)) continue;
    let text;
    try { text = readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue; // binary
    const fileLines = text.split('\n');
    const hits = [];
    fileLines.forEach((l, i) => { re.lastIndex = 0; if (re.test(l)) hits.push(i); });
    if (!hits.length) continue;
    if (o.outputMode === 'files_with_matches') lines.push(rel);
    else if (o.outputMode === 'count') lines.push(`${rel}:${hits.length}`);
    else {
      const keep = new Set();
      for (const h of hits) {
        for (let k = Math.max(0, h - o.before); k <= Math.min(fileLines.length - 1, h + o.after); k++) keep.add(k);
      }
      for (const k of [...keep].sort((a, b) => a - b)) {
        const sep = hits.includes(k) ? ':' : '-';
        lines.push(`${rel}${sep}${o.lineNumbers ? `${k + 1}${sep}` : ''}${fileLines[k].slice(0, 500)}`);
      }
    }
  }
  return lines;
}

// ---- public API -----------------------------------------------------------
/**
 * Content search. Mirrors Claude Code's Grep tool parameters.
 * @returns {{mode:string, lines:string[], truncated:boolean, appliedLimit:number, appliedOffset:number}}
 */
export function grep(opts) {
  const o = {
    path: '.', outputMode: 'files_with_matches', before: 0, after: 0, lineNumbers: true,
    ignoreCase: false, multiline: false, headLimit: DEFAULT_HEAD_LIMIT, offset: 0, cwd: process.cwd(),
    ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
  };
  if (o.context !== undefined) o.before = o.after = o.context;
  if (typeof o.pattern !== 'string' || !o.pattern) throw new Error('pattern is required');
  const root = path.resolve(o.cwd, o.path);

  let lines;
  if (findRg()) {
    const args = baseArgs(o.glob ? splitGlobs(o.glob) : []);
    args.push('--max-columns', '500');
    if (o.multiline) args.push('-U', '--multiline-dotall');
    if (o.ignoreCase) args.push('-i');
    if (o.outputMode === 'files_with_matches') args.push('-l');
    else if (o.outputMode === 'count') args.push('-c', '-H');
    else {
      args.push('--no-heading', '--with-filename');
      if (o.lineNumbers) args.push('-n');
      if (o.before) args.push('-B', String(o.before));
      if (o.after) args.push('-A', String(o.after));
    }
    if (o.type) args.push('--type', o.type);
    args.push('-e', o.pattern, '--', '.');
    lines = runRg(args, root).map((l) => l.replace(/^\.\//, ''));
  } else {
    lines = nodeGrep(o, root);
  }
  // Most recently modified files first (only meaningful for file-level modes).
  if (o.outputMode !== 'content') {
    const file = (l) => (o.outputMode === 'count' ? l.replace(/:\d+$/, '') : l);
    lines.sort((a, b) => byMtimeDesc(root)(file(a), file(b)));
  }
  const { items, truncated } = page(lines, o.offset, o.headLimit);
  return { mode: o.outputMode, lines: items, truncated, appliedLimit: o.headLimit, appliedOffset: o.offset };
}

/** File-name search. Mirrors Claude Code's Glob tool: results sorted by mtime, newest first. */
export function glob({ pattern, path: p = '.', cwd = process.cwd(), limit = DEFAULT_GLOB_LIMIT }) {
  if (!pattern) throw new Error('pattern is required');
  const root = path.resolve(cwd, p);
  let files;
  if (findRg()) {
    files = runRg([...baseArgs([pattern]), '--files'], root).map((l) => l.replace(/^\.\//, ''));
  } else {
    files = walk(root).filter((f) => matchesGlobs(f, [pattern]));
  }
  files.sort(byMtimeDesc(root));
  const { items, truncated } = page(files, 0, limit);
  return { files: items, truncated };
}
