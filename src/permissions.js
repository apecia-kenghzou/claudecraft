// Permission rules: `Tool` / `Tool(content)` syntax, Bash command matching, path patterns, precedence.
// Grammar, escaping and Bash content kinds (prefix `cmd:*`, wildcard, exact) follow the bundle (EVIDENCE.md §9).
// Compound-command handling, path-pattern roots and precedence are written from documented behaviour and
// conservative design; EVIDENCE.md §9 says which is which.
import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeCommand, splitSimple } from './shell.js';

// ---- rule strings -----------------------------------------------------------------------------------------
/** "Bash(git commit:*)" -> { toolName:'Bash', ruleContent:'git commit:*' }. "Tool", "Tool()" and "Tool(*)" cover the whole tool. */
export function parseRule(str) {
  const s = String(str).trim();
  const open = s.indexOf('('), close = s.lastIndexOf(')');
  if (open === -1 && close === -1) return { toolName: s };
  const name = s.slice(0, open);
  if (open === -1 || close <= open || close !== s.length - 1 || /[()]/.test(name) || !name) return { toolName: s, malformed: true };
  const raw = s.slice(open + 1, close);
  if (raw === '' || raw === '*') return { toolName: name };
  return { toolName: name, ruleContent: raw.replaceAll('\\(', '(').replaceAll('\\)', ')').replaceAll('\\\\', '\\') };
}

export function formatRule({ toolName, ruleContent }) {
  if (!ruleContent) return toolName;
  return `${toolName}(${ruleContent.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')})`;
}

/** Split "Read,Bash(git log:*), Edit" on commas that are not inside parentheses. */
export function splitRuleList(s) {
  const out = []; let depth = 0, cur = '';
  for (const c of s) {
    if (c === '(') depth++; else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---- Bash content matching ----------------------------------------------------------------------------------
const hasUnescapedStar = (s) => {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '*') continue;
    let bs = 0; for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) bs++;
    if (bs % 2 === 0) return true;
  }
  return false;
};

/** Classify rule content: legacy prefix `cmd:*`, wildcard (unescaped `*`), or exact. */
export function bashRuleKind(content) {
  const m = /^(.+):\*$/.exec(content);
  if (m) return { type: 'prefix', prefix: m[1] };
  if (hasUnescapedStar(content)) return { type: 'wildcard', pattern: content };
  return { type: 'exact', command: content };
}

function wildcardToRegExp(pattern) {
  // `\*` and `\\` are literals; everything else regex-escaped; `*` -> `.*`; whitespace runs collapse.
  let s = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && pattern[i + 1] === '*') { s += '\\*'; i++; } else if (c === '\\' && pattern[i + 1] === '\\') { s += '\\\\'; i++; }
    else if (c === '*') s += '\u0000STAR';
    else s += c.replace(/[.+?^${}()|[\]\\'"]/g, '\\$&');
  }
  const stars = (s.match(/\u0000STAR/g) ?? []).length;
  s = s.replaceAll('\u0000STAR', '.*');
  if (s.endsWith(' .*') && stars === 1) s = `${s.slice(0, -3)}( .*)?`;   // "git *" also matches bare "git"
  return new RegExp(`^${s}$`, 's');
}

const norm = (s) => s.trim().replace(/[ \t]+/g, ' ');

export function matchBashContent(content, command) {
  const kind = bashRuleKind(content);
  const c = norm(command);
  switch (kind.type) {
    case 'exact': return norm(kind.command) === c;
    case 'prefix': { const p = norm(kind.prefix); return c === p || c.startsWith(`${p} `); }
    case 'wildcard': return wildcardToRegExp(norm(kind.pattern)).test(c);
    default: return false;
  }
}

/** Simple commands of a shell command line (real tokenizer: quotes, operators, heredocs); `unsafe` = not analyzable. */
export function splitCommand(cmd) {
  const { segments, unsafe } = splitSimple(cmd);
  return { segments, unsafe };
}

/** True if the (quote-stripped) segment redirects output to something other than /dev/null or an fd. */
export function hasFileRedirect(segment) {
  const bare = segment.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""');
  for (const m of bare.matchAll(/(\d*)>>?\s*(&?)(\S*)/g)) {
    if (m[2] === '&') continue;                 // 2>&1
    if (m[3] === '/dev/null') continue;
    return true;
  }
  return false;
}

// ---- path matching ----------------------------------------------------------------------------------------
function globToRegExp(glob) {
  let s = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { if (glob[i + 2] === '/') { s += '(?:.*/)?'; i += 2; } else { s += '.*'; i++; } }
    else if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${s}$`, 's');
}

/** Documented conventions: `//abs`, `~/home`, `/root-relative`, `./cwd-relative`; a bare glob without `/` matches by basename. */
export function matchPathContent(pattern, absPath, { cwd, root = cwd, home = os.homedir() }) {
  const p = path.resolve(absPath);
  let re;
  if (pattern.startsWith('//')) re = globToRegExp(pattern.slice(1));
  else if (pattern.startsWith('~/')) re = globToRegExp(path.join(home, pattern.slice(2)));
  else if (pattern.startsWith('/')) re = globToRegExp(path.join(root, pattern.slice(1)));
  else if (pattern.startsWith('./')) re = globToRegExp(path.join(cwd, pattern.slice(2)));
  else if (!pattern.includes('/')) {
    const base = globToRegExp(pattern);
    return p.split(path.sep).some((part) => base.test(part));   // any path component (covers dirs and files)
  } else re = globToRegExp(path.join(cwd, pattern));
  // A rule on a directory covers everything below it.
  for (let cur = p; ; cur = path.dirname(cur)) {
    if (re.test(cur)) return true;
    if (path.dirname(cur) === cur) return false;
  }
}


/**
 * Could `ruleContent` (a path rule) match something at or below directory `dir`? Conservative: basename patterns can match
 * anywhere; path patterns are compared by their literal prefix. Used for recursive operations (rm -r, rg, grep -r, mv).
 */
export function ruleOverlapsDirectory(ruleContent, dir, { cwd, root = cwd, home = os.homedir() }) {
  if (!ruleContent.includes('/') && !ruleContent.startsWith('~')) return true;
  let base;
  if (ruleContent.startsWith('//')) base = ruleContent.slice(1);
  else if (ruleContent.startsWith('~/')) base = path.join(home, ruleContent.slice(2));
  else if (ruleContent.startsWith('/')) base = path.join(root, ruleContent.slice(1));
  else if (ruleContent.startsWith('./')) base = path.join(cwd, ruleContent.slice(2));
  else base = path.join(cwd, ruleContent);
  const g = base.search(/[*?[{]/);
  const literal = g === -1 ? base : base.slice(0, g);
  const prefix = g === -1 ? literal : (literal.endsWith('/') ? literal.slice(0, -1) : path.dirname(literal));
  const d = dir.endsWith('/') && dir.length > 1 ? dir.slice(0, -1) : dir;
  return prefix === d || prefix.startsWith(`${d}/`) || d.startsWith(`${prefix}/`);
}

const isDirectory = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** `domain:example.com` matches that host exactly; `domain:*.example.com` matches its subdomains (not the apex). */
export function matchDomainContent(ruleContent, host) {
  const m = /^domain:(.+)$/.exec(ruleContent);
  if (!m) return false;
  const d = m[1].trim().toLowerCase(), h = host.toLowerCase();
  return d.startsWith('*.') ? h.endsWith(d.slice(1)) && h !== d.slice(2) : h === d;
}

export function isInWorkspace(absPath, { cwd, additionalDirectories = [] }) {
  return [cwd, ...additionalDirectories].some((d) => {
    const rel = path.relative(path.resolve(d), path.resolve(absPath));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

// ---- rule set ---------------------------------------------------------------------------------------------
const toolMatches = (ruleName, toolName) => ruleName === toolName || (ruleName.startsWith('mcp__') && !ruleName.slice(5).includes('__') && toolName.startsWith(`${ruleName}__`));

export class RuleSet {
  constructor({ cwd = process.cwd(), root, home = os.homedir(), additionalDirectories = [] } = {}) {
    this.cwd = path.resolve(cwd); this.root = path.resolve(root ?? cwd); this.home = home;
    this.additionalDirectories = additionalDirectories.map((d) => path.resolve(cwd, d));
    this.rules = { allow: [], deny: [], ask: [] };
  }

  add(behavior, ruleStr, source = 'session') {
    if (!this.rules[behavior]) throw new Error(`bad behavior ${behavior}`);
    const rule = parseRule(ruleStr);
    if (rule.malformed) throw new Error(`malformed permission rule: ${ruleStr}`);
    this.rules[behavior].push({ rule, text: formatRule(rule), source });
    return this;
  }

  addAll(behavior, list = [], source) { for (const r of list) this.add(behavior, r, source); return this; }

  list() {
    return ['deny', 'ask', 'allow'].flatMap((b) => this.rules[b].map((r) => ({ behavior: b, rule: r.text, source: r.source })));
  }

  inWorkspace(p) { return isInWorkspace(p, { cwd: this.cwd, additionalDirectories: this.additionalDirectories }); }

  #matchOne(entry, tool, content) {
    const { toolName, ruleContent } = entry.rule;
    // A tool can declare permissionAlias (e.g. NotebookRead/NotebookEdit alias to Read/Edit) so a path rule written
    // against the alias also governs it, matching the real product's file-pattern-tool grouping.
    if (!toolMatches(toolName, tool.name) && toolName !== tool.permissionAlias) return false;
    if (ruleContent === undefined) return true;                       // whole-tool rule
    if (!content) return false;
    if (content.kind === 'command') return matchBashContent(ruleContent, content.value);
    if (content.kind === 'path') return matchPathContent(ruleContent, content.value, this);
    if (content.kind === 'domain') return matchDomainContent(ruleContent, content.value);
    return ruleContent === String(content.value);                     // opaque string content: exact
  }

  #first(behavior, tool, content) {
    return this.rules[behavior].find((e) => this.#matchOne(e, tool, content));
  }

  analyze(command) { return analyzeCommand(command, { cwd: this.cwd, home: this.home }); }

  /**
   * Path rules applied to what a shell command touches: `cat .env` is a read of .env (Read rules), `> f` or `rm f` are
   * writes (Edit/Write rules). Paths that cannot be resolved statically ($VAR, globs, after `cd $X`) cannot be checked,
   * so they ask whenever path rules exist for that kind of access.
   */
  #pathRules(a) {
    let ask = null;
    for (const p of a.paths) {
      const names = p.op === 'read' ? ['Read'] : ['Edit', 'Write'];
      const verb = p.op === 'read' ? 'reads' : 'writes';
      if (p.path === undefined && p.unresolved) {
        const anyPathRule = ['deny', 'ask'].some((b) => this.rules[b].some((e) => names.includes(e.rule.toolName) && e.rule.ruleContent !== undefined));
        if (anyPathRule && !ask) ask = { behavior: 'ask', rule: `path rules for ${names.join('/')}`, source: 'shell-analysis', detail: `command ${verb} "${p.raw}", which ${p.unresolved}; it cannot be checked against path rules` };
        continue;
      }
      if (!p.path) continue;
      // A symlink can point at a protected file under an innocent name: check the real target as well.
      let real = p.path;
      try { real = realpathSync(p.path); } catch { /* does not exist yet */ }
      const targets = real === p.path ? [p.path] : [p.path, real];
      for (const b of ['deny', 'ask']) {
        for (const n of names) {
          for (const target of targets) {
            const hit = this.#first(b, { name: n }, { kind: 'path', value: target });
            if (hit) {
              const r = { behavior: b, rule: hit.text, source: hit.source, detail: `command ${verb} ${p.path}${target !== p.path ? ` (a link to ${target})` : ''}` };
              if (b === 'deny') return r;
              ask ??= r;
            }
          }
          // `rm -r src`, `rg TODO .`, `mv src old`: the operand's contents are affected, so rules about paths inside it apply.
          if (p.recursive && isDirectory(p.path)) {
            const inside = this.rules[b].find((e) => e.rule.toolName === n && e.rule.ruleContent !== undefined && ruleOverlapsDirectory(e.rule.ruleContent, p.path, this));
            if (inside) {
              // writing/removing a directory that contains protected paths is denied; merely searching it asks
              const behavior = p.op === 'read' && b === 'deny' ? 'ask' : b;
              const r = { behavior, rule: inside.text, source: inside.source, detail: `command ${verb} ${p.path} recursively, which can include paths covered by this rule` };
              if (behavior === 'deny') return r;
              ask ??= r;
            }
          }
        }
      }
    }
    return ask;
  }

  /**
   * Decide from rules alone. Precedence: deny > ask > allow. `undefined` behavior = no rule applies.
   * Compound Bash commands: deny/ask if ANY simple command matches; allow only if ALL do (and nothing is unsafe).
   */
  evaluate(tool, input) {
    const content = tool.permissionContent?.(input, this);
    if (content?.kind === 'command') {
      const a = this.analyze(content.value);
      const segments = a.commands.map((c) => c.raw).filter(Boolean);
      const unsafe = a.unsafe.length > 0;
      const parts = [content.value, ...segments].map((v) => ({ kind: 'command', value: v }));
      const fromPaths = this.#pathRules(a);
      for (const b of ['deny', 'ask']) {
        for (const p of parts) { const hit = this.#first(b, tool, p); if (hit) return { behavior: b, rule: hit.text, source: hit.source }; }
        if (fromPaths?.behavior === b) return fromPaths;
      }
      const redirects = a.commands.some((c) => c.redirectWrites);
      const whole = this.#first('allow', tool, { kind: 'command', value: content.value });
      if (whole && !unsafe) {
        const kind = whole.rule.ruleContent === undefined ? 'tool' : bashRuleKind(whole.rule.ruleContent).type;
        const broad = kind === 'prefix' || kind === 'wildcard';
        // A prefix/wildcard rule must not cover chained commands or output redirection.
        if (!broad || (segments.length <= 1 && !redirects)) return { behavior: 'allow', rule: whole.text, source: whole.source };
      }
      if (!unsafe && segments.length > 0 && !redirects) {
        const hits = segments.map((seg) => this.#first('allow', tool, { kind: 'command', value: seg }));
        if (hits.every(Boolean)) return { behavior: 'allow', rule: hits.map((h) => h.text).join(' + '), source: hits[0].source };
      }
      return { behavior: undefined };
    }
    for (const b of ['deny', 'ask', 'allow']) {
      const hit = this.#first(b, tool, content);
      if (hit) return { behavior: b, rule: hit.text, source: hit.source };
    }
    return { behavior: undefined };
  }
}
