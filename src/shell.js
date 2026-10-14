// Shell command analysis for permission checks: a real tokenizer (quotes, escapes, operators, redirections, heredocs),
// wrapper stripping, and per-command path extraction. The operation classes (read / create / write), the idea of
// per-command argument parsers, redirect targets treated as writes (with /dev/null and fd duplications exempt) and
// "cd + redirect needs approval" follow the bundle (EVIDENCE.md §16). The command tables and the read-only policy are
// original and deliberately conservative: anything not understood is reported as unsafe so the caller asks.
import os from 'node:os';
import path from 'node:path';

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', 'time', '!', '[[', 'coproc']);
const DANGEROUS_ASSIGN = /^(PATH|IFS|ENV|BASH_ENV|SHELLOPTS|PS4|PROMPT_COMMAND|LD_[A-Z_]+|DYLD_[A-Z_]+|NODE_OPTIONS|PYTHONPATH|GIT_[A-Z_]+)=/;
const REDIR = /^(\d*|&)(>>|>\||>&|&>>|&>|>|<<<|<<-?|<&|<>|<)$/;

/**
 * @typedef {{value:string, expands:boolean, glob:boolean, quoted:boolean}} Word
 * @typedef {{argv:Word[], redirects:{op:string,target:Word|null}[], assigns:string[], raw:string}} SimpleCommand
 * @returns {{commands: SimpleCommand[], unsafe: string[]}}
 */
export function tokenize(input) {
  const commands = [];
  const unsafe = [];
  const markUnsafe = (r) => { if (!unsafe.includes(r)) unsafe.push(r); };
  let words = [], redirects = [], assigns = [];
  let cur = null;                     // word being built
  let pendingRedir = null;            // operator waiting for its target word
  let cmdStart = -1;
  let heredocs = [];                  // { delim, quoted, stripTabs }
  const n = input.length;

  const startWord = (i) => {
    if (!cur) {
      cur = { value: '', expands: false, glob: false, quoted: false, start: i, isAssign: /^[A-Za-z_][A-Za-z0-9_]*=/.test(input.slice(i, i + 80)) };
      if (cmdStart < 0) cmdStart = i;
    }
  };
  const endWord = () => {
    if (!cur) return;
    const w = { value: cur.value, expands: cur.expands, glob: cur.glob, quoted: cur.quoted };
    const isAssign = cur.isAssign;
    cur = null;
    if (pendingRedir) { redirects.push({ op: pendingRedir.op, target: w }); pendingRedir = null; return; }
    if (words.length === 0 && isAssign) {
      if (DANGEROUS_ASSIGN.test(w.value)) markUnsafe('environment-assignment');
      assigns.push(w.value); return;
    }
    words.push(w);
  };
  const endCommand = (i) => {
    endWord();
    if (pendingRedir) { redirects.push({ op: pendingRedir.op, target: null }); pendingRedir = null; markUnsafe('redirection-without-target'); }
    if (words.length || redirects.length || assigns.length) {
      commands.push({ argv: words, redirects, assigns, raw: input.slice(cmdStart < 0 ? 0 : cmdStart, i).trim() });
    }
    words = []; redirects = []; assigns = []; cmdStart = -1;
  };

  let i = 0;
  while (i < n) {
    const c = input[i], d = input[i + 1];
    // heredoc bodies start after the newline that ends the command line
    if (c === '\n') {
      endCommand(i);
      i++;
      for (const h of heredocs) {
        let body = '';
        for (;;) {
          if (i >= n) { markUnsafe('unterminated-heredoc'); break; }
          let e = input.indexOf('\n', i); if (e < 0) e = n;
          const line = input.slice(i, e); i = Math.min(n, e + 1);
          if ((h.stripTabs ? line.replace(/^\t+/, '') : line) === h.delim) break;
          body += `${line}\n`;
        }
        if (!h.quoted && /\$\(|`|\$\{/.test(body)) markUnsafe('heredoc-expansion');
      }
      heredocs = [];
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '#' && !cur) { while (i < n && input[i] !== '\n') i++; continue; }   // comment

    // operators
    if ((c === '&' && d === '&') || (c === '|' && d === '|')) { endCommand(i); i += 2; continue; }
    if (c === ';') { endCommand(i); i++; continue; }
    if (c === '|') { endCommand(i); i += d === '&' ? 2 : 1; continue; }
    if (c === '&' && d !== '>' && !(cur && /\d$/.test(cur.value) === false && false)) {
      // `&` ends a command unless it is part of >&, <&, &>
      const prev = input[i - 1];
      if (prev !== '>' && prev !== '<') { endCommand(i); i++; continue; }
    }
    if (c === '(' || c === ')') { markUnsafe(c === '(' ? 'subshell-or-grouping' : 'grouping'); endWord(); i++; continue; }
    if ((c === '{' || c === '}') && !cur && (d === ' ' || d === '\n' || d === undefined)) { markUnsafe('grouping'); i++; continue; }

    if ((c === '<' || c === '>') && d === '(') {
      startWord(i); markUnsafe('process-substitution'); cur.expands = true; cur.value += c; i++; continue;
    }
    // redirections: optional fd prefix + operator
    const m = /^(\d*|&)(>>|>\||>&|&>>|&>|>|<<<|<<-?|<&|<>|<)/.exec(input.slice(i, i + 8));
    if (m && (m[1] === '' || /^\d+$/.test(m[1]) ? (!cur || /^\d+$/.test(cur.value) && cur.value === m[1]) : true)) {
      if (m[1] && /^\d+$/.test(m[1]) && cur && cur.value === m[1]) cur = null;     // the digits were the fd, not an argument
      endWord();
      const op = m[2];
      i += m[0].length;
      if (op === '<<' || op === '<<-') {
        while (input[i] === ' ' || input[i] === '\t') i++;
        let j = i, quoted = false, delim = '';
        for (; j < n && !/[\s;&|<>()]/.test(input[j]); j++) {
          if (input[j] === "'" || input[j] === '"') { quoted = true; const q = input[j]; j++; while (j < n && input[j] !== q) delim += input[j++]; }
          else if (input[j] === '\\') { quoted = true; j++; delim += input[j] ?? ''; }
          else delim += input[j];
        }
        heredocs.push({ delim, quoted, stripTabs: op === '<<-' });
        if (cmdStart < 0) cmdStart = i;
        redirects.push({ op, target: { value: delim, expands: false, glob: false, quoted } });
        i = j;
        continue;
      }
      pendingRedir = { op: m[1] === '&' ? `&${op}` : op };
      if (cmdStart < 0) cmdStart = i;
      continue;
    }

    // word characters
    startWord(i);
    if (c === "'") {
      cur.quoted = true; i++;
      while (i < n && input[i] !== "'") cur.value += input[i++];
      if (i >= n) markUnsafe('unbalanced-quote');
      i++; continue;
    }
    if (c === '"') {
      cur.quoted = true; i++;
      while (i < n && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < n) { const nx = input[i + 1]; cur.value += '$`"\\\n'.includes(nx) ? nx : `\\${nx}`; i += 2; continue; }
        if (input[i] === '`' || (input[i] === '$' && input[i + 1] === '(')) { markUnsafe('command-substitution'); cur.expands = true; }
        else if (input[i] === '$') cur.expands = true;
        cur.value += input[i++];
      }
      if (i >= n) markUnsafe('unbalanced-quote');
      i++; continue;
    }
    if (c === '\\') { if (i + 1 < n) { cur.value += input[i + 1]; cur.quoted = true; } i += 2; continue; }
    if (c === '`') { markUnsafe('command-substitution'); cur.expands = true; cur.value += c; i++; continue; }
    if (c === '$') {
      if (d === '(') { markUnsafe('command-substitution'); }
      if (d === "'") { markUnsafe('ansi-c-quoting'); }
      cur.expands = true; cur.value += c; i++; continue;
    }
    if ((c === '<' || c === '>') && d === '(') { markUnsafe('process-substitution'); cur.expands = true; cur.value += c; i++; continue; }
    if (c === '*' || c === '?' || c === '[' || c === '{') cur.glob = true;
    if (c === '~' && cur.value === '') cur.tilde = true;
    cur.value += c; i++;
  }
  endCommand(n);
  if (heredocs.length) markUnsafe('unterminated-heredoc');

  for (const cmd of commands) {
    const first = cmd.argv[0];
    if (first && !first.quoted && KEYWORDS.has(first.value)) markUnsafe('compound-statement');
    if (first && first.expands) markUnsafe('dynamic-command-name');
  }
  return { commands, unsafe };
}

// ---- wrappers ---------------------------------------------------------------------------------------------
/** Strip transparent wrappers so rules and tables see the real command. Returns {argv, cwdChange?: Word|null}. */
export function unwrap(argv) {
  let a = argv.slice();
  let cwdChange;
  for (let guard = 0; guard < 8 && a.length; guard++) {
    const name = a[0].value.replace(/^.*\//, '');
    if (name === 'time' || name === 'nohup' || name === 'command' || name === 'builtin') { a = a.slice(1); continue; }
    if (name === 'nice') {
      a = a.slice(1);
      if (a[0] && /^-n$/.test(a[0].value)) a = a.slice(2); else if (a[0] && /^-\d+$/.test(a[0].value)) a = a.slice(1);
      continue;
    }
    if (name === 'timeout') {
      a = a.slice(1);
      while (a[0] && a[0].value.startsWith('-')) a = a.slice(a[0].value === '-s' || a[0].value === '-k' ? 2 : 1);
      a = a.slice(1);                                                    // the duration
      continue;
    }
    if (name === 'env') {
      a = a.slice(1);
      while (a.length && (a[0].value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0].value))) {
        const v = a[0].value;
        if (v === '-C' || v === '--chdir') { cwdChange = a[1] ?? null; a = a.slice(2); continue; }
        if (v.startsWith('--chdir=')) { cwdChange = { value: v.slice(8), expands: false, glob: false, quoted: true }; }
        if (v === '-u') { a = a.slice(2); continue; }
        a = a.slice(1);
      }
      continue;
    }
    break;
  }
  return { argv: a, cwdChange };
}

// ---- command tables ---------------------------------------------------------------------------------------
/** class: read | create | write. valued: option flags (short letters or long names) that consume the next word. */
const T = (cls, extra = {}) => ({ cls, valued: new Set(), ...extra });
const COMMANDS = {
  ls: T('read'), cat: T('read'), head: T('read', { valued: new Set(['-n', '-c', '--lines', '--bytes']) }), tail: T('read', { valued: new Set(['-n', '-c', '--lines', '--bytes']) }),
  wc: T('read'), file: T('read'), stat: T('read', { valued: new Set(['-c', '--format', '-f']) }), diff: T('read'), strings: T('read', { valued: new Set(['-n']) }),
  hexdump: T('read'), od: T('read'), base64: T('read'), nl: T('read'), tac: T('read'), rev: T('read'), fold: T('read', { valued: new Set(['-w']) }),
  sort: T('read', { valued: new Set(['-k', '-t', '-T', '--key', '--field-separator']) }), uniq: T('read'), cut: T('read', { valued: new Set(['-b', '-c', '-d', '-f', '--delimiter', '--fields', '--bytes', '--characters']) }),
  paste: T('read', { valued: new Set(['-d']) }), column: T('read', { valued: new Set(['-c', '-s', '-o', '-N', '-t']) }), comm: T('read'), cmp: T('read'),
  sha256sum: T('read'), sha1sum: T('read'), md5sum: T('read'), tree: T('read', { valued: new Set(['-L', '-P', '-I']) }), du: T('read', { valued: new Set(['-d', '--max-depth']) }),
  realpath: T('read'), readlink: T('read'), basename: T('read'), dirname: T('read'),
  grep: T('read', { valued: new Set(['-e', '-f', '-m', '-A', '-B', '-C', '--include', '--exclude', '--exclude-dir', '--max-count']), patternFirst: true }),
  egrep: T('read', { valued: new Set(['-e', '-f', '-m', '-A', '-B', '-C']), patternFirst: true }), fgrep: T('read', { valued: new Set(['-e', '-f', '-m', '-A', '-B', '-C']), patternFirst: true }),
  rg: T('read', { valued: new Set(['-e', '-f', '-g', '--glob', '-t', '-T', '--type', '-A', '-B', '-C', '-m', '--max-count', '-j', '--max-depth', '-d', '--max-filesize', '-r', '--replace', '--color', '--sort', '--sortr', '--pre', '--pre-glob', '--hostname-bin']), patternFirst: true, defaultPath: true }),
  jq: T('read', { valued: new Set(['--arg', '--argjson', '--slurpfile', '--rawfile', '--indent']), patternFirst: true }),
  find: T('read'),
  mkdir: T('create', { valued: new Set(['-m', '--mode']) }), touch: T('create', { valued: new Set(['-d', '-t', '-r', '--date', '--reference']) }),
  rm: T('write'), rmdir: T('write'), mv: T('write', { valued: new Set(['-t', '--target-directory']) }), cp: T('write', { valued: new Set(['-t', '--target-directory']) }),
  ln: T('write'), tee: T('write'), chmod: T('write'), chown: T('write'), truncate: T('write', { valued: new Set(['-s', '--size']) }), sed: T('write', { valued: new Set(['-e', '-f', '--expression', '--file']) }),
  cd: T('read'), pushd: T('read'),
};
// commands that never touch files but are harmless to run; they are read-only when they have no output redirection
const PURE = new Set(['echo', 'printf', 'pwd', 'which', 'whoami', 'uname', 'id', 'true', 'false', 'seq', 'sleep', 'date', 'hostname', 'tr', 'test', '[', 'expr', 'nproc']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'cat-file', 'ls-tree', 'rev-list', 'diff-tree', 'show-ref', 'config']);

function flagsOf(args) { return args.map((a) => a.value).filter((v) => v.startsWith('-')); }

/** Reasons a (known) command is not purely read-only. */
function mutatingFlags(name, args) {
  const vals = args.map((a) => a.value);
  const has = (...f) => vals.some((v) => f.includes(v) || f.some((x) => x.length > 2 && v.startsWith(`${x}=`)));
  switch (name) {
    case 'find': return has('-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls') ? 'find can execute or write' : null;
    case 'sort': return has('-o', '--output') || vals.some((v) => /^-[A-Za-z]*o/.test(v) && !v.startsWith('--')) ? 'sort -o writes a file' : null;
    case 'rg': return has('--pre', '--pre-glob', '--hostname-bin') ? 'rg can run helper programs' : null;
    case 'date': return has('-s', '--set') ? 'date -s sets the clock' : null;
    case 'tree': return has('-o') ? 'tree -o writes a file' : null;
    case 'diff': return has('--to-file') ? null : null;
    case 'sed': return 'sed can edit files and run commands';
    default: return null;
  }
}

function gitAnalysis(args) {
  const sub = args[0]?.value;
  if (!sub || sub.startsWith('-')) return { readOnly: false, reason: 'git with global options needs approval' };
  const vals = args.slice(1).map((a) => a.value);
  const bad = vals.find((v) => v === '--output' || v.startsWith('--output=') || v === '--ext-diff' || v === '--textconv' || v === '-c' || v === '--exec');
  if (bad) return { readOnly: false, reason: `git ${sub} ${bad} may write or execute` };
  if (sub === 'branch') {
    const ok = vals.every((v) => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '-l', '--all', '--remotes', '--verbose'].includes(v));
    return { readOnly: ok, reason: ok ? null : 'git branch with arguments can modify branches' };
  }
  if (sub === 'remote') {
    const ok = vals.every((v) => ['-v', '--verbose', 'show', 'get-url'].includes(v) || (!v.startsWith('-') && vals[0] && ['show', 'get-url'].includes(vals[0])));
    return { readOnly: ok, reason: ok ? null : 'git remote can modify remotes' };
  }
  if (sub === 'config') {
    const ok = vals.some((v) => v === '--get' || v === '--get-all' || v === '--list' || v === '-l') && !vals.some((v) => v === '--unset' || v === '--add' || v === '--replace-all');
    return { readOnly: ok, reason: ok ? null : 'git config may write' };
  }
  return GIT_READ.has(sub) ? { readOnly: true } : { readOnly: false, reason: `git ${sub} is not known to be read-only` };
}

/** Extract path operands for a known command. Returns [{word, op}] where op is read | create | write. */
function pathOperands(name, spec, args) {
  const out = [];
  const vals = args.map((a) => a.value);
  const opFor = (cls) => (cls === 'create' ? 'create' : cls === 'write' ? 'write' : 'read');
  let i = 0, afterDashes = false, seenPattern = !spec.patternFirst, patternFlag = false;
  const positional = [];
  for (; i < args.length; i++) {
    const v = vals[i];
    if (!afterDashes && v === '--') { afterDashes = true; continue; }
    if (!afterDashes && v.startsWith('-') && v !== '-') {
      if (v === '-e' || v === '--regexp' || v === '-f' || v === '--file') patternFlag = patternFlag || spec.patternFirst === true;
      const long = v.startsWith('--');
      const key = long ? v.split('=')[0] : v;
      const valuedShort = !long && v.length === 2 && spec.valued.has(v);
      const valuedLong = long && spec.valued.has(key) && !v.includes('=');
      if (valuedShort || valuedLong) {
        // -f FILE for grep/rg/sed reads a file of patterns/script: it is a path operand
        if ((key === '-f' || key === '--file') && ['grep', 'egrep', 'fgrep', 'rg', 'sed', 'jq'].includes(name) && args[i + 1]) out.push({ word: args[i + 1], op: 'read' });
        if (key === '-t' || key === '--target-directory') { if (args[i + 1]) out.push({ word: args[i + 1], op: opFor(spec.cls) }); }
        i++;
      } else if (long && v.includes('=') && (key === '--file' || key === '--target-directory')) {
        out.push({ word: { ...args[i], value: v.slice(v.indexOf('=') + 1) }, op: key === '--file' ? 'read' : opFor(spec.cls) });
      } else if (name === 'sort' && (key === '-o' || key === '--output') && args[i + 1]) { out.push({ word: args[i + 1], op: 'write' }); i++; }
      else if (name === 'tee') { /* flags only */ }
      else if (name === 'sed' && /^-[A-Za-z]*i/.test(v)) { /* in-place: files below are written */ }
      continue;
    }
    positional.push(args[i]);
  }
  let operands = positional;
  if (spec.patternFirst && !patternFlag) operands = positional.slice(1);          // first positional is the pattern / filter
  if (name === 'sed') {
    const hasScriptFlag = vals.some((v) => v === '-e' || v === '-f' || v === '--expression' || v === '--file' || /^-[A-Za-z]*e/.test(v));
    operands = hasScriptFlag ? positional : positional.slice(1);                  // first positional is the script
  }
  if (name === 'uniq') { operands = positional; }
  const cls = spec.cls;
  for (const w of operands) {
    let op = opFor(cls);
    if (name === 'uniq' && operands.length >= 2 && w === operands[1]) op = 'write';
    if (name === 'sed') op = vals.some((v) => /^-[A-Za-z]*i/.test(v) || v === '--in-place' || v.startsWith('--in-place=')) ? 'write' : 'read';
    out.push({ word: w, op });
  }
  if (name === 'find') {
    // paths are the words before the first expression (starting with - ! ( ), except -H/-L/-P
    out.length = 0;
    for (const w of args) {
      if (/^-[HLP]$/.test(w.value)) continue;
      if (w.value.startsWith('-') || w.value === '!' || w.value === '(') break;
      out.push({ word: w, op: 'read' });
    }
    if (out.length === 0) out.push({ word: { value: '.', expands: false, glob: false, quoted: false }, op: 'read' });
  }
  if (spec.defaultPath && out.length === 0 && !vals.includes('-')) out.push({ word: { value: '.', expands: false, glob: false, quoted: false }, op: 'read' });
  if (name === 'ls' && out.length === 0) out.push({ word: { value: '.', expands: false, glob: false, quoted: false }, op: 'read' });
  if (name === 'cd' || name === 'pushd') { out.length = 0; if (positional[0]) out.push({ word: positional[0], op: 'read' }); }
  return out;
}

const redirectIsWrite = (op) => ['>', '>>', '>|', '&>', '&>>', '>&', '&>'].includes(op) || /^&?>/.test(op);

/**
 * Analyse a shell command.
 * @returns {{commands: object[], unsafe: string[], readOnly: boolean, cwdUnknown: boolean,
 *            paths: {path:string|null, raw:string, op:string, command:string, unresolved?:string}[]}}
 *   `readOnly` is true only when every simple command is understood, read-only, and writes nowhere.
 */
export function analyzeCommand(cmd, { cwd = process.cwd(), home = os.homedir() } = {}) {
  const { commands, unsafe } = tokenize(cmd);
  const out = { commands: [], unsafe: [...unsafe], readOnly: true, cwdUnknown: false, paths: [] };
  if (commands.length === 0 || unsafe.length) out.readOnly = false;
  let wd = path.resolve(cwd);
  let wdKnown = true;

  const resolveWord = (w, base) => {
    if (w.expands) return { unresolved: 'contains a shell variable or substitution' };
    if (w.glob && !w.quoted) return { unresolved: 'contains a glob or brace expansion' };
    let v = w.value;
    if (v === '-') return { path: null };
    if (v.startsWith('~')) {
      if (v === '~' || v.startsWith('~/')) v = path.join(home, v.slice(1));
      else return { unresolved: 'contains ~user' };
    }
    if (!path.isAbsolute(v) && !wdKnown) return { unresolved: 'depends on a directory changed with cd' };
    return { path: path.resolve(base, v) };
  };

  for (const c of commands) {
    const { argv, cwdChange } = unwrap(c.argv);
    const entry = { raw: c.raw, name: argv[0]?.value?.replace(/^.*\//, '') ?? '', known: false, readOnly: false, reason: null, paths: [] };
    const addPath = (word, op) => {
      const r = resolveWord(word, wd);
      const p = { raw: word.value, op, command: entry.name, ...(r.path !== undefined ? { path: r.path } : {}), ...(r.unresolved ? { unresolved: r.unresolved } : {}) };
      entry.paths.push(p); out.paths.push(p);
    };

    if (cwdChange === null) { out.cwdUnknown = true; wdKnown = false; }
    else if (cwdChange) { const r = resolveWord(cwdChange, wd); if (r.path) wd = r.path; else { wdKnown = false; out.cwdUnknown = true; } }

    const name = entry.name;
    const args = argv.slice(1);
    if (!name) { entry.reason = 'no command'; }
    else if (name === 'git') {
      const g = gitAnalysis(args);
      entry.known = true; entry.readOnly = g.readOnly; entry.reason = g.reason ?? null;
    } else if (COMMANDS[name]) {
      const spec = COMMANDS[name];
      entry.known = true;
      const why = mutatingFlags(name, args);
      const ops = pathOperands(name, spec, args);
      // Operations that act on everything below a directory operand (the path rules must look inside it).
      const rflag = args.some((a) => /^-[A-Za-z]*[rR]/.test(a.value) || a.value === '--recursive');
      const isRecursive = name === 'rg' || name === 'mv' || (['grep', 'egrep', 'fgrep'].includes(name) && rflag) || (['rm', 'cp', 'chmod', 'chown'].includes(name) && rflag);
      for (const { word, op } of ops) { addPath(word, op); if (isRecursive) entry.paths.at(-1).recursive = true; }
      const writes = entry.paths.some((p) => p.op !== 'read');
      entry.readOnly = spec.cls === 'read' && !why && !writes;
      entry.reason = why ?? (writes ? `${name} writes files` : spec.cls !== 'read' ? `${name} modifies files` : null);
      if (name === 'cd' || name === 'pushd') {
        const target = entry.paths[0];
        if (target?.path) wd = target.path; else if (args.length === 0) { wd = home; } else { wdKnown = false; out.cwdUnknown = true; }
        entry.readOnly = true;
      }
    } else if (PURE.has(name)) {
      entry.known = true; entry.readOnly = true;
      const why = mutatingFlags(name, args);
      if (why) { entry.readOnly = false; entry.reason = why; }
    } else {
      entry.reason = `${name} is not a recognized read-only command`;
    }

    for (const r of c.redirects) {
      if (!r.target) continue;
      if (r.op === '<<' || r.op === '<<-' || r.op === '<<<') continue;      // heredoc / here-string: input, no path
      if (redirectIsWrite(r.op)) {
        if (/^(>&|&>&)$/.test(r.op) && /^(\d+|-)$/.test(r.target.value)) continue;        // 2>&1, >&-
        if (r.target.value === '/dev/null') continue;
        addPath(r.target, 'write');
        entry.redirectWrites = true;
        entry.readOnly = false; entry.reason = entry.reason ?? 'redirects output to a file';
      } else if (r.op === '<' || r.op === '<>') {
        if (r.op === '<>') { addPath(r.target, 'write'); entry.readOnly = false; } else addPath(r.target, 'read');
      } else if (r.op === '<&') { /* fd duplication */ }
    }
    const unresolved = entry.paths.find((p) => p.unresolved);
    if (unresolved && entry.readOnly) { entry.readOnly = false; entry.reason = `a path ${unresolved.unresolved}`; }
    if (!entry.readOnly) out.readOnly = false;
    out.commands.push(entry);
  }
  // cd followed by output redirection: the final directory is not reliably known to the checker
  const hasCd = out.commands.some((c) => c.name === 'cd' || c.name === 'pushd');
  if (hasCd && out.paths.some((p) => p.op !== 'read' && p.command !== 'cd')) out.cdWithWrite = true;
  return out;
}

/** Segments for rule matching (raw text of each simple command) plus whether the whole command is structurally unsafe. */
export function splitSimple(cmd) {
  const { commands, unsafe } = tokenize(cmd);
  return { segments: commands.map((c) => c.raw).filter(Boolean), unsafe: unsafe.length > 0, reasons: unsafe };
}
