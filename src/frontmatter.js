// Minimal frontmatter parser: `key: value`, `key: a, b`, and `key:` followed by `- item` lines.
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const data = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) { data[listKey].push(unquote(item[1])); continue; }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) { listKey = null; continue; }
    if (kv[2] === '') { data[kv[1]] = []; listKey = kv[1]; } else { data[kv[1]] = unquote(kv[2]); listKey = null; }
  }
  return { data, body: m[2] };
}

const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
export const toList = (v) => (Array.isArray(v) ? v : v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
export const toBool = (v, dflt = false) => (v === undefined ? dflt : /^(true|yes|1)$/i.test(String(v)));
