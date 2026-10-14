import { createInterface } from 'node:readline/promises';
import { appendFileSync } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createWebFetchTool, createWebSearchTool } from './web.js';
import { TaskList, createTaskTools } from './tasks.js';
import { renderTranscript } from './export.js';
import { createAskTool, createPlanTools, planFilePath } from './plan.js';
import { sandboxAvailable, sandboxOptionsFor, buildProfile, sandboxKind } from './sandbox.js';
import { MarkdownFormatter } from './ui.js';
import { randomUUID } from 'node:crypto';
import { Spinner, StreamRenderer, colorEnabled, createStyle, footerLine, richEnabled, shortenInput, shortenPaths, slashCompleter, stripAnsi, toolPreview, THEME_NAMES } from './ui.js';
import { LineEditor, frameLines, parseKey } from './editor.js';
import path from 'node:path';
import { Harness, PERMISSION_MODES } from './harness.js';
import { defaultTools, createState } from './tools.js';
import { createAnthropicModel } from './model/anthropic.js';
import { createOpenAIModel } from './model/openai.js';
import { buildSystemPrompt } from './prompt.js';
import { loadSettings, buildHooks, settingsSources } from './hooks.js';
import { createFileWatcher } from './watch.js';
import { RuleSet, splitRuleList } from './permissions.js';
import { runClaudeCli, newSessionId } from './backends/claude-cli.js';
import { SessionStore, findSession, listSessions, loadSession } from './session.js';
import { createAgentTool, loadAgents } from './agents.js';
import { discoverMemory, renderMemory } from './memory.js';
import { approvedProjectServers, connectAll, createResourceTools, loadMcpConfig, screenTool, wrapTools } from './mcp.js';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createSkillTool, expandSkill, loadSkills } from './skills.js';
import { createWorktreeTools } from './worktree.js';
import { createLspTool, DEFAULT_SERVERS } from './lsp.js';
import { createNotebookTools } from './notebook.js';
import { createStructuredOutputTool } from './structured.js';
import { createToolSearchTool } from './toolsearch.js';
import { windowForModel } from './models.js';

const HELP = `rea — a Claude Code-style coding agent

Usage:
  rea-code                    interactive session
  rea-code -p "<prompt>"      run one prompt and exit (print mode)
  rea-code "<prompt>"         interactive session, first prompt preloaded

Options:
  -p, --print <prompt>        non-interactive
  --model <id>                default: claude-sonnet-5-5 (env REA_MODEL)
  --permission-mode <mode>    ${PERMISSION_MODES.join(' | ')}  (default: default)
  --allowedTools <rules>      e.g. "Read,Bash(git log:*)"; --disallowedTools likewise (deny always wins)
  --fallback-model <id>       used after repeated overloaded (529) responses
  --no-stream                 disable streaming
  --provider <anthropic|openai>  model API: Anthropic Messages (default) or any OpenAI-compatible chat.completions
                              endpoint (env REA_PROVIDER). Key: ANTHROPIC_API_KEY / OPENAI_API_KEY (or REA_API_KEY)
  --base-url <url>            API base URL (OpenAI-compatible; env OPENAI_BASE_URL)
  --context-window <tokens>   context size used for compaction thresholds (default 200000)
  --backend <anthropic|claude-cli>  claude-cli drives the real 'claude -p' (uses your subscription;
                              Claude Code runs its own loop, so this is a reference mode)
  -c, --continue              resume the most recent session in this directory
  -r, --resume <id|prefix>    resume a session (see /resume for the list)
  --no-persist                do not write a transcript
  --no-memory                 do not load REA.md / AGENTS.md / CLAUDE.md memory files
  --mcp-config <file>         MCP servers from a JSON file ({"mcpServers":{...}}); repeatable; trusted
  --managed-settings <file>   admin-controlled settings, read last so they win over every other source (default: an
                              OS path - /Library/Application Support/rea/managed-settings.json on macOS, /etc/rea/
                              managed-settings.json on Linux - read only if it exists)
  --no-mcp                    do not start MCP servers
  --sandbox / --no-sandbox    run Bash commands in the OS sandbox (macOS Seatbelt or Linux bubblewrap): writes only under the working directory,
                              protected paths read-only, Read/Edit deny rules enforced by the kernel; auto-approves such commands
  --sandbox-network <allow|deny>  network access inside the sandbox (default allow)
  --output-schema <file>      a JSON schema file; registers a StructuredOutput tool and the model must call it once at the end
  --defer-mcp-tools            MCP tool schemas are withheld until ToolSearch is called (useful with large MCP catalogs)
  --no-lsp                     do not register the LSP (code intelligence) tool
  --lsp-config <file>          JSON {"servers":{".ext":{"command":...,"args":[...]}}}; merged over the built-in registry
  --plain                     no colors, spinner, diffs or line editing (also REA_PLAIN=1 / NO_COLOR)
  --theme <dark|light|mono>   color preset (default: dark; also REA_THEME or {"ui":{"theme":...}} in settings)
  --multiline                 opt-in multi-line input editor for the main prompt: arrow keys move within the
                              input across lines; Enter submits, ctrl+j / shift+enter (where the terminal reports
                              it) / a trailing "\" add a newline instead. Experimental - not verified on every
                              terminal; falls back to plain input if the editor fails to start
  --max-turns <n>             default: 25
  --cwd <dir>                 working directory
  -h, --help

Env: ANTHROPIC_API_KEY (required), ANTHROPIC_BASE_URL (optional)
Settings: ~/.rea/settings.json, .rea/settings.json, .rea/settings.local.json
  {"permissions":{"allow":["Bash(git status:*)"],"deny":["Read(.env)"],"ask":["Bash(git push:*)"]},
   "hooks":{"PreToolUse":[{"matcher":"Bash","command":"./check.sh"}]}}
`;

export function parseArgs(argv) {
  const o = { permissionMode: undefined, allowedTools: [], disallowedTools: [], mcpConfig: [], maxTurns: 25, cwd: process.cwd(), model: process.env.REA_MODEL };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-p' || a === '--print') o.print = val();
    else if (a === '--model') o.model = val();
    else if (a === '--fallback-model') o.fallbackModel = val();
    else if (a === '--no-stream') o.noStream = true;
    else if (a === '--backend') o.backend = val();
    else if (a === '--provider') o.provider = val();
    else if (a === '--base-url') o.baseURL = val();
    else if (a === '--context-window') o.contextWindow = Number(val());
    else if (a === '-c' || a === '--continue') o.continue = true;
    else if (a === '-r' || a === '--resume') o.resume = val();
    else if (a === '--no-persist') o.noPersist = true;
    else if (a === '--no-memory') o.noMemory = true;
    else if (a === '--no-mcp') o.noMcp = true;
    else if (a === '--plain') o.plain = true;
    else if (a === '--theme') o.theme = val();
    else if (a === '--multiline') o.multiline = true;
    else if (a === '--sandbox') o.sandbox = true;
    else if (a === '--no-sandbox') o.sandbox = false;
    else if (a === '--sandbox-network') o.sandboxNetwork = val();
    else if (a === '--output-schema') o.outputSchemaFile = val();
    else if (a === '--defer-mcp-tools') o.deferMcpTools = true;
    else if (a === '--no-lsp') o.noLsp = true;
    else if (a === '--lsp-config') o.lspConfigFile = val();
    else if (a === '--mcp-config') o.mcpConfig.push(val());
    else if (a === '--managed-settings') o.managedSettingsFile = val();
    else if (a === '--allowedTools' || a === '--allowed-tools') o.allowedTools.push(...splitRuleList(val()));
    else if (a === '--disallowedTools' || a === '--disallowed-tools') o.disallowedTools.push(...splitRuleList(val()));
    else if (a === '--permission-mode') o.permissionMode = val();
    else if (a === '--max-turns') o.maxTurns = Number(val());
    else if (a === '--cwd') o.cwd = path.resolve(val());
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  o.provider ??= process.env.REA_PROVIDER ?? 'anthropic';
  if (!['anthropic', 'openai'].includes(o.provider)) throw new Error('--provider must be anthropic or openai');
  if (o.contextWindow !== undefined && !(o.contextWindow >= 4000)) throw new Error('--context-window must be a number >= 4000');
  if (o.backend && !['anthropic', 'claude-cli'].includes(o.backend)) throw new Error('--backend must be anthropic or claude-cli');
  if (o.permissionMode !== undefined && !PERMISSION_MODES.includes(o.permissionMode)) throw new Error(`--permission-mode must be one of ${PERMISSION_MODES.join(', ')}`);
  if (!Number.isInteger(o.maxTurns) || o.maxTurns < 1) throw new Error('--max-turns must be a positive integer');
  o.prompt = o.print ?? (rest.length ? rest.join(' ') : undefined);
  return o;
}

const preview = (v, n = 100) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n)}…` : s; };

export async function main(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { stderr.write(`claudecraft: ${e.message}\n`); return 2; }
  if (opts.help) { stdout.write(HELP); return 0; }

  if (opts.backend === 'claude-cli') return mainClaudeCli(opts, { stdin, stdout, stderr, env });

  // Buffered line reader: rl.question() loses lines that arrive while a turn is running (piped input).
  const interactive = opts.print === undefined;
  const rich = richEnabled({ stdout, env, plain: opts.plain });
  const termMode = rich && interactive && Boolean(stdin.isTTY);
  const histFile = path.join(os.homedir(), '.rea', 'history');
  let history = [];
  if (termMode) { try { history = readFileSync(histFile, 'utf8').split('\n').filter(Boolean).slice(-500).reverse(); } catch { /* none yet */ } }
  const slashNames = ['sandbox', 'plan', 'help', 'model', 'status', 'usage', 'tasks', 'export', 'diff', 'init', 'compact', 'clear', 'context', 'resume', 'fork', 'memory', 'skills', 'mcp', 'lsp', 'permissions', 'agents', 'exit'];
  const rl = createInterface({
    input: stdin, terminal: termMode, ...(termMode ? { output: stdout, history, historySize: 500, completer: slashCompleter(slashNames) } : {}),
  });
  const buffered = [];
  const waiters = [];
  const live = { turnActive: false, queue: null };   // lets lines typed during a turn join it (terminal mode only)
  let closed = false;
  rl.on('line', (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else if (termMode && live.turnActive && live.queue && l.trim() && !l.trim().startsWith('/')) live.queue(l);
    else buffered.push(l);
  });
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
  const ask = async (q) => {
    if (termMode) { rl.setPrompt(q.replace(/^\n/, '')); if (q.startsWith('\n')) stdout.write('\n'); rl.prompt(); } else stdout.write(q);
    const l = buffered.length ? buffered.shift() : closed ? null : await new Promise((r) => waiters.push(r));
    if (l === null) throw new Error('input closed');
    return l.trim();
  };

  let model;
  try {
    model = opts.provider === 'openai'
      ? createOpenAIModel({
        apiKey: env.OPENAI_API_KEY ?? env.REA_API_KEY, baseURL: opts.baseURL ?? env.OPENAI_BASE_URL ?? undefined,
        model: opts.model ?? env.OPENAI_MODEL ?? undefined, fallbackModel: opts.fallbackModel, stream: !opts.noStream,
      })
      : createAnthropicModel({
        apiKey: env.ANTHROPIC_API_KEY, baseURL: opts.baseURL ?? (env.ANTHROPIC_BASE_URL || undefined), model: opts.model,
        fallbackModel: opts.fallbackModel, stream: !opts.noStream,
      });
  } catch (e) { stderr.write(`claudecraft: ${e.message}\n`); rl.close(); return 1; }

  let settings;
  try { settings = loadSettings(opts.cwd, { managedSettingsFile: opts.managedSettingsFile }); } catch (e) { stderr.write(`claudecraft: ${e.message}\n`); rl.close(); return 1; }

  let outputSchema;
  if (opts.outputSchemaFile) {
    try { outputSchema = JSON.parse(readFileSync(path.resolve(opts.cwd, opts.outputSchemaFile), 'utf8')); }
    catch (e) { stderr.write(`claudecraft: --output-schema: ${e.message}\n`); rl.close(); return 1; }
  }

  const rules = new RuleSet({ cwd: opts.cwd });
  try {
    for (const ps of settings.permissionSources) {
      for (const b of ['deny', 'ask', 'allow']) rules.addAll(b, ps[b], ps.source);
      for (const d of ps.additionalDirectories) rules.additionalDirectories.push(path.resolve(opts.cwd, d));
    }
    rules.addAll('allow', opts.allowedTools, 'cliArg');
    rules.addAll('deny', opts.disallowedTools, 'cliArg');
  } catch (e) { stderr.write(`claudecraft: ${e.message}\n`); rl.close(); return 2; }
  const permissionMode = opts.permissionMode ?? settings.defaultMode ?? 'default';
  if (!PERMISSION_MODES.includes(permissionMode)) { stderr.write(`claudecraft: invalid defaultMode "${permissionMode}" in settings\n`); rl.close(); return 2; }

  const state = createState();
  let streamed = false;
  const theme = opts.theme ?? env.REA_THEME ?? settings.theme ?? 'dark';
  if (!THEME_NAMES.includes(theme)) { stderr.write(`claudecraft: --theme must be one of ${THEME_NAMES.join(', ')}\n`); rl.close(); return 2; }
  const style = createStyle(rich && colorEnabled({ stdout, env }), theme);
  const spinner = new Spinner(stdout, style, { enabled: rich && interactive });
  const renderer = rich ? new StreamRenderer((t) => stdout.write(t), style) : null;
  let turnAc = null;          // one controller per turn, so Ctrl-C cancels the turn and not the session
  let exitArmed = false;
  const store = opts.noPersist ? undefined : new SessionStore({ cwd: opts.cwd });
  const warn = (m) => stderr.write(`claudecraft: ${m}\n`);
  const agentDefs = loadAgents(opts.cwd, { warn });
  const memory = opts.noMemory ? { files: [], skipped: [] } : discoverMemory(opts.cwd, { warn });
  const skills = loadSkills(opts.cwd, { warn });
  let harness;
  // ---- OS sandbox for Bash (settings.sandbox, overridden by flags)
  const sbCfg = { ...(settings.sandbox ?? {}) };
  if (opts.sandbox !== undefined) sbCfg.enabled = opts.sandbox;
  if (opts.sandboxNetwork) sbCfg.network = opts.sandboxNetwork;
  let sandboxOn = Boolean(sbCfg.enabled);
  if (sandboxOn && !sandboxAvailable()) {
    if (sbCfg.failIfUnavailable) { stderr.write('claudecraft: sandbox requested but is not available on this platform (macOS Seatbelt or Linux bubblewrap only)\n'); rl.close(); return 1; }
    warn('sandbox requested but not available on this platform; Bash commands will run unsandboxed');
    sandboxOn = false;
  }
  const sandbox = { active: () => sandboxOn, options: () => sandboxOptionsFor({ cwd: rules.cwd, rules, settings: sbCfg }) };
  // cwd is a live getter (not opts.cwd directly) so EnterWorktree can move where file/Bash tools operate mid-session.
  const tools = defaultTools({ cwd: () => rules.cwd, state, sandbox });
  if (skills.length) tools.push(createSkillTool({ skills, addAllowRule: (rule, src) => rules.add('allow', rule, src) }));
  tools.push(...createNotebookTools({ cwd: () => rules.cwd, state }));
  tools.push(...createWorktreeTools({ getHarness: () => harness }));
  if (outputSchema) tools.push(createStructuredOutputTool({ schema: outputSchema }));
  let lspTool = null;
  if (!opts.noLsp) {
    let lspServers;
    if (opts.lspConfigFile) {
      try { lspServers = { ...DEFAULT_SERVERS, ...JSON.parse(readFileSync(path.resolve(opts.cwd, opts.lspConfigFile), 'utf8')).servers }; }
      catch (e) { stderr.write(`claudecraft: --lsp-config: ${e.message}\n`); rl.close(); return 1; }
    }
    lspTool = createLspTool({ cwd: opts.cwd, warn, ...(lspServers ? { servers: lspServers } : {}) });
    tools.push(lspTool);
  }

  // ---- MCP elicitation (server asks mid-call for user input; EVIDENCE.md §26). harness doesn't exist yet at this
  // point in startup, but onElicit is only called later, once a connected server actually sends elicitation/create.
  const elicitDialog = async ({ message, requested_schema }) => {
    stdout.write(`\n${style.yellow('?')} ${style.bold('[MCP elicitation]')} ${message}\n`);
    const a = await ask('  Provide input? [y/N] ').catch(() => 'n');
    if (!/^y(es)?$/i.test(a)) return { action: 'decline' };
    const props = requested_schema?.properties ?? {};
    const required = new Set(requested_schema?.required ?? []);
    const content = {};
    for (const [k, p] of Object.entries(props)) {
      const raw = await ask(`  ${k}${p.description ? ` (${p.description})` : ''}${required.has(k) ? ' *' : ''}: `).catch(() => '');
      if (raw === '') { if (required.has(k)) return { action: 'decline' }; continue; }
      content[k] = p.type === 'number' || p.type === 'integer' ? Number(raw) : p.type === 'boolean' ? /^(y|yes|true|1)$/i.test(raw) : raw;
    }
    return { action: 'accept', content };
  };
  const onElicit = async (payload) => {
    const auto = (await harness.emitHook('Elicitation', payload)).find((r) => r.permission === 'allow' || r.permission === 'deny');
    spinner.stop();
    let decision = auto ? { action: auto.permission === 'allow' ? 'accept' : 'decline', content: auto.updatedInput }
      : interactive && stdin.isTTY ? await elicitDialog(payload)
      : { action: 'decline' };   // no terminal to prompt on: decline rather than hang
    const override = (await harness.emitHook('ElicitationResult', { mcp_server_name: payload.mcp_server_name, elicitation_id: payload.elicitation_id, mode: payload.mode, action: decision.action, content: decision.content }))
      .find((r) => r.permission === 'allow' || r.permission === 'deny');
    if (override) decision = { action: override.permission === 'allow' ? 'accept' : 'decline', content: override.updatedInput ?? decision.content };
    return decision;
  };

  // ---- MCP servers: user/local/explicit config starts directly; project config needs approval (it runs commands).
  let mcpClients = [];
  const mcpSkipped = [];
  if (!opts.noMcp) {
    let entries = [];
    try { entries = loadMcpConfig(opts.cwd, { explicitFiles: opts.mcpConfig }); } catch (e) { warn(e.message); }
    const approved = approvedProjectServers(opts.cwd);
    const localFile = path.join(opts.cwd, '.rea', 'settings.local.json');
    const start = [];
    for (const e of entries) {
      if (e.trusted || approved.all || approved.names.has(e.name)) { start.push(e); continue; }
      const what = e.config.url ?? [e.config.command, ...(e.config.args ?? [])].join(' ');
      if (!interactive || !stdin.isTTY) { mcpSkipped.push(e.name); warn(`MCP server "${e.name}" from ${e.source} is not approved (${what}); approve it in an interactive session or list it in enabledMcpjsonServers in ${path.relative(opts.cwd, localFile)}`); continue; }
      const a = await ask(`Project config (${e.source}) wants to start MCP server "${e.name}": ${what}\nStart it? [y/N/a=always] `).catch(() => 'n');
      if (/^a(lways)?$/i.test(a) || /^y(es)?$/i.test(a)) {
        start.push(e);
        if (/^a/i.test(a)) {
          let cur = {}; try { cur = JSON.parse(readFileSync(localFile, 'utf8')); } catch { /* new file */ }
          cur.enabledMcpjsonServers = [...new Set([...(cur.enabledMcpjsonServers ?? []), e.name])];
          mkdirSync(path.dirname(localFile), { recursive: true }); writeFileSync(localFile, `${JSON.stringify(cur, null, 2)}\n`);
        }
      } else mcpSkipped.push(e.name);
    }
    mcpClients = await connectAll(start, { cwd: opts.cwd, warn, onElicit });
    for (const c of mcpClients) tools.push(...wrapTools(c, { warn, deferred: opts.deferMcpTools }));
    if (mcpClients.some((c) => c.capabilities.resources)) tools.push(...createResourceTools(mcpClients));
  }
  const closeMcp = () => Promise.all([...mcpClients.map((c) => c.close().catch(() => {})), lspTool?.close().catch(() => {}), (async () => fileWatcher?.close())()]);
  if (tools.some((t) => t.deferred)) tools.push(createToolSearchTool({ getHarness: () => harness }));

  // ---- task list and web tools
  const taskList = new TaskList([], (items) => store?.meta('tasks', JSON.stringify(items)), (e) => {
    harness?.emitHook(e.type === 'created' ? 'TaskCreated' : 'TaskCompleted', { task: { id: e.task.id, subject: e.task.subject, status: e.task.status } });
  });
  tools.push(...createTaskTools(taskList));
  tools.push(createWebFetchTool({ complete: (a) => harness.complete(a) }));
  const webSearch = createWebSearchTool({ env });
  if (webSearch) tools.push(webSearch);
  tools.push(createAgentTool({
    getParent: () => harness, definitions: agentDefs, cwd: opts.cwd,
    onEvent: (e) => {
      if (e.event.type !== 'assistant') return;
      spinner.stop();
      for (const b of e.event.content) if (b.type === 'tool_use') stdout.write(style.dim(`  ↳ [${e.agentType}] ${b.name}(${preview(b.input, 80)})`) + '\n');
    },
  }));
  // Parallel sub-agents can all want permission at once: ask one question at a time.
  let askChain = Promise.resolve();
  const serialize = (fn) => (arg) => { const run = askChain.then(() => fn(arg)); askChain = run.catch(() => {}); return run; };
  // ---- plan approval and multiple-choice questions (interactive sessions only)
  const fallbackId = randomUUID();
  const refreshPlanFile = () => { if (harness) harness.planFile = planFilePath(store?.sessionId ?? fallbackId); };
  const approvePlan = interactive ? serialize(async ({ plan, planFile, previousMode }) => {
    spinner.stop();
    const fmt = new MarkdownFormatter(style);
    stdout.write(`\n${style.bold(style.cyan('Plan'))} ${style.dim(`(${planFile})`)}\n${plan.split('\n').map((l) => fmt.line(l)).join('\n')}\n\n`);
    const keep = previousMode === 'plan' ? 'default' : previousMode;
    stdout.write(`  1) Yes, proceed (mode: ${keep})\n  2) Yes, and auto-accept edits\n  3) No, keep planning\n`);
    const a = await ask(`${style.yellow('?')} Choose 1-3, or type feedback to revise the plan: `).catch(() => '3');
    if (a === '1') return { approved: true, mode: keep };
    if (a === '2') return { approved: true, mode: 'acceptEdits' };
    return { approved: false, feedback: a === '3' || a === '' ? '' : a };
  }) : undefined;
  const askQuestions = interactive ? serialize(async ({ questions }) => {
    spinner.stop();
    const answers = [];
    for (const q of questions) {
      stdout.write(`\n${style.yellow('?')} ${q.header ? `${style.bold(`[${q.header}]`)} ` : ''}${q.question}${q.multiSelect ? style.dim(' (choose several: 1,3)') : ''}\n`);
      q.options.forEach((o, i) => stdout.write(`  ${i + 1}) ${o.label}${o.description ? style.dim(` — ${o.description}`) : ''}\n`));
      stdout.write(`  ${q.options.length + 1}) Other (type your answer)\n`);
      const raw = await ask('  > ').catch(() => null);
      if (raw === null) return null;
      const picks = raw.split(',').map((x) => x.trim()).filter(Boolean);
      const allNums = picks.length > 0 && picks.every((x) => /^\d+$/.test(x) && Number(x) >= 1 && Number(x) <= q.options.length);
      if (allNums) answers.push((q.multiSelect ? picks : picks.slice(0, 1)).map((n) => q.options[Number(n) - 1].label).join(', '));
      else answers.push(raw === String(q.options.length + 1) ? (await ask('  Your answer: ').catch(() => '')) : raw);
    }
    return answers;
  }) : undefined;
  tools.push(...createPlanTools({ getHarness: () => harness, approvePlan }), createAskTool({ askQuestions }));
  harness = new Harness({
    model, tools, permissionMode, store, rules, cwd: opts.cwd, memory: renderMemory(memory.files),
    nonInteractive: !interactive, refusalFallbackModel: opts.fallbackModel,
    sandboxAutoAllow: sandboxOn && sbCfg.autoAllow !== false,
    recentFiles: () => state.recentFiles(8),
    compactionExtra: () => (taskList.items.length ? `Task list at the time of compaction:\n${taskList.render()}` : ''),
    contextWindow: opts.contextWindow ?? windowForModel(model.modelName),
    system: buildSystemPrompt({ cwd: opts.cwd }), maxTurns: opts.maxTurns,
    hooks: buildHooks(settings, { cwd: opts.cwd, warn: (m) => stderr.write(`claudecraft: ${m}\n`) }),
    askUser: serialize(async ({ label, rule, outsideWorkspace, note: shellNote }) => {
      // print mode with no terminal to prompt on: deny rather than hang.
      if (!interactive && !stdin.isTTY) return false;
      spinner.stop();
      harness.emitHook('Notification', { kind: 'permission', message: `Permission needed: ${label}` });
      const note = rule ? ` (rule ${rule} asks${shellNote ? `: ${shellNote}` : ''})` : shellNote ? ` (${shellNote})` : outsideWorkspace ? ' (outside the working directory)' : '';
      const a = await ask(`\n${style.yellow('?')} Allow ${style.bold(preview(label, 120))}${note}? [y/N${outsideWorkspace ? '' : '/a=always this session'}] `);
      if (/^a(lways)?$/i.test(a)) return 'always';
      return /^y(es)?$/i.test(a);
    }),
    onEvent: (e) => {
      switch (e.type) {
        case 'text_delta': spinner.stop(); streamed = true; if (renderer) renderer.push(e.text); else stdout.write(e.text); break;
        case 'assistant': {
          spinner.stop();
          if (streamed) { if (renderer) renderer.flush(); else stdout.write('\n'); }
          else for (const b of e.content) if (b.type === 'text' && b.text.trim()) { if (renderer) { renderer.push(`${b.text}\n`); renderer.flush(); } else stdout.write(`${b.text}\n`); }
          streamed = false;
          const calls = e.content.filter((b) => b.type === 'tool_use');
          for (const b of calls) {
            const shown = rich ? shortenInput(b.input, opts.cwd) : b.input;
            stdout.write(`\n${style.cyan('●')} ${style.bold(b.name)}${style.dim(`(${preview(shown)})`)}\n`);
            if (rich) for (const l of toolPreview(b, style)) stdout.write(`    ${l}\n`);
          }
          if (calls.length) spinner.start(`Running ${calls.map((c) => c.name).join(', ')}`);
          break;
        }
        case 'tool_result': {
          spinner.stop();
          const body = preview((rich ? shortenPaths(e.result.content, opts.cwd) : String(e.result.content)).replace(/\s+/g, ' '), 140);
          stdout.write(`  ${style.dim('⎿')} ${e.result.is_error ? style.red(`✗ ${body}`) : style.dim(body)}\n`);
          spinner.start('Thinking');
          break;
        }
        case 'absorbed_mid_turn': spinner.stop(); stdout.write(`${style.dim('  ↳ added your message to the running turn')}\n`); break;
        case 'micro_compact': spinner.stop(); stderr.write(`claudecraft: cleared ${e.cleared} old tool result(s), freeing ~${e.freedTokens} tokens\n`); break;
        case 'cache_miss': break;     // counted in /usage; not worth interrupting the user
        case 'retry': spinner.stop(); stderr.write(`\nclaudecraft: ${e.kind}; retry ${e.attempt} in ${Math.round(e.delayMs)}ms\n`); streamed = false; break;
        case 'model_fallback': spinner.stop(); stderr.write(`claudecraft: switching model ${e.from} -> ${e.to}\n`); break;
        case 'warning': spinner.stop(); stderr.write(`claudecraft: ${e.message}\n`); break;
        case 'compact_start': spinner.stop(); stderr.write(`claudecraft: compacting context (${e.trigger}, ~${e.tokens} tokens)...\n`); spinner.start('Compacting'); break;
        case 'compact_skipped': spinner.stop(); stderr.write(`claudecraft: compaction skipped: ${e.reason}\n`); break;
        case 'compact_end': spinner.stop(); stderr.write(`claudecraft: compacted ~${e.preTokens} -> ~${e.postTokens} tokens (${e.summarized} messages summarized${e.reattached?.length ? `, ${e.reattached.length} file(s) re-attached` : ''})\n`); break;
        case 'context_warning': spinner.stop(); stderr.write(`claudecraft: context is ${100 - e.pctLeft}% of the way to auto-compaction\n`); break;
        case 'error': spinner.stop(); stderr.write(`claudecraft: ${e.error.message}\n`); break;
        default: break;
      }
    },
  });

  refreshPlanFile();
  if (permissionMode === 'plan') harness.prePlanMode = 'default';

  // Only pay for a watcher when something is actually listening for FileChanged.
  // buildHooks' generic payload wrapper already uses a flat "event" key for the *hook* name (e.g. "FileChanged"),
  // so the file-change kind is passed as "change" here instead of reusing the bundle's literal "event" field name
  // (EVIDENCE.md §25) - a deliberate, documented deviation to avoid clobbering the hook name.
  const fileWatcher = settings.hooks.FileChanged?.length
    ? createFileWatcher(rules.cwd, { onEvent: (e) => harness.emitHook('FileChanged', { file_path: e.file_path, change: e.event }) }) : null;

  // Replace the live conversation with a saved one. Returns an error string, or null on success.
  const resumeInto = (ref) => {
    const f = findSession(opts.cwd, ref);
    if (f.error) return f.error;
    let loaded;
    try { loaded = loadSession(f.session.file); } catch (e) { return `could not read session: ${e.message}`; }
    harness.messages.length = 0;
    harness.messages.push(...loaded.messages);
    harness.lastUsage = null;
    harness.compactState = null;
    harness.restoreUserPrompts();
    taskList.replace(loaded.tasks ?? []);
    if (store) { store.rotate(loaded.sessionId); store.adopt(harness.messages, loaded.uuids); }
    refreshPlanFile();
    stdout.write(`Resumed session ${loaded.sessionId.slice(0, 8)} "${loaded.title ?? ''}" (${loaded.messages.length} messages${loaded.compactions ? `, ${loaded.compactions} compactions` : ''}).\n`);
    return null;
  };
  if (opts.continue || opts.resume) {
    const err = resumeInto(opts.continue ? 'latest' : opts.resume);
    if (err) { stderr.write(`claudecraft: ${err}\n`); await closeMcp(); rl.close(); return 1; }
  }
  await harness.sessionStart(opts.continue || opts.resume ? 'resume' : 'startup');
  if (memory.files.length) await harness.emitHook('InstructionsLoaded', { files: memory.files.map((f) => ({ path: f.path, type: f.type })) });

  // "/skill args" -> the skill's expanded prompt (and its allowed-tools become session allow rules).
  const expandSlash = async (line) => {
    const m = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(line);
    if (!m) return { prompt: line };
    const skill = skills.find((s) => s.name === m[1] && s.userInvocable);
    if (!skill) return { unknown: m[1] };
    for (const r of skill.allowedTools) { try { rules.add('allow', r, `skill:${skill.name}`); } catch { /* ignore */ } }
    const prompt = expandSkill(skill, m[2] ?? '');
    await harness.emitHook('UserPromptExpansion', { command: skill.name, args: m[2] ?? '', expanded: prompt.length });
    return { prompt };
  };

  const turn = async (prompt) => {
    turnAc = new AbortController();
    harness.signal = turnAc.signal;
    live.turnActive = true;
    live.queue = (t) => { harness.queueMessage(t); };
    spinner.start('Thinking');
    try {
      const r = await harness.run(prompt);
      if (r.reason === 'max_turns') stderr.write(`claudecraft: stopped after ${r.turns} turns (--max-turns)\n`);
      if (r.stopped === 'aborted') stderr.write('claudecraft: interrupted\n');
      return r;
    } catch (e) { stderr.write(`claudecraft: ${e.message}\n`); return null; } finally {
      spinner.stop();
      renderer?.flush();
      live.turnActive = false;
      turnAc = null; harness.signal = undefined;
      if (rich && interactive) stdout.write(`${footerLine({ model: model.modelName, mode: harness.permissionMode, status: harness.contextStatus(), compactions: harness.compactions.length, style, width: stdout.columns ?? 80 })}\n`);
    }
  };

  // Ctrl-C: cancel the running turn; at an idle prompt, press twice to exit.
  const onInterrupt = () => {
    if (turnAc && !turnAc.signal.aborted) { spinner.stop(); turnAc.abort(); return; }
    if (!interactive) { process.exit(130); }
    if (exitArmed) { stdout.write('\n'); process.exit(130); }
    exitArmed = true;
    stdout.write(`\n${style.dim('(press Ctrl-C again to exit)')}\n`);
    setTimeout(() => { exitArmed = false; }, 2000).unref();
  };
  if (termMode) rl.on('SIGINT', onInterrupt); else process.on('SIGINT', onInterrupt);

  /**
   * Opt-in (--multiline) raw-mode multi-line editor for the main prompt only; every other prompt (permission
   * dialogs, plan approval, questions) keeps using the plain `ask()`/readline path above, unchanged. EVIDENCE.md
   * §28: newline conventions (ctrl+j, shift+enter where the terminal reports it, trailing "\") are implemented in
   * src/editor.js and unit-tested there; this function is just the raw-byte wiring and screen redraw, which has
   * no automated test (no pty in this environment) - verify by hand before relying on it.
   * Falls back to the plain ask() on any setup failure (not a real TTY, setRawMode missing, etc).
   */
  const multilineAsk = (promptText) => {
    if (!termMode || !opts.multiline || typeof stdin.setRawMode !== 'function') return ask(promptText);
    const plainPrefix = stripAnsi(promptText).replace(/^\n/, '');
    if (promptText.startsWith('\n')) stdout.write('\n');
    return new Promise((resolve) => {
      // readline (terminal: true) already put stdin into raw mode and keeps it there for the interface's whole
      // life - toggling setRawMode ourselves would fight it. Instead, detach readline's own 'data' listener(s)
      // while this editor is active and restore them verbatim on the way out, so stdin's actual mode never changes.
      let editor, drawnRows = 1, settled = false;
      const savedListeners = stdin.listeners('data');
      const cleanup = () => {
        if (settled) return; settled = true;
        stdin.removeListener('data', onData);
        for (const l of savedListeners) stdin.on('data', l);
        rl.resume();
      };
      const draw = () => {
        if (drawnRows > 1) stdout.write(`\x1b[${drawnRows - 1}A`);
        stdout.write('\r\x1b[0J');
        const frame = frameLines(editor, plainPrefix.length);
        stdout.write(frame.map((l, i) => (i === 0 ? style.bold(plainPrefix) + l : l)).join('\n'));
        drawnRows = frame.length;
        const upFrom = drawnRows - 1 - editor.row;
        if (upFrom > 0) stdout.write(`\x1b[${upFrom}A`);
        const col = plainPrefix.length + editor.col;
        stdout.write(col > 0 ? `\r\x1b[${col}C` : '\r');
      };
      const onData = (chunk) => {
        const key = parseKey(chunk);
        if (!key) return;
        if (key.name === 'ctrl-c') { cleanup(); onInterrupt(); resolve(''); return; }
        const r = editor.handleKey(key);
        if (r) {
          cleanup();
          stdout.write('\n');
          resolve(r.submit);   // the caller's own termMode history-append already covers this, same as plain ask()
          return;
        }
        draw();
      };
      try {
        editor = new LineEditor();
        rl.pause();
        for (const l of savedListeners) stdin.removeListener('data', l);
        draw();
        stdin.on('data', onData);
      } catch { settled = true; for (const l of savedListeners) stdin.on('data', l); rl.resume(); ask(promptText).then(resolve); }
    });
  };

  if (!interactive) {
    const ex = await expandSlash(opts.prompt);
    if (ex.unknown) { stderr.write(`claudecraft: unknown command /${ex.unknown}\n`); await harness.sessionEnd('exit'); await closeMcp(); rl.close(); return 2; }
    const r = await turn(ex.prompt);
    if (r?.structuredOutput !== undefined) stdout.write(`${JSON.stringify(r.structuredOutput, null, 2)}\n`);
    await harness.sessionEnd('exit');
    await closeMcp();
    rl.close();
    return r && r.reason === 'completed' ? 0 : 1;
  }

  slashNames.push(...skills.filter((x) => x.userInvocable).map((x) => x.name));
  stdout.write(`${style.bold('claudecraft')} ${style.dim(`(${model.modelName}, ${permissionMode}) in ${opts.cwd}`)}\n${style.dim('Type a request; /compact, /clear, /context, /resume, /memory, /skills, /mcp, /permissions, /agents, /exit.')}\n`);
  if (opts.prompt) { const ex = await expandSlash(opts.prompt); await turn(ex.prompt ?? opts.prompt); }
  for (;;) {
    let line;
    try { line = await multilineAsk(`\n${style.bold('>')} `); } catch { break; } // stdin closed
    if (!line) continue;
    exitArmed = false;
    if (termMode) { try { mkdirSync(path.dirname(histFile), { recursive: true, mode: 0o700 }); appendFileSync(histFile, `${line}\n`, { mode: 0o600 }); } catch { /* history is best effort */ } }
    if (line === '/exit' || line === '/quit') break;
    if (line === '/resume' || line.startsWith('/resume ')) {
      const ref = line.slice('/resume'.length).trim();
      if (!ref) {
        const all = listSessions(opts.cwd).slice(0, 10);
        stdout.write(all.length ? all.map((x) => `  ${x.sessionId.slice(0, 8)}  ${new Date(x.mtimeMs).toISOString().slice(0, 16)}  ${x.messages} msgs  ${x.title}`).join('\n') + '\n' : 'No saved sessions.\n');
      } else { const err = resumeInto(ref); if (err) stdout.write(`${err}\n`); }
      continue;
    }
    if (line === '/agents') {
      stdout.write(`${agentDefs.map((a) => `  ${a.agentType.padEnd(16)} ${a.source === 'built-in' ? '(built-in)' : '(custom)  '} ${a.whenToUse.slice(0, 80)}`).join('\n')}\n`);
      continue;
    }
    if (line === '/mcp') {
      const rows = [...mcpClients.map((c) => `  ${c.name.padEnd(16)} ${c.status.padEnd(9)} ${c.type.padEnd(5)} ${c.tools.filter((t) => !screenTool(t)).length} tools${c.resources.length ? `, ${c.resources.length} resources` : ''}`),
        ...mcpSkipped.map((n) => `  ${n.padEnd(16)} not approved`)];
      stdout.write(`${rows.length ? rows.join('\n') : '  (no MCP servers; add .mcp.json or --mcp-config)'}\n`);
      continue;
    }
    if (line === '/memory') {
      stdout.write(`${memory.files.length ? memory.files.map((f) => `  ${f.type.padEnd(7)} ${f.path}${f.importedBy ? `  (imported by ${path.basename(f.importedBy)})` : ''}`).join('\n') : '  (no memory files)'}\n`);
      for (const k of memory.skipped) stdout.write(`  skipped ${k.path}: ${k.reason}\n`);
      continue;
    }
    if (line === '/skills') {
      stdout.write(`${skills.length ? skills.map((x) => `  /${x.name.padEnd(18)} ${x.description.slice(0, 70)}${x.disableModelInvocation ? '  [user only]' : ''}${x.userInvocable ? '' : '  [model only]'}`).join('\n') : '  (no skills; add .rea/skills/<name>/SKILL.md)'}\n`);
      continue;
    }
    if (line === '/lsp') {
      if (!lspTool) { stdout.write('LSP is off (--no-lsp).\n'); continue; }
      const rows = lspTool.status();
      stdout.write(`${rows.length ? rows.map((r) => `  ${r.server}  ${r.running ? 'running' : 'stopped'}`).join('\n') : '  (no language server started yet; it starts on first use)'}\n`);
      continue;
    }
    if (line === '/sandbox') {
      if (!sandboxOn) { stdout.write(`Sandbox is off. Start with --sandbox or set {"sandbox":{"enabled":true}} in settings. ${sandboxAvailable() ? '' : '(Not available on this platform.)'}\n`); continue; }
      const o = sandboxOptionsFor({ cwd: opts.cwd, rules, settings: sbCfg });
      stdout.write(`Sandbox on (${sandboxKind()}). Network: ${o.network}. Writable: ${[opts.cwd, ...o.writeRoots, 'temp dirs'].join(', ')}.\n`
        + `Read-denied: ${o.denyRead.length} path(s) from Read deny rules. Write-denied: ${o.denyWrite.length} path(s) from Edit deny rules, plus .rea/, .git/hooks, .git/config, .mcp.json.\n`);
      continue;
    }
    if (line === '/plan' || line === '/plan off') {
      if (line === '/plan') {
        harness.enterPlanMode(); refreshPlanFile();
        stdout.write(`Plan mode on: read-only exploration; the plan goes to ${harness.planFile}. The model will ask for approval when ready.\n`);
      } else { harness.exitPlanMode(); stdout.write(`Plan mode off (mode: ${harness.permissionMode}).\n`); }
      continue;
    }
    if (line === '/help') {
      const rows = [['/help', 'this list'], ['/model [name]', 'show or switch the model'], ['/status', 'session, model, context, servers'],
        ['/usage', 'token usage this session'], ['/tasks', 'the task checklist'], ['/context', 'context window use'],
        ['/compact [focus]', 'summarize history to free context'], ['/clear', 'start a new conversation'], ['/resume [id]', 'list or load a saved session'],
        ['/fork [title]', 'branch the session: new id, same history so far'],
        ['/plan [off]', 'enter or leave plan mode (read-only until you approve)'], ['/export [file]', 'write the conversation as Markdown'], ['/diff', 'git diff of the working directory'], ['/init', 'have the model write REA.md for this project'],
        ['/memory', 'loaded memory files'], ['/skills', 'available skills'], ['/mcp', 'MCP servers'], ['/lsp', 'language server status'], ['/sandbox', 'OS sandbox status'], ['/permissions', 'active permission rules'],
        ['/cd [dir]', 'show or change the working directory'], ['/add-dir [dir]', 'list or add a workspace directory'],
        ['/rename <title>', 'rename the current session'], ['/session', 'current session id, file and cwd'], ['/config', 'settings sources and resolved values'],
        ['/agents', 'sub-agent types'], ['/<skill> [args]', 'run a skill'], ['/exit', 'quit']];
      stdout.write(`${rows.map(([c, d]) => `  ${style.bold(c.padEnd(18))} ${style.dim(d)}`).join('\n')}\n`);
      continue;
    }
    if (line === '/model' || line.startsWith('/model ')) {
      const name = line.slice('/model'.length).trim();
      if (name) {
        if (model.setModel) {
          const from = model.modelName;
          await harness.emitHook('PreModelSwitch', { from, to: name });
          model.setModel(name);
          await harness.emitHook('PostModelSwitch', { from, to: name });
          stdout.write(`Model set to ${name}\n`);
        } else stdout.write('This provider cannot switch models at runtime.\n');
      }
      else stdout.write(`Model: ${model.modelName} (${opts.provider})\n`);
      continue;
    }
    if (line === '/status') {
      const c = harness.contextStatus();
      const rows = [['provider', `${opts.provider}${opts.baseURL ? ` @ ${opts.baseURL}` : ''}`], ['model', model.modelName], ['mode', harness.permissionMode], ['theme', theme], ['sandbox', sandboxOn ? `on (network ${sbCfg.network === 'deny' ? 'denied' : 'allowed'}${sbCfg.autoAllow === false ? ', no auto-approve' : ', auto-approves sandboxed commands'})` : 'off'], ['cwd', rules.cwd],
        ...(harness.activeWorktree ? [['worktree', `${harness.activeWorktree.path} (branch ${harness.activeWorktree.branch})`]] : []),
        ['session', store ? `${store.sessionId.slice(0, 8)} (${harness.messages.length} messages)` : 'not persisted'],
        ['context', `~${c.tokens} / ${c.window} tokens (${c.level})`],
        ['memory', `${memory.files.length} files`], ['skills', String(skills.length)], ['mcp', `${mcpClients.length} servers`],
        ['tasks', `${taskList.items.length}`], ['web search', webSearch ? webSearch.description.match(/via (\w+)/)?.[1] : 'not configured']];
      stdout.write(`${rows.map(([k, v]) => `  ${style.dim(k.padEnd(11))} ${v}`).join('\n')}\n`);
      continue;
    }
    if (line === '/usage') {
      const u = harness.usageTotals;
      stdout.write(`  requests ${u.requests}   input ${u.input_tokens}   cached input ${u.cache_read_input_tokens}   output ${u.output_tokens}\n`);
      continue;
    }
    if (line === '/tasks') { stdout.write(`${taskList.render()}\n`); continue; }
    if (line === '/export' || line.startsWith('/export ')) {
      const target = path.resolve(opts.cwd, line.slice('/export'.length).trim() || `rea-session-${(store?.sessionId ?? 'chat').slice(0, 8)}.md`);
      try {
        writeFileSync(target, renderTranscript(harness.messages, { model: model.modelName, cwd: opts.cwd, sessionId: store?.sessionId }));
        stdout.write(`Exported ${harness.messages.length} messages to ${path.relative(opts.cwd, target) || target}\n`);
      } catch (e) { stdout.write(`Export failed: ${e.message}\n`); }
      continue;
    }
    if (line === '/diff') {
      const out = await new Promise((resolve) => {
        const p = spawn('git', ['--no-pager', 'diff', '--stat', '--patch', '--no-color'], { cwd: rules.cwd });
        let o = '', e = '';
        p.stdout.on('data', (b) => { o += b; }); p.stderr.on('data', (b) => { e += b; });
        p.on('error', () => resolve('git is not available'));
        p.on('close', (code) => resolve(code === 0 ? (o.trim() || 'No uncommitted changes.') : `Not a git repository (${e.trim().split('\n')[0]})`));
      });
      const lines = out.split('\n');
      stdout.write(`${lines.slice(0, 200).map((l) => (l.startsWith('+') && !l.startsWith('+++') ? style.green(l) : l.startsWith('-') && !l.startsWith('---') ? style.red(l) : l)).join('\n')}${lines.length > 200 ? `\n… ${lines.length - 200} more lines` : ''}\n`);
      continue;
    }
    if (line === '/init') {
      await turn('Explore this project with your tools, then create REA.md at the project root with: (1) what the project is, (2) the exact build, test and lint commands, (3) the architecture in a few bullets, (4) conventions and gotchas that are not obvious from the code. If REA.md already exists, improve it instead of replacing it. Keep it under 60 lines and do not invent commands you have not seen in the repo.');
      continue;
    }
    if (line === '/permissions') {
      const l = rules.list();
      stdout.write(`${l.length ? l.map((r) => `  ${r.behavior.padEnd(5)} ${r.rule}  [${r.source}]`).join('\n') : '  (no rules)'}\n  mode: ${harness.permissionMode}\n`);
      continue;
    }
    if (line === '/fork' || line.startsWith('/fork ')) {
      if (!store) { stdout.write('Forking needs persistence; this session was started with --no-persist.\n'); continue; }
      const title = line.slice('/fork'.length).trim();
      const oldId = store.sessionId;
      store.rotate();
      store.sync(harness.messages);
      if (title) store.meta('title', title);
      refreshPlanFile();   // the plan file path is keyed by the session id prefix
      stdout.write(`Forked session ${oldId.slice(0, 8)} -> ${store.sessionId.slice(0, 8)} (${harness.messages.length} messages copied). `
        + `Resume the original any time with --resume ${oldId.slice(0, 8)}.\n`);
      continue;
    }
    if (line === '/clear') { harness.clear(); refreshPlanFile(); stdout.write('Conversation cleared.\n'); continue; }
    if (line === '/cd' || line.startsWith('/cd ')) {
      const target = line.slice('/cd'.length).trim();
      if (!target) { stdout.write(`${rules.cwd}\n`); continue; }
      const abs = path.resolve(rules.cwd, target);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) { stdout.write(`Not a directory: ${abs}\n`); continue; }
      rules.cwd = abs; rules.root = abs;
      stdout.write(`cwd: ${rules.cwd}\n`);
      continue;
    }
    if (line === '/add-dir' || line.startsWith('/add-dir ')) {
      const target = line.slice('/add-dir'.length).trim();
      if (!target) {
        stdout.write(`${rules.additionalDirectories.length ? rules.additionalDirectories.map((d) => `  ${d}`).join('\n') : '  (no additional directories)'}\n`);
        continue;
      }
      const abs = path.resolve(rules.cwd, target);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) { stdout.write(`Not a directory: ${abs}\n`); continue; }
      if (rules.additionalDirectories.includes(abs)) { stdout.write(`${abs} is already a workspace directory.\n`); continue; }
      rules.additionalDirectories.push(abs);
      await harness.emitHook('DirectoryAdded', { directory: abs, source: 'slash_command' });
      stdout.write(`Added ${abs} to the workspace.\n`);
      continue;
    }
    if (line === '/rename' || line.startsWith('/rename ')) {
      const title = line.slice('/rename'.length).trim();
      if (!title) { stdout.write('Usage: /rename <title>\n'); continue; }
      if (!store) { stdout.write('Renaming needs persistence; this session was started with --no-persist.\n'); continue; }
      store.meta('title', title);
      stdout.write(`Session renamed to "${title}".\n`);
      continue;
    }
    if (line === '/session') {
      if (!store) { stdout.write('This session is not persisted (--no-persist); nothing to show.\n'); continue; }
      stdout.write(`  id       ${store.sessionId}\n  file     ${store.file}\n  cwd      ${rules.cwd}\n  messages ${harness.messages.length}\n`);
      continue;
    }
    if (line === '/config') {
      const rows = settingsSources(opts.cwd, opts.managedSettingsFile).map(([name, f]) => `  ${name.padEnd(16)} ${existsSync(f) ? f : `${f}  (not present)`}`);
      rows.push(`  ${'defaultMode'.padEnd(16)} ${settings.defaultMode ?? '(none)'}`);
      rows.push(`  ${'sandbox'.padEnd(16)} ${settings.sandbox ? JSON.stringify(settings.sandbox) : '(none)'}`);
      rows.push(`  ${'permissions'.padEnd(16)} ${rules.list().length} rule(s) from ${settings.permissionSources.length} source file(s)`);
      stdout.write(`${rows.join('\n')}\n`);
      continue;
    }
    if (line === '/context') {
      const c = harness.contextStatus();
      stdout.write(`Context: ~${c.tokens} / ${c.window} tokens (${c.level}, auto-compact at ${c.threshold}, ${harness.compactions.length} compactions)\n`);
      continue;
    }
    if (line === '/compact' || line.startsWith('/compact ')) {
      const r = await harness.compact(line.slice('/compact'.length).trim() || undefined);
      if (!r) stdout.write('Nothing was compacted.\n');
      continue;
    }
    const ex = await expandSlash(line);
    if (ex.unknown) { stdout.write(`Unknown command /${ex.unknown} (try /skills)\n`); continue; }
    await turn(ex.prompt);
  }
  await harness.sessionEnd('exit');
  await closeMcp();
  rl.close();
  return 0;
}

// Reference mode: Claude Code runs its own loop and tools; rea only relays events.
async function mainClaudeCli(opts, { stdin, stdout, stderr, env }) {
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  const sessionId = newSessionId();
  let turns = 0;
  const run = async (prompt) => {
    const gen = runClaudeCli({
      prompt, cwd: opts.cwd, model: opts.model, permissionMode: opts.permissionMode, signal: ac.signal, env,
      ...(turns === 0 ? { sessionId } : { resume: sessionId }),
    });
    turns++;
    let step;
    while (!(step = await gen.next()).done) {
      const e = step.value;
      if (e.type === 'assistant') {
        for (const b of e.content) {
          if (b.type === 'text' && b.text.trim()) stdout.write(`${b.text}\n`);
          if (b.type === 'tool_use') stdout.write(`\n● ${b.name}(${preview(b.input)})\n`);
        }
      } else if (e.type === 'tool_result') {
        stdout.write(`  ⎿ ${e.result.is_error ? '✗ ' : ''}${preview(String(e.result.content).replace(/\s+/g, ' '), 140)}\n`);
      } else if (e.type === 'error') stderr.write(`claudecraft: ${e.error.message}\n`);
    }
    const t = step.value;
    if (t.costUsd !== undefined) stderr.write(`claudecraft: [claude-cli] ${t.turns} turns, $${Number(t.costUsd).toFixed(4)}, ${t.durationMs ?? '?'}ms\n`);
    return t.reason === 'completed' ? 0 : 1;
  };
  if (opts.print !== undefined) return run(opts.prompt);

  const rl = createInterface({ input: stdin, terminal: false });
  stdout.write(`rea (claude-cli backend, ${opts.permissionMode ?? "default"}) in ${opts.cwd}\nType a request; /exit to quit.\n`);
  let code = 0;
  if (opts.prompt) code = await run(opts.prompt);
  stdout.write('\n> ');
  for await (const line of rl) {
    const l = line.trim();
    if (l === '/exit' || l === '/quit') break;
    if (l) code = await run(l);
    stdout.write('\n> ');
  }
  return code;
}
