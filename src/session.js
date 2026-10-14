// Session persistence: append-only JSONL transcripts, resume, listing.
// Layout and semantics follow what the bundle does (EVIDENCE.md §8): one file per session under a per-project
// directory named from the cwd, one entry per message linked by parentUuid, compaction boundaries that make a
// reload start at the boundary, and metadata entries (title, last prompt). The format here is rea's own.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const FORMAT_VERSION = 1;
export const projectSlug = (cwd) => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
export const sessionsDir = (cwd, home = os.homedir()) => path.join(home, '.rea', 'projects', projectSlug(cwd));

const isToolResultMsg = (m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');

export class SessionStore {
  constructor({ cwd, sessionId = randomUUID(), home = os.homedir(), dir }) {
    this.cwd = path.resolve(cwd);
    this.sessionId = sessionId;
    this.dir = dir ?? sessionsDir(cwd, home);
    this.file = path.join(this.dir, `${sessionId}.jsonl`);
    this.uuids = new WeakMap();  // message object -> uuid already persisted
    this.lastUuid = null;
    this.titled = false;
  }

  #write(entry) {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.file, `${JSON.stringify({ ...entry, sessionId: this.sessionId, timestamp: new Date().toISOString(), cwd: this.cwd, version: FORMAT_VERSION })}\n`, { mode: 0o600 });
  }

  meta(key, value) { this.#write({ type: 'meta', key, value }); }

  /** Persist any messages not yet written, in order. Idempotent; safe to call often. */
  sync(messages) {
    for (const m of messages) {
      if (m.synthetic) continue;   // repair results are recreated on every load; never persisted
      if (this.uuids.has(m)) { this.lastUuid = this.uuids.get(m); continue; }
      const uuid = randomUUID();
      const { role, content, isCompactSummary, isFileAttachment, usage } = m;
      this.#write({ type: role, uuid, parentUuid: this.lastUuid, message: { role, content },
        ...(isCompactSummary ? { isCompactSummary: true } : {}), ...(isFileAttachment ? { isFileAttachment: true } : {}), ...(usage ? { usage } : {}) });
      this.uuids.set(m, uuid);
      this.lastUuid = uuid;
      if (!this.titled && role === 'user' && typeof content === 'string') {
        this.titled = true;
        this.meta('title', content.replace(/\s+/g, ' ').trim().slice(0, 60));
      }
      if (role === 'user' && typeof content === 'string' && !isCompactSummary && !isFileAttachment) this.meta('last-prompt', content.slice(0, 200));
    }
  }

  /** History was replaced by compaction: mark the boundary, then rewrite the new history after it. */
  recordCompaction(record, messages) {
    const uuid = randomUUID();
    this.#write({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid: this.lastUuid,
      compactMetadata: { trigger: record.trigger, preTokens: record.preTokens, postTokens: record.postTokens, messagesSummarized: record.summarized } });
    this.lastUuid = uuid;
    this.uuids = new WeakMap();
    this.sync(messages);
  }

  /** Attach messages loaded from disk so sync() does not write them again. */
  adopt(messages, uuids) {
    messages.forEach((m, i) => { if (uuids[i]) this.uuids.set(m, uuids[i]); });
    this.lastUuid = uuids.filter(Boolean).at(-1) ?? null;
    this.titled = true;
  }

  /** Start a fresh session (used by /clear). */
  rotate(sessionId = randomUUID()) {
    this.sessionId = sessionId;
    this.file = path.join(this.dir, `${sessionId}.jsonl`);
    this.uuids = new WeakMap();
    this.lastUuid = null;
    this.titled = false;
  }
}

function readEntries(file) {
  const entries = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* torn final line after a crash: skip */ }
  }
  return entries;
}

/**
 * Make a loaded history valid for the API: every tool_use needs a tool_result in the next user message.
 * Interrupted sessions (crash, Ctrl-C) leave dangling tool_use blocks. Original message objects are never
 * replaced; missing results go in a new `synthetic` user message (consecutive user messages are valid).
 */
export function repairHistory(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const ids = m.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (!ids.length) continue;
    const next = messages[i + 1];
    const have = new Set(next && isToolResultMsg(next) ? next.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : []);
    const missing = ids.filter((id) => !have.has(id)).map((id) => ({
      type: 'tool_result', tool_use_id: id, is_error: true,
      content: '<tool_use_error>Interrupted before this tool finished (session resumed).</tool_use_error>',
    }));
    if (!missing.length) continue;
    if (next && isToolResultMsg(next)) { out.push(next); i++; }   // keep the partial results message as is
    out.push({ role: 'user', content: missing, synthetic: true });
  }
  return out;
}

/** Load a session: messages after the last compaction boundary, repaired, plus metadata. */
export function loadSession(file) {
  const entries = readEntries(file);
  let start = 0;
  entries.forEach((e, i) => { if (e.type === 'system' && e.subtype === 'compact_boundary') start = i + 1; });
  const msgEntries = entries.slice(start).filter((e) => (e.type === 'user' || e.type === 'assistant') && e.message);
  const messages = msgEntries.map((e) => ({ role: e.message.role, content: e.message.content, ...(e.isCompactSummary ? { isCompactSummary: true } : {}), ...(e.isFileAttachment ? { isFileAttachment: true } : {}) }));
  const uuidOf = new Map(messages.map((m, i) => [m, msgEntries[i].uuid]));
  const meta = {};
  for (const e of entries) if (e.type === 'meta') meta[e.key] = e.value;
  const sessionId = entries.find((e) => e.sessionId)?.sessionId ?? path.basename(file, '.jsonl');
  const repaired = repairHistory(messages);
  return {
    sessionId, file, messages: repaired,
    uuids: repaired.map((m) => uuidOf.get(m)),
    title: meta.title, lastPrompt: meta['last-prompt'], tasks: (() => { try { return JSON.parse(meta.tasks ?? '[]'); } catch { return []; } })(),
    compactions: entries.filter((e) => e.subtype === 'compact_boundary').length,
  };
}

export function listSessions(cwd, home = os.homedir()) {
  const dir = sessionsDir(cwd, home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => {
    const file = path.join(dir, f);
    const entries = readEntries(file);
    const meta = {};
    for (const e of entries) if (e.type === 'meta') meta[e.key] = e.value;
    return {
      sessionId: path.basename(f, '.jsonl'), file, mtimeMs: statSync(file).mtimeMs,
      title: meta.title ?? '(untitled)', lastPrompt: meta['last-prompt'],
      messages: entries.filter((e) => e.type === 'user' || e.type === 'assistant').length,
    };
  }).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Resolve "latest", a full id, or a unique id prefix. */
export function findSession(cwd, ref, home = os.homedir()) {
  const all = listSessions(cwd, home);
  if (!all.length) return { error: `no sessions found for ${path.resolve(cwd)}` };
  if (ref === 'latest') return { session: all[0] };
  const hits = all.filter((s) => s.sessionId === ref || s.sessionId.startsWith(ref));
  if (hits.length === 1) return { session: hits[0] };
  return { error: hits.length ? `ambiguous session id "${ref}" (${hits.length} matches)` : `no session matches "${ref}"` };
}
