// Command hooks loaded from settings files. Modelled on Claude Code's documented hook contract
// (JSON on stdin; exit 2 blocks and feeds stderr to the model). The contract details are NOT verified
// from the binary; only the event names and the PreToolUse -> permission ordering are (EVIDENCE.md §2, §4).
//
//   {"hooks":{"PreToolUse":[{"matcher":"Bash","command":"./check.sh"}],"PostToolUse":[...]}}
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCES = (cwd) => [
  ['userSettings', path.join(os.homedir(), '.rea', 'settings.json')],
  ['projectSettings', path.join(cwd, '.rea', 'settings.json')],
  ['localSettings', path.join(cwd, '.rea', 'settings.local.json')],   // personal, meant to be git-ignored
];

/**
 * Admin-controlled settings (EVIDENCE.md §27): read last, so its defaultMode/sandbox config wins over every other
 * source, and its permission rules (being just another source feeding the same deny/ask/allow buckets) can tighten
 * but never be loosened by anything else, since a deny from any source already always beats an allow from any other.
 * No remote/MDM delivery, no policy-helper scripts, no "replace"/"merge" composition modes, no admin-only fields
 * (autoUpdate, modelPricing, provider allowlists) - this is the file-based mechanism only, at rea's own path
 * (the bundle's actual OS paths are product-specific; rea uses its own ".rea"-branded equivalent instead of reusing
 * Claude Code's literal paths).
 */
export function defaultManagedSettingsPath(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/rea/managed-settings.json';
  if (platform === 'linux') return '/etc/rea/managed-settings.json';
  return null;    // no managed-settings convention on other platforms
}

/** The settings file paths for a given cwd, in the order they're merged (used by /config); `--managed-settings` overrides the default path. */
export function settingsSources(cwd, managedSettingsFile) {
  const managedPath = managedSettingsFile ? path.resolve(cwd, managedSettingsFile) : defaultManagedSettingsPath();
  return [...SOURCES(cwd), ...(managedPath ? [['managedSettings', managedPath]] : [])];
}

/** Merge hooks across sources and keep permission rules tagged with the source they came from. */
export function loadSettings(cwd, { managedSettingsFile } = {}) {
  const merged = { hooks: {}, permissionSources: [], defaultMode: undefined, sandbox: undefined, theme: undefined };
  const seen = new Set();   // userSettings and projectSettings can be the same file (e.g. HOME === cwd); don't double-merge it
  for (const [source, f] of settingsSources(cwd, managedSettingsFile)) {
    if (!existsSync(f) || seen.has(f)) continue;
    seen.add(f);
    let json;
    try { json = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw new Error(`Invalid JSON in ${f}: ${e.message}`); }
    for (const [ev, list] of Object.entries(json.hooks ?? {})) (merged.hooks[ev] ??= []).push(...list);
    if (json.sandbox && typeof json.sandbox === 'object') merged.sandbox = { ...(merged.sandbox ?? {}), ...json.sandbox };
    if (json.ui?.theme) merged.theme = json.ui.theme;   // later (more specific) sources win, same as defaultMode
    const p = json.permissions;
    if (p) {
      merged.permissionSources.push({ source, allow: p.allow ?? [], deny: p.deny ?? [], ask: p.ask ?? [], additionalDirectories: p.additionalDirectories ?? [] });
      if (p.defaultMode) merged.defaultMode = p.defaultMode;   // later (more specific) sources win
    }
  }
  return merged;
}

function runCommand(command, payload, { cwd, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: 'failed to start hook' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * Accepts Claude Code's JSON shape. Field names below were found in the bundle (EVIDENCE §5):
 *   hookSpecificOutput.{permissionDecision, permissionDecisionReason, updatedInput, additionalContext, updatedToolOutput}
 * plus the older top-level {decision, reason}. Our flat spelling ({permission, reason, ...}) is also accepted.
 */
export function normalizeHookOutput(j) {
  const h = j.hookSpecificOutput ?? {};
  const out = {};
  const perm = h.permissionDecision ?? j.permission ?? (j.decision === 'approve' ? 'allow' : j.decision === 'block' ? 'deny' : undefined);
  if (perm) out.permission = perm;                 // 'defer' is kept: the harness decides (non-interactive only)
  const reason = h.permissionDecisionReason ?? j.reason;
  if (reason !== undefined) out.reason = reason;
  const updated = h.updatedInput ?? j.updatedInput;
  if (updated) out.updatedInput = updated;
  const ctx = h.additionalContext ?? j.additionalContext;
  if (ctx) out.additionalContext = ctx;
  const replaced = h.updatedToolOutput ?? j.replaceOutput;
  if (typeof replaced === 'string') out.replaceOutput = replaced;
  if (j.continue === false) { out.stop = true; out.reason = j.stopReason ?? out.reason; }
  return out;
}

/** Turn settings.hooks into the function-array form Harness expects. */
export function buildHooks(settings, { cwd, warn = () => {} }) {
  const out = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    out[event] = entries.map((entry) => async (payload) => {
      if (entry.matcher && payload.tool && !new RegExp(`^(?:${entry.matcher})$`).test(payload.tool)) return {};
      // Everything the harness knows about the event, minus internals that are not JSON-safe or are huge.
      const { ctx, messages, error, ...rest } = payload;
      const body = { event, cwd, ...rest, ...(error ? { error: String(error.message ?? error) } : {}) };
      const r = await runCommand(entry.command, body, { cwd });
      if (r.code === 2) return { permission: 'deny', reason: r.stderr.trim() || 'blocked by hook', ...(event === 'Stop' ? { decision: 'block' } : {}) };
      if (r.code !== 0) { warn(`hook "${entry.command}" exited ${r.code}: ${r.stderr.trim()}`); return {}; }
      try { return r.stdout.trim() ? normalizeHookOutput(JSON.parse(r.stdout)) : {}; } catch { return { additionalContext: r.stdout.trim() }; }
    });
  }
  return out;
}
