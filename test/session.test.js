import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore, loadSession, listSessions, findSession, repairHistory, projectSlug, sessionsDir } from '../src/session.js';
import { Harness, defineTool } from '../src/harness.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'rea-sess-'));
const lines = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const text = (t, usage) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage });
async function drive(h, p) { const g = h.query(p); let s; while (!(s = await g.next()).done); return s.value; }

test('projectSlug replaces non-alphanumerics; transcript dir is per project', () => {
  assert.equal(projectSlug('/Users/a b/proj.x'), '-Users-a-b-proj-x');
  assert.match(sessionsDir('/x/y', '/home/u'), /\/home\/u\/\.rea\/projects\/-x-y$/);
});

test('sync writes linked entries once; file is private; title and last-prompt metadata', () => {
  const home = tmp(), cwd = tmp();
  const st = new SessionStore({ cwd, home });
  const msgs = [{ role: 'user', content: 'build a thing' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }];
  st.sync(msgs); st.sync(msgs);                                   // idempotent
  const e = lines(st.file);
  const m = e.filter((x) => x.type === 'user' || x.type === 'assistant');
  assert.equal(m.length, 2);
  assert.equal(m[0].parentUuid, null);
  assert.equal(m[1].parentUuid, m[0].uuid);
  assert.equal(e.find((x) => x.key === 'title').value, 'build a thing');
  assert.equal(statSync(st.file).mode & 0o777, 0o600);
});

test('load: round-trips messages, survives a torn last line, reads metadata', () => {
  const home = tmp(), cwd = tmp();
  const st = new SessionStore({ cwd, home });
  st.sync([{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }]);
  appendFileSync(st.file, '{"type":"user","uuid":"x","mess');   // crash mid-write
  const l = loadSession(st.file);
  assert.equal(l.messages.length, 2);
  assert.equal(l.title, 'hello');
  assert.equal(l.sessionId, st.sessionId);
});

test('compaction boundary: reload starts at the boundary with summary + kept messages', () => {
  const home = tmp(), cwd = tmp();
  const st = new SessionStore({ cwd, home });
  const old = [{ role: 'user', content: 'old 1' }, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, { role: 'user', content: 'recent' }];
  st.sync(old);
  const after = [{ role: 'user', content: 'SUMMARY', isCompactSummary: true }, old[2]];
  st.recordCompaction({ trigger: 'auto', preTokens: 900, postTokens: 100, summarized: 2 }, after);
  const l = loadSession(st.file);
  assert.deepEqual(l.messages.map((m) => m.content), ['SUMMARY', 'recent']);
  assert.equal(l.messages[0].isCompactSummary, true);
  assert.equal(l.compactions, 1);
  const b = lines(st.file).find((x) => x.subtype === 'compact_boundary');
  assert.equal(b.compactMetadata.preTokens, 900);
  assert.ok(b.logicalParentUuid);
});

test('repairHistory adds synthetic results for dangling tool_use, without replacing originals', () => {
  const m = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'X', input: {} }, { type: 'tool_use', id: 'b', name: 'X', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
  ];
  const r = repairHistory(m);
  assert.equal(r.length, 4);
  assert.ok(r.includes(m[2]));                                          // original object kept
  assert.equal(r[3].synthetic, true);
  assert.equal(r[3].content[0].tool_use_id, 'b');
  const dangling = repairHistory([{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'z', name: 'X', input: {} }] }]);
  assert.equal(dangling.at(-1).content[0].tool_use_id, 'z');
});

test('harness persists as it runs, and a resumed harness continues without rewriting history', async () => {
  const home = tmp(), cwd = tmp();
  const tool = defineTool({ name: 'T', isReadOnly: () => true, call: () => 'out' });
  let n = 0;
  const model = async () => (++n === 1 ? { content: [{ type: 'tool_use', id: 'u', name: 'T', input: {} }], stop_reason: 'tool_use' } : text(`answer ${n}`));
  const st = new SessionStore({ cwd, home });
  const h = new Harness({ model, tools: [tool], store: st });
  await drive(h, 'first question');
  const entries = lines(st.file).filter((x) => x.type === 'user' || x.type === 'assistant');
  assert.equal(entries.length, 4);                                        // user, assistant(tool_use), user(tool_result), assistant

  // resume in a fresh process-like harness
  const loaded = loadSession(st.file);
  const st2 = new SessionStore({ cwd, home, sessionId: loaded.sessionId });
  const h2 = new Harness({ model: async () => text('continued'), tools: [tool], store: st2 });
  h2.messages.push(...loaded.messages);
  st2.adopt(h2.messages, loaded.uuids);
  await drive(h2, 'second question');
  const after = lines(st2.file).filter((x) => x.type === 'user' || x.type === 'assistant');
  assert.equal(after.length, 6);                                          // 4 old + 2 new, no duplicates
  assert.equal(new Set(after.map((x) => x.uuid)).size, 6);
  assert.equal(after[4].parentUuid, after[3].uuid);
});

test('compaction inside a live harness is persisted; /clear rotates to a new session file', async () => {
  const home = tmp(), cwd = tmp();
  const model = async (req) => (req.tools.length === 0 ? text('<summary>S</summary>') : text('reply'));
  const st = new SessionStore({ cwd, home });
  const h = new Harness({ model, tools: [defineTool({ name: 'T', call: () => 'x' })], store: st });
  await drive(h, `a ${'lorem ipsum dolor sit amet '.repeat(500)}`); await drive(h, 'b');
  await h.compact();
  const l = loadSession(st.file);
  assert.equal(l.messages[0].isCompactSummary, true);
  const first = st.file;
  h.clear();
  assert.notEqual(st.file, first);
  await drive(h, 'fresh');
  assert.equal(listSessions(cwd, home).length, 2);
  assert.equal(loadSession(st.file).messages.length, 2);
});

test('listSessions sorts by recency; findSession resolves latest, prefix, ambiguity and misses', () => {
  const home = tmp(), cwd = tmp();
  const a = new SessionStore({ cwd, home, sessionId: 'aaaa1111' }); a.sync([{ role: 'user', content: 'older' }]);
  const b = new SessionStore({ cwd, home, sessionId: 'aaaa2222' }); b.sync([{ role: 'user', content: 'newer' }]);
  appendFileSync(b.file, '\n');
  assert.equal(listSessions(cwd, home)[0].title, 'newer');
  assert.equal(findSession(cwd, 'latest', home).session.title, 'newer');
  assert.equal(findSession(cwd, 'aaaa1', home).session.title, 'older');
  assert.match(findSession(cwd, 'aaaa', home).error, /ambiguous/);
  assert.match(findSession(cwd, 'zzz', home).error, /no session matches/);
  assert.match(findSession(tmp(), 'latest', home).error, /no sessions found/);
});
