// Agent harness modelled on Claude Code's runtime (see EVIDENCE.md §2 and §4).
// Per-tool pipeline, in the order found in the bundle (fns l2 -> GWo -> KWo):
//   lookup -> parse JSON -> schema -> tool.validateInput -> PreToolUse hooks -> permission -> call -> PostToolUse
// Every failure becomes an is_error tool_result wrapped in <tool_use_error>, never a throw.
import { ToolExecutor } from './executor.js';
import { RuleSet, formatRule } from './permissions.js';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { planModeReminder } from './plan.js';
import { STRUCTURED_OUTPUT_TOOL_NAME, STRUCTURED_OUTPUT_REMINDER } from './structured.js';
import {
  BLOCK_MARGIN, DEFAULT_CONTEXT_WINDOW, MIN_COMPACT_GAIN, MIN_HEADROOM, buildFileAttachments, microCompact, parseUserMessages, compactMessages, compactThreshold, contextLevel, effectiveWindow, estimateMessages,
  estimateTokens, nextRefillState, usageTokens,
} from './context.js';

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'UserPromptSubmit', 'Stop', 'PreCompact', 'PostCompact',
  'WorktreeCreate', 'WorktreeRemove',
  'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'InstructionsLoaded', 'PermissionRequest', 'PermissionDenied', 'StopFailure',
  'Notification', 'UserPromptExpansion', 'PreModelSwitch', 'PostModelSwitch', 'TaskCreated', 'TaskCompleted',
  'FileChanged', 'DirectoryAdded', 'Elicitation', 'ElicitationResult'];

/** Fail-closed defaults, like Claude Code's tool defaults (isConcurrencySafe/isReadOnly/isDestructive = false). */
export function defineTool(def) {
  if (!def.name || typeof def.call !== 'function') throw new Error('tool needs name and call()');
  return {
    description: '',
    inputSchema: { type: 'object', properties: {}, required: [] },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isEnabled: () => true,
    ...def,
  };
}

/** Minimal JSON-schema subset: required keys, primitive/array/object types, enum. Unknown keys are ignored. */
const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  null: (v) => v === null,
};

export function validateInput(schema, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  for (const key of schema.required ?? []) if (!(key in input)) return `missing required field "${key}"`;
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (!(key in input)) continue;
    const v = input[key];
    const types = [].concat(spec.type ?? []);
    if (types.length && !types.some((t) => TYPE_CHECKS[t]?.(v) ?? true)) return `field "${key}" must be ${types.join(' or ')}`;
    if (spec.enum && !spec.enum.includes(v)) return `field "${key}" must be one of ${spec.enum.join(', ')}`;
  }
  return null;
}

const toolError = (id, msg, extra = {}) => ({
  type: 'tool_result', tool_use_id: id, is_error: true, content: `<tool_use_error>${msg}</tool_use_error>`, ...extra,
});

export class Harness {
  /**
   * @param {object} o
   * @param {(req:{system:string,messages:object[],tools:object[],signal?:AbortSignal})=>Promise<{content:object[]}>} o.model
   * @param {object[]} o.tools                 from defineTool()
   * @param {string}   [o.permissionMode]      one of PERMISSION_MODES
   * @param {Record<string,Function[]>} [o.hooks]
   * @param {(req:{tool:object,input:object})=>Promise<boolean>|boolean} [o.askUser]
   * @param {string[]} [o.allow] [o.deny]      tool names pre-approved / always denied
   */
  constructor({ model, tools, permissionMode = 'default', hooks = {}, askUser, allow = [], deny = [],
    system = '', maxTurns = 25, maxConcurrency, signal, onEvent,
    contextWindow = Number(process.env.REA_CONTEXT_WINDOW) || DEFAULT_CONTEXT_WINDOW, maxOutputTokens = 8192,
    autoCompact = process.env.REA_AUTOCOMPACT !== '0', compactBufferFraction, compactPct = Number(process.env.REA_AUTOCOMPACT_PCT_OVERRIDE) || undefined, store, rules, cwd = process.cwd(), memory = '', compactionExtra, nonInteractive = false, refusalFallbackModel, recentFiles, sandboxAutoAllow = false,
    microCompact: microCompactOn = process.env.REA_MICROCOMPACT !== '0' }) {
    if (!PERMISSION_MODES.includes(permissionMode)) throw new Error(`bad permissionMode ${permissionMode}`);
    this.rules = rules ?? new RuleSet({ cwd });
    Object.assign(this, { model, permissionMode, hooks, askUser, allow: new Set(allow), deny: new Set(deny),
      system, maxTurns, maxConcurrency, signal, onEvent });
    this.messages = []; // conversation persists across run() calls
    Object.assign(this, { contextWindow, maxOutputTokens, autoCompact, compactBufferFraction, compactPct, store, memory, compactionExtra, nonInteractive, refusalFallbackModel, recentFiles, microCompactOn, sandboxAutoAllow });
    this.lastUsage = null;       // { tokens, at } from the last API response
    this.compactState = null;    // { compacted, turnCounter, consecutiveRapidRefills }
    this.compactFailures = 0;
    this.stopRequested = null;           // set by requestStop(): end the turn at the next step boundary
    this.queued = [];                    // messages typed while a turn runs; folded in at the next boundary
    this.lastCacheRead = 0;
    this.userPrompts = [];               // every real user prompt, kept verbatim across compactions
    this.autoCompactSuspended = false;   // set when the breaker trips; cleared by /compact, /clear or when context recovers
    this.compactions = [];       // log of completed compactions
    this.planFile = null;        // set by the host (CLI); the only file writable in plan mode
    this.prePlanMode = null;     // mode to restore when a plan is approved
    this.isSubAgent = false;
    this.activeWorktree = null;          // { path, branch, originalCwd } while EnterWorktree is active
    this.unlockedDeferred = new Set();   // names of deferred tools whose schema ToolSearch has revealed this session
    this.usageTotals = { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    this.tools = new Map(tools.filter((t) => t.isEnabled()).map((t) => [t.name, t]));
  }

  async #emit(event, payload) {
    const out = [];
    for (const fn of this.hooks[event] ?? []) out.push((await fn(payload)) ?? {});
    return out;
  }

  // Claude: parse (JSON string allowed) -> schema safeParse -> only then ask the tool if it is concurrency-safe;
  // a throwing isConcurrencySafe counts as unsafe (fn $a).
  #isSafe(block) {
    const tool = this.tools.get(block.name);
    if (!tool) return false;
    const input = this.#parse(block.input);
    if (input.error || validateInput(tool.inputSchema, input.value) !== null) return false;
    try { return Boolean(tool.isConcurrencySafe(input.value)); } catch { return false; }
  }

  #parse(raw) {
    if (typeof raw !== 'string') return { value: raw };
    try { return { value: JSON.parse(raw) }; } catch {
      return { error: `InputValidationError: input could not be parsed as JSON.\nYou sent (first ${Math.min(200, raw.length)} of ${raw.length} bytes): ${raw.slice(0, 200)}\n`
        + 'Common causes: unescaped backslashes in file paths, unescaped control characters, or truncated output. Retry with valid JSON.' };
    }
  }

  /**
   * Decision order: tool-name deny list -> deny rules -> hook deny -> ask rules -> hook allow / allow rules ->
   * workspace boundary -> mode. Deny rules apply even in bypassPermissions.
   */
  async #permit(tool, input, hookPermission) {
    const label = `${tool.name}${tool.permissionContent?.(input, this.rules)?.value !== undefined ? ` ${JSON.stringify(tool.permissionContent(input, this.rules).value)}` : ''}`;
    if (this.deny.has(tool.name)) return { ok: false, reason: `tool ${tool.name} is denied by policy` };
    const r = this.rules.evaluate(tool, input);
    if (r.behavior === 'deny') return { ok: false, reason: `${label} is denied by rule ${r.rule} (${r.source})${r.detail ? `: ${r.detail}` : ''}` };
    if (hookPermission?.behavior === 'deny') return { ok: false, reason: hookPermission.reason ?? 'denied by PreToolUse hook', fromHook: true };

    // A hook `defer` ends a solo call in a non-interactive session so the host can decide; otherwise it behaves like `ask`.
    if (hookPermission?.behavior === 'defer' && this.nonInteractive && !this.isSubAgent && this.#batchSize === 1) {
      return { ok: false, deferred: true, reason: hookPermission.reason ?? 'deferred by a PreToolUse hook' };
    }
    let mustAsk = r.behavior === 'ask' || hookPermission?.behavior === 'ask' || hookPermission?.behavior === 'defer';
    const content = tool.permissionContent?.(input, this.rules);
    // In plan mode the plan file is the one thing that may be written.
    if (this.permissionMode === 'plan' && this.planFile && content?.kind === 'path') {
      const target = path.resolve(content.value), plan = path.resolve(this.planFile);
      if (tool.isEdit?.(input) && target === plan) return { ok: true };
      // reading the plan file (or listing its directory) is part of revising the plan
      if (tool.isReadOnly(input) && (target === plan || target === path.dirname(plan))) return { ok: true };
    }
    let outside = content?.kind === 'path' && !this.rules.inWorkspace(content.value);
    let shellNote;
    if (content?.kind === 'command') {
      const a = this.rules.analyze(content.value);
      const stray = a.paths.find((p) => p.path && !this.rules.inWorkspace(p.path));
      const unknown = a.paths.find((p) => p.unresolved);
      if (stray) { outside = true; shellNote = `touches ${stray.path}, outside the working directories`; }
      else if (unknown) { outside = true; shellNote = `uses a path that cannot be checked ("${unknown.raw}" ${unknown.unresolved})`; }
      else if (a.cdWithWrite) { outside = true; shellNote = 'changes directory and writes in the same command'; }
    }
    const ruleAllowed = r.behavior === 'allow' || this.allow.has(tool.name);
    if (!mustAsk && (hookPermission?.behavior === 'allow' || ruleAllowed)) return { ok: true };
    // A command that runs inside the OS sandbox is confined by the kernel, so it needs no prompt (plan mode stays read-only).
    if (!mustAsk && this.sandboxAutoAllow && this.permissionMode !== 'plan' && tool.sandboxed?.(input)) return { ok: true };
    if (this.permissionMode === 'bypassPermissions' && !mustAsk) return { ok: true };
    if (outside) mustAsk = true;   // outside the working directories: never auto-approved by mode

    const readOnly = tool.isReadOnly(input);
    if (!mustAsk) {
      switch (this.permissionMode) {
        case 'plan': return readOnly ? { ok: true } : { ok: false, reason: 'plan mode: only read-only tools may run' };
        case 'dontAsk': return readOnly ? { ok: true } : { ok: false, reason: 'dontAsk mode: tool not pre-approved' };
        case 'acceptEdits': if (readOnly || tool.isEdit?.(input)) return { ok: true }; break;
        default: if (readOnly) return { ok: true };
      }
    } else if (this.permissionMode === 'plan' || this.permissionMode === 'dontAsk') {
      return { ok: false, reason: `${this.permissionMode} mode: ${label} needs approval` };
    }
    // PermissionRequest hooks can answer on the user's behalf (allow/deny) before anyone is prompted.
    for (const h of await this.#emit('PermissionRequest', { tool: tool.name, input, label })) {
      if (h.permission === 'allow') return { ok: true };
      if (h.permission === 'deny') return { ok: false, reason: h.reason ?? 'denied by a PermissionRequest hook', fromHook: true };
    }
    if (!this.askUser) return { ok: false, reason: `permission required for ${label} but no askUser handler is configured` };
    const answer = await this.askUser({ tool, input, label, rule: r.behavior === 'ask' ? r.rule : undefined, outsideWorkspace: outside, note: r.detail ?? shellNote });
    if (answer === 'always' && !outside) {
      const rule = formatRule({ toolName: tool.name, ruleContent: content?.kind === 'command' ? content.value : undefined });
      try { this.rules.add('allow', rule, 'session'); } catch { /* unparsable: just allow this once */ }
      return { ok: true };
    }
    return answer ? { ok: true } : { ok: false, reason: 'user denied permission' };
  }

  async #runOne(block, ctx, signal, extra) {
    const tool = this.tools.get(block.name);
    if (!tool) return toolError(block.id, `Error: No such tool available: ${block.name}`);

    const parsed = this.#parse(block.input);
    if (parsed.error) return toolError(block.id, parsed.error);
    let input = parsed.value;
    const bad = validateInput(tool.inputSchema, input);
    if (bad) return toolError(block.id, `InputValidationError: ${bad}`);

    const v = await tool.validateInput?.(input, ctx);
    if (v && v.ok === false) return toolError(block.id, v.message, v.remedy ? { remedy: v.remedy } : {});

    // PreToolUse hooks run BEFORE the permission decision and feed into it.
    let hookPermission, stopReason;
    for (const r of await this.#emit('PreToolUse', { tool: tool.name, input, ctx })) {
      if (r.updatedInput) input = r.updatedInput;
      if (r.permission) hookPermission = { behavior: r.permission, reason: r.reason };
      if (r.decision === 'deny') hookPermission = { behavior: 'deny', reason: r.reason }; // 0.1 spelling
      if (r.additionalContext) extra.push(r.additionalContext);
      if (r.stop) stopReason = r.reason ?? 'no reason given';
    }
    if (stopReason !== undefined) return toolError(block.id, `Execution stopped by PreToolUse hook: ${stopReason}`);

    const perm = await this.#permit(tool, input, hookPermission);
    if (!perm.ok) {
      await this.#emit('PermissionDenied', { tool: tool.name, input, reason: perm.reason, deferred: !!perm.deferred });
      if (perm.deferred) return toolError(block.id, `Tool call deferred: ${perm.reason}`, { deferred: true, deferredCall: { id: block.id, name: tool.name, input } });
      return toolError(block.id, `Permission denied: ${perm.reason}`, { denial: perm.fromHook ? 'hook' : 'permission' });
    }

    try {
      const output = await tool.call(input, ctx, signal);
      let content = typeof output === 'string' ? output : JSON.stringify(output);
      for (const r of await this.#emit('PostToolUse', { tool: tool.name, input, output: content, ctx })) {
        if (typeof r.replaceOutput === 'string') content = r.replaceOutput;
      }
      return { type: 'tool_result', tool_use_id: block.id, content };
    } catch (err) {
      await this.#emit('PostToolUseFailure', { tool: tool.name, input, error: err, ctx });
      return toolError(block.id, `Error calling tool (${tool.name}): ${err.message}`);
    }
  }

  #batchSize = 0;

  #systemPrompt() {
    const parts = [this.system];
    if (this.memory) parts.push(this.memory);
    if (this.permissionMode === 'plan' && this.planFile) parts.push(planModeReminder(this.planFile));
    if (this.tools.has(STRUCTURED_OUTPUT_TOOL_NAME)) parts.push(STRUCTURED_OUTPUT_REMINDER);
    const locked = [...this.tools.values()].filter((t) => t.deferred && !this.unlockedDeferred.has(t.name));
    if (locked.length) {
      parts.push(`The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them `
        + `directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool `
        + `schemas before calling them:\n${locked.map((t) => t.name).join('\n')}`);
    }
    return parts.join('\n\n');
  }

  /** Ask the loop to stop cleanly at the next step boundary (not an abort: tool results are kept). */
  requestStop(why = 'requested') { this.stopRequested = why; }

  /** Queue a user message to be folded into the running turn at its next boundary. */
  queueMessage(text) { if (typeof text === 'string' && text.trim()) this.queued.push(text); }

  setPermissionMode(mode) {
    if (!PERMISSION_MODES.includes(mode)) throw new Error(`bad permissionMode ${mode}`);
    this.permissionMode = mode;
  }

  enterPlanMode() {
    if (this.permissionMode !== 'plan') this.prePlanMode = this.permissionMode;
    this.permissionMode = 'plan';
  }

  /** Leave plan mode, restoring the previous mode unless a different one is given. */
  exitPlanMode(mode) {
    const back = mode ?? this.prePlanMode ?? 'default';
    this.permissionMode = back === 'plan' ? 'default' : back;
    this.prePlanMode = null;
  }

  #toolDefs() {
    return [...this.tools.values()]
      .filter((t) => !t.deferred || this.unlockedDeferred.has(t.name))
      .map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema }));
  }

  /**
   * Current context size: last API-reported usage plus an estimate for what was added since.
   * The compaction threshold never sits closer than MIN_HEADROOM to the fixed overhead (system prompt, tool definitions,
   * memory), otherwise a small window would compact on every turn and never recover.
   */
  contextStatus() {
    const window = effectiveWindow(this.contextWindow, this.maxOutputTokens);
    const baseline = estimateTokens(this.#systemPrompt()) + estimateTokens(JSON.stringify(this.#toolDefs()));
    const tokens = this.lastUsage && this.lastUsage.at <= this.messages.length
      ? this.lastUsage.tokens + estimateMessages(this.messages.slice(this.lastUsage.at))
      : estimateMessages(this.messages) + baseline;
    let threshold = compactThreshold(window, { bufferFraction: this.compactBufferFraction, pctOverride: this.compactPct });
    const floor = baseline + Math.max(MIN_HEADROOM, Math.round(window * 0.1));
    const feasible = floor < window - BLOCK_MARGIN - 1000;
    if (feasible && threshold < floor) threshold = floor;
    return { tokens, window, threshold, baseline, feasible, ...contextLevel(tokens, window, { enabled: this.autoCompact, threshold }) };
  }

  async #callPlain(req) {
    const r = this.model(req);
    if (r && typeof r[Symbol.asyncIterator] === 'function') {
      let step;
      while (!(step = await r.next()).done); // swallow streaming events
      return step.value;
    }
    return await r;
  }

  /** Compact history in place. Yields events; returns { ok, terminal?, result? }. */
  async *#compact(trigger, instructions, ctx) {
    const refill = nextRefillState(this.compactState);
    if (trigger !== 'manual' && refill.action === 'trip') {
      this.autoCompactSuspended = true;   // do not brick the session: later turns proceed until /compact, /clear or recovery
      yield { type: 'warning', message: 'Autocompact is thrashing: the context refilled within 3 turns of the previous compaction, 3 times in a row. '
        + 'A file or tool output is probably too large (or the context budget is too small for your tool set); read in smaller pieces, '
        + 'use /compact or /clear, or raise --context-window. Auto-compaction is paused.' };
      return { ok: false, terminal: { reason: 'rapid_refill_breaker', turns: 0, text: '' } };
    }
    const pre = await this.#emit('PreCompact', { trigger, ctx });
    if (pre.some((r) => r.stop || r.permission === 'deny')) {
      yield { type: 'warning', message: 'Compaction blocked by PreCompact hook' };
      return { ok: false };
    }
    const before = this.contextStatus().tokens;
    yield { type: 'compact_start', trigger, tokens: before };
    let result;
    try {
      result = await compactMessages({
        messages: this.messages, callModel: (req) => this.#callPlain(req), instructions, signal: this.signal,
        userMessages: this.userPrompts, extra: this.compactionExtra?.() ?? '',
      });
    } catch (err) {
      if (err.kind === 'not_worth_it') {            // nothing to gain: not a failure, and it must not count toward the breaker
        yield { type: 'compact_skipped', reason: err.message };
        return { ok: false, skipped: true };
      }
      this.compactFailures++;
      yield { type: 'warning', message: `Compaction failed: ${err.message}` };
      return { ok: false, error: err };
    }
    // Re-attach the files being worked on (current disk contents) so the model is not left with only a summary of them.
    let attachment = null;
    if (this.recentFiles) {
      const status = this.contextStatus();
      // Attachments may spend at most half of what the summary freed, so a compaction always nets a real reduction.
      const freed = Math.max(0, result.preTokens - result.postTokens);
      const budget = Math.min(20000, Math.floor(status.window * 0.1), Math.floor(freed * 0.5));
      const a = budget < 400 ? { message: null } : buildFileAttachments(this.recentFiles(), {
        totalTokens: budget, read: (p) => { if (statSync(p).size > 400_000) return null; return readFileSync(p, 'utf8'); },
      });
      if (a.message) { attachment = a; result.messages.splice(1, 0, a.message); result.postTokens += a.tokens; }
    }
    // A compaction that does not shrink the context is worse than none: keep the history and count a failure.
    if (result.postTokens > result.preTokens - MIN_COMPACT_GAIN) {
      this.compactFailures++;
      yield { type: 'warning', message: `Compaction would not reduce the context (~${result.preTokens} -> ~${result.postTokens}); keeping the history.` };
      return { ok: false, unproductive: true };
    }
    this.messages.splice(0, this.messages.length, ...result.messages);
    this.lastUsage = null;
    this.lastCacheRead = 0;
    this.compactFailures = 0;
    this.autoCompactSuspended = false;
    this.compactState = { compacted: true, turnCounter: 0, consecutiveRapidRefills: refill.consecutiveRapidRefills };
    const record = { trigger, preTokens: before, postTokens: this.contextStatus().tokens, summarized: result.summarized, kept: result.kept, dropped: result.dropped,
      reattached: attachment?.files.map((f) => f.path) ?? [] };
    this.compactions.push(record);
    this.store?.recordCompaction(record, this.messages);
    await this.#emit('PostCompact', { trigger, ...record, ctx });
    yield { type: 'compact_end', ...record, summary: result.summary };
    return { ok: true, result: record };
  }

  /** A new harness that shares this one's model, rules, hooks and prompts-to-user, with its own tools and history. */
  fork({ tools, system, memory = '', permissionMode = this.permissionMode, maxTurns = this.maxTurns, store, signal = this.signal, onEvent, hooks = this.hooks }) {
    const child = new Harness({
      model: this.model, tools, permissionMode, hooks, askUser: this.askUser, rules: this.rules,
      allow: [...this.allow], deny: [...this.deny], system, maxTurns, maxConcurrency: this.maxConcurrency, signal, onEvent,
      contextWindow: this.contextWindow, maxOutputTokens: this.maxOutputTokens, autoCompact: this.autoCompact,
      compactBufferFraction: this.compactBufferFraction, compactPct: this.compactPct, store, cwd: this.rules.cwd, memory,
    });
    child.isSubAgent = true;
    return child;
  }

  emitHook(event, payload) { return this.#emit(event, payload); }

  /** One-shot, tool-less completion with the same model (used for page extraction, /init-style helpers). */
  async complete({ system, prompt, signal = this.signal }) {
    const reply = await this.#callPlain({ system, messages: [{ role: 'user', content: prompt }], tools: [], signal });
    return reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  /** Manual compaction (e.g. a /compact command). Returns the compaction record, or null if it did not run. */
  async compact(instructions, ctx = {}) {
    const gen = this.#compact('manual', instructions, ctx);
    let step;
    while (!(step = await gen.next()).done) this.onEvent?.(step.value);
    return step.value.ok ? step.value.result : null;
  }

  /** Rebuild the verbatim prompt list from a loaded history (plain user messages + the list inside a leading summary). */
  restoreUserPrompts() {
    const out = [];
    for (const m of this.messages) {
      if (m.role !== 'user' || typeof m.content !== 'string') continue;
      if (m.isCompactSummary) { out.splice(0, out.length, ...parseUserMessages(m.content)); continue; }
      if (m.isFileAttachment) continue;
      // the latest prompt is kept verbatim after the summary and also listed inside it: do not count it twice
      const clipped = m.content.replace(/\s+/g, ' ').trim();
      const last = out.at(-1);
      if (last !== undefined && (last === clipped || (last.endsWith('…') && clipped.startsWith(last.slice(0, -1))))) continue;
      out.push(m.content);
    }
    this.userPrompts = out;
  }

  clear() {
    this.userPrompts = [];
    this.messages.length = 0;
    this.autoCompactSuspended = false;
    this.lastUsage = null;
    this.compactState = null;
    this.store?.rotate();
  }

  async sessionStart(source = 'startup', ctx = {}) { await this.#emit('SessionStart', { source, ctx }); }
  async sessionEnd(reason = 'exit', ctx = {}) { this.store?.sync(this.messages); await this.#emit('SessionEnd', { reason, ctx }); }

  async *#callModel(req) {
    const r = this.model(req);
    if (r && typeof r[Symbol.asyncIterator] === 'function') return yield* r; // streaming model
    return await r;                                                         // plain async function
  }

  /**
   * The agent loop as an async generator (the shape found in Claude Code, ARCHITECTURE.md §2).
   * Yields UI events and RETURNS a terminal `{reason, ...}`. Re-entry happens through named transitions.
   *
   * terminal reasons: completed | max_turns | model_error | prompt_too_long | aborted_streaming | aborted_tools |
   *   hook_stopped | malformed_tool_use_exhausted | max_output_tokens_exhausted
   * transitions:      next_turn | max_output_tokens_recovery | malformed_tool_use_retry | thinking_only_retry |
   *   stop_hook_blocking
   */
  async *query(prompt, ctx = {}) {
    const messages = this.messages;
    messages.push({ role: 'user', content: prompt });
    if (typeof prompt === 'string' && prompt.trim()) { this.userPrompts.push(prompt); if (this.userPrompts.length > 200) this.userPrompts.shift(); }
    for (const r of await this.#emit('UserPromptSubmit', { prompt, ctx })) {
      if (r.decision === 'deny' || r.permission === 'deny') {
        yield { type: 'warning', message: `Prompt blocked: ${r.reason ?? ''}` };
        return { reason: 'hook_stopped', turns: 0, text: `Prompt blocked: ${r.reason ?? ''}` };
      }
    }
    const meta = (content) => ({ role: 'user', content });
    const g = { turns: 0, outputRecovery: 0, malformedRetried: false, thinkingNudged: false, stopHookBlocks: 0, reactiveTried: false, warned: false, refusalRetrySpent: false, restoreModel: null };
    const stopCap = Number(process.env.REA_STOP_HOOK_BLOCK_CAP ?? 8);

    try {
    for (;;) {
      this.store?.sync(messages);
      if (this.signal?.aborted) return { reason: 'aborted_streaming', turns: g.turns, text: '' };
      if (this.stopRequested) {
        const why = this.stopRequested; this.stopRequested = null;
        yield { type: 'warning', message: `Stopped at a step boundary (${why}).` };
        return { reason: 'background_requested', turns: g.turns, text: '', why };
      }
      // Things the user typed while the agent was working join the conversation at this boundary.
      while (this.queued.length) {
        const q = this.queued.shift();
        messages.push({ role: 'user', content: `[The user sent this while you were working]\n${q}` });
        this.userPrompts.push(q);
        yield { type: 'absorbed_mid_turn', text: q };
      }
      if (g.turns >= this.maxTurns) {
        yield { type: 'max_turns_reached', maxTurns: this.maxTurns };
        return { reason: 'max_turns', turns: g.turns, text: '' };
      }

      // Cheap relief first: clear old, large tool results once the context is most of the way to the threshold.
      let ctxStatus = this.contextStatus();
      if (this.microCompactOn && this.autoCompact && ctxStatus.tokens >= ctxStatus.threshold * 0.7) {
        const mc = microCompact(messages);
        if (mc.cleared > 0) {
          this.lastUsage = null;
          this.lastCacheRead = 0;
          yield { type: 'micro_compact', cleared: mc.cleared, freedTokens: mc.freedTokens };
        }
      }
      // Context guard: warn, auto-compact, or refuse to call the model when the window is exhausted.
      ctxStatus = this.contextStatus();
      if (ctxStatus.level === 'compact' || ctxStatus.level === 'blocked') {
        let c = { ok: false };
        if (this.autoCompact && !this.autoCompactSuspended && this.compactFailures < 3) {
          c = yield* this.#compact('auto', undefined, ctx);
          if (c.terminal) return c.terminal;
        }
        if (!c.ok && ctxStatus.level === 'blocked') {
          yield { type: 'warning', message: `Context is full (${ctxStatus.tokens}/${ctxStatus.window} tokens). Run /compact or /clear.` };
          return { reason: 'blocking_limit', turns: g.turns, text: '' };
        }
      } else if (ctxStatus.level === 'ok' || ctxStatus.level === 'warn') {
        if (this.autoCompactSuspended) this.autoCompactSuspended = false;     // the context recovered
        if (ctxStatus.level === 'warn' && !g.warned) {
          g.warned = true;
          yield { type: 'context_warning', pctLeft: ctxStatus.pctLeft };
        }
      }

      let reply;
      try {
        // recomputed each turn: ToolSearch can unlock a deferred tool's schema mid-query
        reply = yield* this.#callModel({ system: this.#systemPrompt(), messages, tools: this.#toolDefs(), signal: this.signal });
      } catch (err) {
        if (this.signal?.aborted) return { reason: 'aborted_streaming', turns: g.turns, text: '' };
        if (err.kind === 'prompt_too_long' && !g.reactiveTried && this.autoCompact) {
          g.reactiveTried = true; // one reactive compaction per query
          const c = yield* this.#compact('reactive', undefined, ctx);
          if (c.terminal) return c.terminal;
          if (c.ok) continue;
        }
        yield { type: 'error', error: err };
        const apiError = err.name === 'ModelError';
        const isImage = apiError && err.kind === 'invalid_request' && /\b(image|media|pdf|document)\b/i.test(err.message);
        const reason = err.kind === 'prompt_too_long' ? 'prompt_too_long' : isImage ? 'image_error' : apiError ? 'api_error' : 'model_error';
        if (g.restoreModel) { this.model.setModel?.(g.restoreModel); g.restoreModel = null; }
        if (reason === 'api_error' || reason === 'model_error') await this.#emit('StopFailure', { reason, kind: err.kind, error: err.message });
        return { reason, error: err, errorKind: err.kind, isTransient: Boolean(err.retryable), turns: g.turns, text: '' };
      }
      g.turns++;
      g.reactiveTried = false;
      if (g.restoreModel) { this.model.setModel?.(g.restoreModel); g.restoreModel = null; }
      if (reply.usage) {
        const t = this.usageTotals; t.requests++;
        for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens']) t[k] += reply.usage[k] ?? 0;
      }
      if (this.compactState?.compacted) this.compactState.turnCounter++;
      {
        // Prompt-cache coverage: a sudden drop to zero cached tokens after hits means the prefix changed or the cache expired.
        const cr = reply.usage?.cache_read_input_tokens;
        if (cr !== undefined) {
          if (this.lastCacheRead > 0 && cr === 0 && g.turns > 1) {
            this.usageTotals.cache_misses = (this.usageTotals.cache_misses ?? 0) + 1;
            yield { type: 'cache_miss', previousCached: this.lastCacheRead };
          }
          this.lastCacheRead = cr;
        }
      }

      const uses = reply.content.filter((b) => b.type === 'tool_use');
      const text = reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const stop = reply.stop_reason;

      // The model declined: drop the refused output and retry once (on the refusal-fallback model if one is configured).
      if (stop === 'refusal' && !g.refusalRetrySpent) {
        g.refusalRetrySpent = true;
        if (this.refusalFallbackModel && this.model.setModel && this.model.modelName !== this.refusalFallbackModel) {
          g.restoreModel = this.model.modelName;
          yield { type: 'model_fallback', from: this.model.modelName, to: this.refusalFallbackModel, trigger: 'refusal' };
          this.model.setModel(this.refusalFallbackModel);
        }
        messages.push(meta('Your previous response was declined. If the request is legitimate, continue with the parts you can help with and say clearly what you cannot do.'));
        yield { type: 'transition', reason: 'refusal_retry' };
        continue;
      }
      if (stop === 'refusal' && reply.content.length === 0) reply.content = [{ type: 'text', text: '(The model declined to respond.)' }];

      // Output cut off by the token limit: keep the partial answer and ask the model to continue.
      if (stop === 'max_tokens') {
        messages.push({ role: 'assistant', content: reply.content.length ? reply.content : [{ type: 'text', text: '(no output)' }] });
        yield { type: 'assistant', content: reply.content, usage: reply.usage, truncated: true };
        if (g.outputRecovery >= 3) return { reason: 'max_output_tokens_exhausted', turns: g.turns, text };
        g.outputRecovery++;
        messages.push(meta('Your previous response was cut off by the output token limit. Continue exactly where you left off; do not repeat or apologize.'));
        yield { type: 'transition', reason: 'max_output_tokens_recovery', attempt: g.outputRecovery };
        continue;
      }

      // The model said tool_use but no call could be parsed (e.g. broken JSON): drop it and retry once.
      if (stop === 'tool_use' && uses.length === 0) {
        if (!g.malformedRetried) {
          g.malformedRetried = true;
          messages.push(meta('Your last tool call could not be parsed. Call the tool again with valid JSON arguments.'));
          yield { type: 'transition', reason: 'malformed_tool_use_retry' };
          continue;
        }
        yield { type: 'warning', message: "The model's tool call could not be parsed (retry also failed)." };
        return { reason: 'malformed_tool_use_exhausted', turns: g.turns, text };
      }
      g.malformedRetried = false;

      // Thinking-only / empty answer: nudge once, without keeping the empty assistant message.
      if (uses.length === 0 && text.trim() === '' && !g.thinkingNudged && (stop === 'end_turn' || stop === 'stop_sequence')) {
        g.thinkingNudged = true;
        messages.push(meta('You produced no visible answer. Reply to the user or call a tool.'));
        yield { type: 'transition', reason: 'thinking_only_retry' };
        continue;
      }

      messages.push({ role: 'assistant', content: reply.content });
      if (reply.usage) this.lastUsage = { tokens: usageTokens(reply.usage), at: messages.length };
      yield { type: 'assistant', content: reply.content, usage: reply.usage };
      g.outputRecovery = 0;

      if (uses.length === 0) {
        // Stop hooks may veto finishing and feed the model more instructions (capped).
        const stopResults = await this.#emit('Stop', { text, messages, ctx });
        const blocks = stopResults.filter((s) => s.decision === 'block');
        const prevent = stopResults.find((s) => s.stop === true);
        if (!blocks.length && prevent) {
          yield { type: 'warning', message: `Stopped by a Stop hook${prevent.reason ? `: ${prevent.reason}` : ''}` };
          return { reason: 'stop_hook_prevented', turns: g.turns, text, stopReason: prevent.reason };
        }
        if (blocks.length) {
          if (++g.stopHookBlocks > stopCap) {
            yield { type: 'warning', message: `A hook blocked the turn from ending ${g.stopHookBlocks} consecutive times; overriding and ending turn.` };
            return { reason: 'completed', turns: g.turns, text };
          }
          messages.push(meta(blocks.map((b) => b.reason ?? 'Continue.').join('\n')));
          yield { type: 'transition', reason: 'stop_hook_blocking', count: g.stopHookBlocks };
          continue;
        }
        return { reason: 'completed', turns: g.turns, text };
      }

      g.stopHookBlocks = 0;
      const extra = [];
      const exec = new ToolExecutor({
        run: (b, sig) => this.#runOne(b, ctx, sig, extra),
        maxConcurrency: this.maxConcurrency, signal: this.signal,
      });
      this.#batchSize = uses.length;
      for (const u of uses) exec.add(u, { safe: this.#isSafe(u) });
      const results = [];
      for (const t of exec.tools) {            // yield each result as soon as it (and its predecessors) finish
        const result = await t.done;
        results.push(result);
        yield { type: 'tool_result', result, use: t.block };
      }
      messages.push({ role: 'user', content: [...results, ...extra.map((x) => ({ type: 'text', text: x }))] });

      // A successful call to the structured-output tool is the final answer: stop here instead of looping for more text.
      const structuredUse = uses.find((u) => u.name === STRUCTURED_OUTPUT_TOOL_NAME);
      if (structuredUse) {
        const r = results.find((x) => x.tool_use_id === structuredUse.id);
        if (r && !r.is_error) return { reason: 'completed', turns: g.turns, text, structuredOutput: structuredUse.input };
      }

      const deferred = results.filter((r) => r.deferred).map((r) => r.deferredCall);
      if (deferred.length) return { reason: 'tool_deferred', turns: g.turns, text, deferred };
      if (this.signal?.aborted) return { reason: 'aborted_tools', turns: g.turns, text };
      for (const r of await this.#emit('PostToolBatch', { uses, results, ctx })) {
        if (r.stop) {
          yield { type: 'warning', message: `Execution stopped by PostToolBatch hook${r.reason ? `: ${r.reason}` : ''}` };
          return { reason: 'hook_stopped', turns: g.turns, text };
        }
      }
      yield { type: 'transition', reason: 'next_turn' };
    }
    } finally {
      this.store?.sync(messages);   // persist whatever the turn produced, even on abort or error
    }
  }

  /** Convenience wrapper: drive query() to completion; events go to onEvent. */
  async run(prompt, ctx = {}) {
    const gen = this.query(prompt, ctx);
    let step;
    while (!(step = await gen.next()).done) this.onEvent?.(step.value);
    const t = step.value;
    const stopped = { completed: 'end_turn', hook_stopped: 'hook', aborted_streaming: 'aborted', aborted_tools: 'aborted' }[t.reason] ?? t.reason;
    return { text: t.text ?? '', messages: this.messages, turns: t.turns, stopped, reason: t.reason, error: t.error, structuredOutput: t.structuredOutput };
  }
}
