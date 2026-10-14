// OS-level sandbox for shell commands (macOS Seatbelt via /usr/bin/sandbox-exec).
// Architecture follows the bundle (EVIDENCE.md §19): commands are wrapped as `sandbox-exec -p <generated profile> <shell> -c <cmd>`,
// reads are allowed except for denied paths, writes are allowed only under listed roots (minus protected paths), and the network can
// be switched off. Differences, on purpose: the base policy here is `(allow default)` plus file/network restrictions rather than the
// bundle's `(deny default)` with a long list of system-service allowances, and there is no domain-filtering proxy.
import { existsSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap'];

export function resolveBwrap() { return BWRAP_CANDIDATES.find((p) => existsSync(p)) ?? 'bwrap'; }
export function bwrapAvailable(platform = process.platform) { return platform === 'linux' && BWRAP_CANDIDATES.some((p) => existsSync(p)); }

export function sandboxAvailable(platform = process.platform) {
  if (platform === 'darwin') return existsSync(SANDBOX_EXEC);
  if (platform === 'linux') return bwrapAvailable(platform);
  return false;
}

/** The sandbox technology this platform would use, for status text; null when none is available. */
export function sandboxKind(platform = process.platform) {
  if (platform === 'darwin') return 'macOS Seatbelt';
  if (platform === 'linux') return 'Linux bubblewrap';
  return null;
}

const q = (s) => JSON.stringify(s);                       // SBPL string literal (C-style escapes)

/** Seatbelt matches real paths: resolve symlinks (/tmp -> /private/tmp, /var -> /private/var) for anything that exists. */
export function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(realpathSync(cur), ...tail.reverse()); } catch { /* walk up to the nearest existing ancestor */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    tail.push(path.basename(cur));
    cur = parent;
  }
}

/** Paths that must stay unwritable even inside an allowed root: settings, hooks and git config can be used to escape. */
export function protectedWritePaths(cwd) {
  const c = path.resolve(cwd);
  return [
    { kind: 'subpath', path: path.join(c, '.rea') },
    { kind: 'subpath', path: path.join(c, '.claude') },
    { kind: 'subpath', path: path.join(c, '.git', 'hooks') },
    { kind: 'literal', path: path.join(c, '.git', 'config') },
    { kind: 'literal', path: path.join(c, '.mcp.json') },
    { kind: 'subpath', path: path.join(os.homedir(), '.rea') },
  ];
}

/** Translate a permission-rule path pattern (as used by Read/Edit rules) into SBPL filter(s). */
export function patternToFilters(pattern, { cwd, home = os.homedir() }) {
  let base;
  if (pattern.startsWith('//')) base = pattern.slice(1);
  else if (pattern.startsWith('~/')) base = path.join(home, pattern.slice(2));
  else if (pattern.startsWith('/')) base = path.join(cwd, pattern.slice(1));
  else if (pattern.startsWith('./')) base = path.join(cwd, pattern.slice(2));
  else if (!pattern.includes('/')) return [{ kind: 'regex', value: `(^|/)${globToRegex(pattern)}(/|$)` }];   // bare name: any component
  else base = path.join(cwd, pattern);
  if (!/[*?[{]/.test(base)) return [{ kind: 'subpath', path: realish(base) }];                                 // a file or a directory tree
  const g = base.search(/[*?[{]/);
  const literal = base.slice(0, g);
  if (/^(\*\*|\*\*\/\*)?$/.test(base.slice(g))) return [{ kind: 'subpath', path: realish(literal.replace(/\/$/, '') || '/') }];   // dir/** or dir/*
  return [{ kind: 'regex', value: `^${globToRegex(realish(literal.replace(/\/[^/]*$/, '')) + base.slice(literal.lastIndexOf('/')))}$` }];
}

function globToRegex(glob) {
  let s = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { s += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return s;
}

// SBPL regex literals are raw: backslashes are regex escapes, only the quote needs escaping.
const filterText = (f) => (f.kind === 'regex' ? `(regex #"${f.value.replace(/"/g, '\\"')}")` : `(${f.kind} ${q(f.path)})`);

/**
 * Build a Seatbelt profile.
 * @param {object} o
 * @param {string}   o.cwd
 * @param {string[]} [o.writeRoots]   extra directories commands may write to (cwd and temp dirs are always included)
 * @param {object[]} [o.denyWrite]    extra {kind,path|value} filters that stay unwritable
 * @param {object[]} [o.denyRead]     {kind,path|value} filters that cannot be read
 * @param {'allow'|'deny'} [o.network]
 */
export function buildProfile({ cwd, writeRoots = [], denyWrite = [], denyRead = [], network = 'allow', home = os.homedir(), tmpdir = os.tmpdir() }) {
  const roots = [...new Set([realish(cwd), ...writeRoots.map((r) => realish(path.resolve(cwd, r))), realish(tmpdir), '/private/tmp', '/private/var/tmp'])];
  const lines = ['(version 1)', '(allow default)', ''];
  lines.push('; reads: everything, except the denied paths');
  for (const f of denyRead) lines.push(`(deny file-read* ${filterText(f)})`);
  lines.push('', '; writes: nowhere except the allowed roots and a few device files');
  lines.push('(deny file-write*)');
  lines.push(`(allow file-write*${roots.map((r) => `\n  (subpath ${q(r)})`).join('')}`, ')');
  lines.push('(allow file-write*', '  (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (literal "/dev/stdout") (literal "/dev/stderr")', '  (regex #"^/dev/fd/[0-9]+$") (regex #"^/dev/ttys[0-9]+$"))');
  lines.push('', '; protected even inside an allowed root');
  for (const f of [...protectedWritePaths(cwd).map((p) => ({ ...p, path: realish(p.path) })), ...denyWrite]) lines.push(`(deny file-write* ${filterText(f)})`);
  if (network === 'deny') lines.push('', '; network: off', '(deny network*)', '(allow network* (remote unix-socket))', '(allow network-outbound (remote ip "localhost:*"))');
  return `${lines.join('\n')}\n`;
}

/**
 * Build the argv for `bwrap` (own design, not bundle-evidenced: Claude Code's sandbox evidence is Seatbelt-only,
 * EVIDENCE.md §19). Same shape of guarantee as the Seatbelt profile - read everything except denied paths, write
 * only under the given roots minus protected paths, optional network - built from bind mounts instead of SBPL:
 *   - `--ro-bind / /` makes the whole filesystem readable (bwrap's default-deny-everything inverted up front).
 *   - each write root gets a `--bind` on top, making that subtree read-write again.
 *   - protected/denyWrite paths get a `--ro-bind` on top of that, pulling them back to read-only.
 *   - denyRead paths get a `--tmpfs` (directories) or `--ro-bind /dev/null` (files) on top of everything, hiding
 *     their content entirely - stricter than Seatbelt's "exists but unreadable", but bwrap has no read-deny primitive.
 * Later mounts shadow earlier ones at the same or a nested path, which is what makes the layering above work.
 */
export function buildBwrapArgs({ cwd, writeRoots = [], denyWrite = [], denyRead = [], network = 'allow', home = os.homedir(), tmpdir = os.tmpdir() } = {}) {
  const args = ['--die-with-parent', '--unshare-pid', '--proc', '/proc', '--dev', '/dev', '--ro-bind', '/', '/'];
  if (network === 'deny') args.push('--unshare-net');
  const roots = [...new Set([path.resolve(cwd), ...writeRoots.map((r) => path.resolve(cwd, r)), tmpdir, '/tmp', '/var/tmp'])];
  for (const r of roots) if (existsSync(r)) args.push('--bind', r, r);
  for (const f of [...protectedWritePaths(cwd), ...denyWrite]) {
    const p = f.path;
    if (p && existsSync(p)) args.push('--ro-bind', p, p);
  }
  for (const f of denyRead) {
    const p = f.path;
    if (!p || f.kind === 'regex' || !existsSync(p)) continue;    // bwrap binds need concrete paths; regex deny-read is a known gap here
    args.push(...(statSync(p).isDirectory() ? ['--tmpfs', p] : ['--ro-bind', '/dev/null', p]));
  }
  args.push('--chdir', path.resolve(cwd));
  return args;
}

/** Wrap a shell command. Returns {file, args}. */
export function wrapShellCommand(command, profileOptions, { shell = '/bin/sh', platform = process.platform } = {}) {
  if (platform === 'linux') return { file: resolveBwrap(), args: [...buildBwrapArgs(profileOptions), shell, '-c', command] };
  return { file: SANDBOX_EXEC, args: ['-p', buildProfile(profileOptions), shell, '-c', command] };
}

/** Sandbox options derived from permission rules + settings (read/edit deny rules become kernel-enforced). */
export function sandboxOptionsFor({ cwd, rules, settings = {}, home = os.homedir() }) {
  const denyRead = [], denyWrite = [];
  for (const r of rules?.rules?.deny ?? []) {
    const { toolName, ruleContent } = r.rule;
    if (ruleContent === undefined) continue;
    if (toolName === 'Read') denyRead.push(...patternToFilters(ruleContent, { cwd, home }));
    if (toolName === 'Edit' || toolName === 'Write') denyWrite.push(...patternToFilters(ruleContent, { cwd, home }));
  }
  for (const p of settings.denyRead ?? []) denyRead.push(...patternToFilters(p, { cwd, home }));
  for (const p of settings.denyWrite ?? []) denyWrite.push(...patternToFilters(p, { cwd, home }));
  return {
    cwd, home, denyRead, denyWrite, network: settings.network === 'deny' ? 'deny' : 'allow',
    writeRoots: [...(settings.allowWrite ?? []), ...(rules?.additionalDirectories ?? [])],
  };
}
