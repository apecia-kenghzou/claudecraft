// File-watcher-backed hooks: FileChanged, DirectoryAdded (EVIDENCE.md §25).
// FileChanged payload shape is bundle-evidenced: {file_path, event: 'change'|'add'|'unlink'}. The watcher
// itself (fs.watch, the known-paths snapshot used to tell add from unlink) is rea's own design.
import { watch, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_WATCH_IGNORE = /(^|[\\/])(\.git|node_modules|\.rea)([\\/]|$)/;

function snapshot(root, ignore, out = new Set()) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (ignore.test(p)) continue;
    out.add(p);
    if (e.isDirectory()) snapshot(p, ignore, out);
  }
  return out;
}

/**
 * Watches a directory tree and reports {file_path, event} for each change (the FileChanged hook payload).
 * `fs.watch`'s 'rename' event means "added, removed, or renamed"; we disambiguate against a tracked snapshot
 * of known paths rather than re-walking the tree on every event.
 *
 * Recursive watching (`{recursive: true}`) is only supported by Node on macOS and Windows; on Linux this
 * falls back to watching just the root directory non-recursively (nested changes are missed) - a known,
 * documented gap rather than a silent one (README.md "OS sandbox" section's sibling: watch coverage).
 */
export function createFileWatcher(root, { onEvent, ignore = DEFAULT_WATCH_IGNORE } = {}) {
  const known = snapshot(root, ignore);
  const handle = (eventType, filename) => {
    if (!filename) return;
    const abs = path.join(root, filename.toString());
    if (ignore.test(abs)) return;
    if (eventType === 'change') { onEvent({ file_path: abs, event: 'change' }); return; }
    let exists;
    try { const st = statSync(abs); exists = st.isFile() || st.isDirectory(); } catch { exists = false; }
    if (exists && !known.has(abs)) { known.add(abs); onEvent({ file_path: abs, event: 'add' }); }
    else if (!exists && known.has(abs)) { known.delete(abs); onEvent({ file_path: abs, event: 'unlink' }); }
    else if (exists) onEvent({ file_path: abs, event: 'change' });     // some platforms report content edits as 'rename' too
  };
  let watcher, recursive = true;
  try { watcher = watch(root, { recursive: true }, handle); }
  catch { watcher = watch(root, {}, handle); recursive = false; }       // Linux: no recursive support (ERR_FEATURE_UNAVAILABLE_ON_PLATFORM)
  watcher.on('error', () => {});
  return { recursive, close: () => watcher.close() };
}
