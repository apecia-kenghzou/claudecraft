import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHookOutput } from '../src/hooks.js';

test('Claude-style hookSpecificOutput is normalized', () => {
  const o = normalizeHookOutput({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'nope', updatedInput: { a: 1 }, additionalContext: 'ctx' } });
  assert.deepEqual(o, { permission: 'deny', reason: 'nope', updatedInput: { a: 1 }, additionalContext: 'ctx' });
});
test('defer is preserved; legacy decision/reason and continue:false are honoured', () => {
  assert.equal(normalizeHookOutput({ hookSpecificOutput: { permissionDecision: 'defer' } }).permission, 'defer');
  assert.deepEqual(normalizeHookOutput({ decision: 'block', reason: 'r' }), { permission: 'deny', reason: 'r' });
  assert.deepEqual(normalizeHookOutput({ continue: false, stopReason: 'halt' }), { stop: true, reason: 'halt' });
  assert.equal(normalizeHookOutput({ hookSpecificOutput: { updatedToolOutput: 'x' } }).replaceOutput, 'x');
});

import { buildHooks, loadSettings, defaultManagedSettingsPath, settingsSources } from '../src/hooks.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';
import { RuleSet } from '../src/permissions.js';

test('hook commands receive the full event payload (Stop sees the assistant text), without internals', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'rea-hk-'));
  const out = path.join(cwd, 'payload.json');
  const hooks = buildHooks({ hooks: { Stop: [{ command: `cat > ${out}` }] } }, { cwd });
  await hooks.Stop[0]({ text: 'final answer', messages: [{ big: true }], ctx: { x: 1 } });
  const p = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(p.event, 'Stop');
  assert.equal(p.text, 'final answer');
  assert.equal(p.cwd, cwd);
  assert.equal('messages' in p, false);
  assert.equal('ctx' in p, false);
});

test('loadSettings does not double-merge a settings file that is both userSettings and projectSettings (HOME === cwd)', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'rea-hk-'));
  mkdirSync(path.join(cwd, '.rea'));
  writeFileSync(path.join(cwd, '.rea', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ command: 'echo once' }] } }));
  const prevHome = os.homedir();
  process.env.HOME = cwd;
  try {
    const settings = loadSettings(cwd);
    assert.equal(settings.hooks.Stop.length, 1);
  } finally { process.env.HOME = prevHome; }
});

test('defaultManagedSettingsPath: OS-specific, rea-branded path; none on unsupported platforms', () => {
  assert.equal(defaultManagedSettingsPath('darwin'), '/Library/Application Support/rea/managed-settings.json');
  assert.equal(defaultManagedSettingsPath('linux'), '/etc/rea/managed-settings.json');
  assert.equal(defaultManagedSettingsPath('win32'), null);
});

test('managed settings: --managed-settings overrides the default path, is read last, and wins defaultMode/sandbox over every other source', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'rea-hk-'));
  mkdirSync(path.join(cwd, '.rea'));
  writeFileSync(path.join(cwd, '.rea', 'settings.json'), JSON.stringify({
    permissions: { defaultMode: 'acceptEdits', allow: ['Bash(npm run *)'] },
    sandbox: { enabled: false, network: 'allow' },
  }));
  const managed = path.join(cwd, 'managed.json');
  writeFileSync(managed, JSON.stringify({
    permissions: { defaultMode: 'default', deny: ['Bash(rm:*)'] },
    sandbox: { enabled: true },
  }));
  const settings = loadSettings(cwd, { managedSettingsFile: managed });
  assert.equal(settings.defaultMode, 'default');                 // managed wins over project's acceptEdits
  assert.deepEqual(settings.sandbox, { enabled: true, network: 'allow' });   // merged, managed's enabled wins
  const managedSource = settings.permissionSources.find((s) => s.source === 'managedSettings');
  assert.deepEqual(managedSource.deny, ['Bash(rm:*)']);
  // settingsSources() lists it too, after the three file-based sources
  const names = settingsSources(cwd, managed).map(([n]) => n);
  assert.deepEqual(names, ['userSettings', 'projectSettings', 'localSettings', 'managedSettings']);
});

test('managed settings: a managed deny cannot be widened by an allow from any other source', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'rea-hk-'));
  const managed = path.join(cwd, 'managed.json');
  writeFileSync(managed, JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }));
  const settings = loadSettings(cwd, { managedSettingsFile: managed });
  const rules = new RuleSet({ cwd });
  for (const ps of settings.permissionSources) for (const b of ['deny', 'ask', 'allow']) rules.addAll(b, ps[b], ps.source);
  rules.addAll('allow', ['Bash(rm:*)'], 'cliArg');                // a user explicitly allowing it anyway
  const decision = rules.evaluate({ name: 'Bash', permissionContent: () => ({ kind: 'command', value: 'rm -rf x' }) }, { command: 'rm -rf x' });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.source, 'managedSettings');
});

test('no managed-settings file at the default path: loadSettings is unaffected (this dev machine has none)', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'rea-hk-'));
  const settings = loadSettings(cwd);
  assert.equal(settings.permissionSources.some((s) => s.source === 'managedSettings'), false);
});
