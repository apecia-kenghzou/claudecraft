// Memory files: standing instructions discovered on disk and given to the model.
// Search list, parent-directory walk, `@path` imports (as separate entries), HTML-comment stripping and
// text-only includes follow the bundle (EVIDENCE.md §11). File names for rea: REA.md (+ AGENTS.md, and the
// CLAUDE.md family for compatibility). Rendering and caps are original.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter, toList } from './frontmatter.js';

export const DIR_FILES = ['REA.md', 'REA.local.md', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md'];
export const DOT_FILES = [['.rea', 'REA.md'], ['.rea', 'AGENTS.md'], ['.claude', 'CLAUDE.md'], ['.claude', 'AGENTS.md']];
export const RULE_DIRS = [['.rea', 'rules'], ['.claude', 'rules']];
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml', '.js', '.mjs', '.ts', '.py', '.sh', '.go', '.rs', '.java', '.rb', '.css', '.html', '.sql']);
export const MAX_IMPORT_DEPTH = 5;

const typeOf = (file) => (/\.local\.md$/i.test(file) ? 'local' : 'project');

/** Remove HTML comments outside fenced code blocks. */
export function stripComments(text) {
  let fenced = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
    return fenced ? line : line.replace(/<!--[\s\S]*?-->/g, '');
  }).join('\n');
}

/** `@path` tokens outside fenced code and inline code. Emails and mid-word @ are ignored. */
export function findImports(text) {
  const out = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const bare = line.replace(/`[^`]*`/g, '');
    for (const m of bare.matchAll(/(?:^|[\s(])@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+\.[A-Za-z0-9]+)/g)) out.push(m[1]);
  }
  return out;
}

function readText(file, maxChars, warn) {
  try {
    if (!statSync(file).isFile()) return null;
    let text = readFileSync(file, 'utf8');
    if (text.length > maxChars) { warn?.(`${file}: truncated to ${maxChars} characters`); text = `${text.slice(0, maxChars)}\n[truncated]`; }
    return text;
  } catch { return null; }
}

/**
 * @returns {{files: {path:string,type:string,content:string,importedBy?:string}[], skipped: {path:string,reason:string}[]}}
 */
export function discoverMemory(cwd, { home = os.homedir(), maxFileChars = 40_000, maxTotalChars = 160_000, warn } = {}) {
  const files = [], skipped = [], seen = new Set();
  let total = 0;
  const add = (file, type, importedBy, depth = 0) => {
    let real;
    try { real = realpathSync(file); } catch { return; }
    if (seen.has(real)) return;
    const raw = readText(real, maxFileChars, warn);
    if (raw === null) return;
    seen.add(real);
    let body = raw;
    if (type === 'rules') {
      const fm = parseFrontmatter(raw);
      if (fm) {
        const globs = toList(fm.data.paths ?? fm.data.globs);
        if (globs?.length) { skipped.push({ path: file, reason: `conditional rule (paths: ${globs.join(', ')})` }); return; }
        body = fm.body;
      }
    }
    const content = stripComments(body).trim();
    if (!content) return;
    if (total + content.length > maxTotalChars) { skipped.push({ path: file, reason: 'total memory size limit reached' }); return; }
    total += content.length;
    files.push({ path: file, type, content, ...(importedBy ? { importedBy } : {}) });
    if (depth >= MAX_IMPORT_DEPTH) return;
    for (const ref of findImports(content)) {
      const target = ref.startsWith('~/') ? path.join(home, ref.slice(2)) : path.resolve(path.dirname(file), ref);
      if (!TEXT_EXT.has(path.extname(target).toLowerCase())) { skipped.push({ path: target, reason: 'not a text file' }); continue; }
      add(target, 'import', file, depth + 1);
    }
  };

  // user-level, then ancestors from the outermost down to cwd (closer = later = higher priority)
  for (const f of ['REA.md', 'AGENTS.md', 'CLAUDE.md']) add(path.join(home, '.rea', f), 'user');
  add(path.join(home, '.claude', 'CLAUDE.md'), 'user');
  const chain = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    chain.unshift(d);
    if (d === path.resolve(home) || path.dirname(d) === d) break;
  }
  for (const dir of chain) {
    for (const f of DIR_FILES) add(path.join(dir, f), typeOf(f));
    for (const parts of DOT_FILES) add(path.join(dir, ...parts), 'project');
    for (const parts of RULE_DIRS) {
      const rd = path.join(dir, ...parts);
      if (!existsSync(rd)) continue;
      for (const f of readdirSync(rd).filter((x) => x.endsWith('.md')).sort()) add(path.join(rd, f), 'rules');
    }
  }
  return { files, skipped };
}

export function renderMemory(files) {
  if (!files.length) return '';
  const parts = files.map((f) => `<memory-file path="${f.path}" type="${f.type}">\n${f.content}\n</memory-file>`);
  return `Standing instructions loaded from the user's memory files. Follow them; they take precedence over your default behaviour. Later files are more specific.\n\n${parts.join('\n\n')}`;
}
