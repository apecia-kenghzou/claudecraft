# Claude Code architecture, as reverse engineered with `rea`

Target: `@anthropic-ai/claude-code` 2.1.296, `bin/claude.exe` (240 MB Bun standalone, arm64 macOS).
Goal of this document: a spec you can build your own agent from. Identifiers in the bundle are minified;
names like `yd` are bundle-local labels, not stable.

## 0. Method and its limits

1. Carve the embedded JS: NUL-delimited UTF-8 runs >= 2 KB containing JS markers -> **1,825 modules, 47.6 MB**
   (about 30 MB is Claude Code's own code; the rest is bundled dependencies: zod, protobuf, OpenTelemetry...).
2. Parse the 4.76 MB main bundle with `@babel/parser` (shipped inside `rea-agents`) and split at top-level
   statement boundaries into ~450 KB chunks (12,252 statements, 0 parse errors).
3. `rea analyze-javascript-application` per chunk (each gets its own semantic budget):
   **20,248 functions, 14,052 resolved call edges**, 10/11 chunks complete.
4. Landmark search (strings, telemetry event names, env vars) to name subsystems, then read the entry functions.

Known gaps: one 88 KB sub-chunk of the main bundle (`c007/c002`) crashes the analyzer (resource constraint);
`rea` caps each graph at 20,000 nodes so call-sites are only partly retained; call edges through indirection
(callbacks, object methods) are not resolved, so "who calls X" is a lower bound. Everything below is *static*:
nothing was executed.

## 1. Where things live

| Subsystem | Location (module file in `scratchpad/all`, size) | Confidence |
|---|---|---|
| CLI bootstrap, commands, settings, TUI wiring, per-tool pipeline `l2/GWo/KWo` | `m0444` main bundle (4.76 MB) | high |
| **Agent loop** `yd` (70 KB async generator) + streaming tool executor | `m0567` (199 KB) | high |
| **Model-call layer** `cln` (120 KB async generator, 97 callees) | main bundle chunk `c006` | high |
| Tool batching `$a`, runners `Zo/Ka/Wa`, concurrency limit `Ha` | `m0536` (149 KB) | high |
| Permission engine, file-edit helpers | `m1244` (670 KB) | medium |
| Hook runner | `m0376` (697 KB), `m1169` | medium |
| MCP client, settings, sandbox | `m0251` (434 KB), `m1326` (691 KB), `m0345` (943 KB) | medium |
| Bash command parser / safety classifier | main bundle `c007` (functions like `bJo`) | medium |
| Subagents | `m0567`, `m0539` | low |
| Memory (CLAUDE.md) | `m0607` (233 KB) | low |

## 2. The agent loop (`yd`, in `m0567`)

Signature: `async function*yd(params, ...)`: it *yields* messages/events to the UI and returns a terminal
reason. This is the single most important design fact: **the loop is a generator, not a callback API**.

Inputs seen in the destructuring: `systemPrompt, userContext, systemContext, canUseTool, fallbackModel,
querySource, maxTurns, skipCacheWrite, forkPointUuid, thinkingStripPlan, advisorStripPlan, compactionRequestKind`.

Loop state (one immutable object replaced each iteration):
`{ guards: { stopHookActive, turnCount, refusalRetrySpent, ...}, messages, toolUseContext, compactTracking, transition }`
plus `maxOutputTokensRecoveryCount`, `hasAttemptedReactiveCompact`, `maxOutputTokensOverride`, `pendingToolUseSummary`,
`taskBudget`.

**Terminal reasons (23)**, the loop's real exit contract:
`completed, max_turns, model_error, api_error, aborted_streaming, aborted_tools, hook_stopped, stop_hook_prevented,
background_requested, tool_deferred, blocking_limit, image_error, fallback_sweep, rapid_refill_breaker,
absorbed_mid_turn, refusal_retry, max_output_tokens_recovery, truncated_response_recovery,
malformed_tool_use_retry, malformed_tool_use_exhausted, thinking_only_retry, stop_hook_blocking, next_turn`.

**Continue-transitions (7)**, where the loop re-enters instead of ending:
`next_turn` (tool results appended), `max_output_tokens_recovery`, `truncated_response_recovery`,
`malformed_tool_use_retry`, `thinking_only_retry`, `refusal_retry`, `stop_hook_blocking`.

What a one-iteration pass does, in order (from landmarks and calls): memory-recall attachments -> build tool
schemas (deferred tools, `defer_loading`) -> normalize messages -> call model (`cln`) -> collect tool_use blocks ->
run tools (`Zo`) -> PostToolBatch hooks -> Stop hooks (can block and force another turn; cap via
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) -> auto-compact check -> append and `next_turn`.

User-visible guard rails found as strings: model substitution can be forbidden (`CLAUDE_CODE_NO_MODEL_FALLBACK`);
response routed to a model outside the org allowlist is discarded; "The model's tool call could not be parsed
(retry also failed)"; `Execution stopped by PostToolBatch hook`.

## 3. The model-call layer (`cln`): the unglamorous 120 KB

This is where a toy agent and the real thing differ most. Features recoverable from its strings and 57 telemetry events:

- **Streaming with a watchdog**: idle timeout, stall detection, stale-connection retry, "no events" handling,
  partial-response finalization, and fallback from streaming to non-streaming.
- **Retry matrix**: 529 retry, per-feature *strip-and-retry* (when the server rejects a beta header, thinking
  config, structured outputs, inline tools, media block, or effort param, drop that feature and resend).
- **Model fallback** (`fallbackModel`, Opus fallback, model-not-found fallback), refusal fallback.
- **Prompt caching**: cache-control markers, cache coverage-loss detection, `prefix_delta`, cache demotion on proxy rejection.
- **Context/limits**: `context_window_exceeded`, `max_tokens_reached`, media-count limits (lowers, then gives up).
- **Input hygiene**: lone-surrogate sanitization, message normalization before send, orphaned-message tombstoning.
- Thinking blocks: resume prefill, signature strip retry, `redacted_thinking`.

## 4. Tool execution

Verified at function level: see [EVIDENCE.md §4](EVIDENCE.md). Summary: partition by `isConcurrencySafe(parsedInput)`,
safe batches run concurrently (cap `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY ?? 10`), unsafe serially, streaming executor with
barrier rule, pipeline `lookup -> parse -> schema -> validateInput -> PreToolUse -> permission -> call -> PostToolUse`.

### Tool inventory (74 `searchHint`s; first-party coding tools)
`Read` (files, images, PDFs, notebooks), `Edit` ("modify file contents in place"), `Write`, `Bash`, PowerShell,
`Glob`, `Grep` (ripgrep), `WebFetch`, `WebSearch`, `NotebookEdit`, `Agent`/Task (delegate to subagent),
`SendMessage`, `Skill`, `EnterPlanMode`/`ExitPlanMode`, `AskUserQuestion`, task list tools
(create/get/list/update), background task tools (output/kill), worktree enter/exit, cron/schedule tools,
`LSP` (definitions, references, symbols, hover), MCP resource tools, `ToolSearch`, `PushNotification`,
`Workflow` ("orchestrate subagents with deterministic JavaScript"), structured-output tool, `ReportFindings`.

## 5. Hooks (33 events)

Events: `PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit,
UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact,
PostCompact, PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied, Setup, TeammateIdle,
TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove,
InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay`.

Output contract (field names found): `hookSpecificOutput.{hookEventName, permissionDecision, permissionDecisionReason,
updatedInput, additionalContext, updatedToolOutput, updatedMCPToolOutput, retry, watchPaths, worktreePath,
sessionTitle, initialUserMessage}`, top-level `decision`, `continue`/`stopReason`. `defer` is print-mode only and solo-call only.

## 6. Config surface

- Settings sources: `userSettings, projectSettings, localSettings, policySettings, managedSettings, flagSettings, cliArg, session`.
- **732 distinct `CLAUDE_CODE_*` environment variables.** Most are feature flags and rollouts, not user-facing; do not copy them.
- Permission modes: `default, acceptEdits, plan, dontAsk, bypassPermissions, auto` (auto = classifier-gated).
- 92 slash commands, e.g. `/compact /clear /resume /model /permissions /hooks /mcp /memory /init /plan /agents /skills /diff /export /fork /rename /context /usage`.
- Built-in agent types: `Explore, Plan, general-purpose, statusline-setup` (+ teammate/workflow variants).
- Compaction: summary prompt "Your task is to create a detailed summary of the conversation so far ...", with `PreCompact/PostCompact`
  hooks, auto-compact with a rapid-refill circuit breaker, and reactive compaction on prompt-too-long.

## 7. Gap analysis: `rea` today vs Claude Code, and build order

| # | Subsystem | rea now | Needed | Why this order |
|---|---|---|---|---|
| 1 | Loop contract | **DONE (v0.3)**: `Harness.query()` generator, 9 terminal reasons, 5 transitions | Remaining: `refusal_retry`, `fallback_sweep`, `rapid_refill_breaker`, `blocking_limit`, `tool_deferred`, `background_requested` | Everything else plugs into it |
| 2 | Model-call layer | **DONE (v0.3)**: streaming, idle watchdog, retry matrix, model fallback, non-streaming fallback, cache markers, surrogate sanitization | Remaining: strip-and-retry for rejected beta features, thinking resume, media limits, cache-coverage monitoring | Reliability on real sessions |
| 3 | Context management | **DONE (v0.4)**: usage-based accounting, 4 context levels, auto + manual + reactive compaction, rapid-refill breaker, PreCompact/PostCompact hooks | Remaining: re-attach recent files, tool-result micro-compaction, per-model windows | Sessions die without it |
| 4 | Sessions | **DONE (v0.5)**: JSONL transcripts, `--continue`/`--resume`, `/resume`, compaction boundaries, crash repair, `/clear` rotates | Remaining: fork, sidechains for subagents, AI titles, picker | Table stakes |
| 5 | Permissions | **DONE (v0.6)**: `Tool(content)` rules, deny>ask>allow, Bash prefix/wildcard/exact, compound-command checks, path rules, workspace boundary, layered settings, `--allowedTools`, "always" | Remaining: real shell parser, classifier mode, policy settings, WebFetch domains | Safety |
| 6 | Subagents | **DONE (v0.7)**: `Agent` tool, general-purpose/Explore/Plan, custom `.rea/agents/*.md`, isolated context, parallel runs, sidechain transcripts, SubagentStart/Stop | Remaining: background agents, SendMessage/continue, worktree isolation, per-agent model | Biggest capability jump |
| 7 | Skills + memory | **DONE (v0.8)**: REA.md/AGENTS.md/CLAUDE.md discovery with imports, rules, `/memory`; skills (`SKILL.md`, commands), Skill tool, `/name args`, `InstructionsLoaded` | Remaining: conditional rules, nested memory on read, plugins | Extensibility |
| 7b | MCP client | **DONE (v0.9)**: stdio + streamable HTTP, tools/resources, `mcp__server__tool`, project-config approval, metadata screening | Remaining: OAuth, SSE/WebSocket, prompts, `list_changed`, deferred tool loading | Extensibility |
| 21 | Managed (policy) settings | **DONE (v0.26)**: `--managed-settings <file>` or a fixed, rea-branded OS default path, read last so `defaultMode`/`sandbox` win over every other source; its permission rules feed the same deny/ask/allow buckets as everything else, which already makes a managed deny unwidenable by any other source | Remaining: remote/MDM delivery, `policyHelper` scripts, `replace`/`merge` composition modes, admin-only fields (autoUpdate, modelPricing, provider allowlists) - enterprise machinery out of scope | Permissions |
| 20 | MCP Elicitation / ElicitationResult hooks | **DONE (v0.25)**: `elicitation/create` (stdio only) answered via `Elicitation`/`ElicitationResult` hooks (auto-accept/decline, reusing the existing `permission`/`updatedInput` hook-output convention) or an interactive dialog; no-tty sessions decline rather than hang | Remaining: `mode:"url"` elicitation (browser-based), HTTP transport elicitation (needs an SSE server-push listener - existing MCP gap) | Hooks + Extensibility |
| 19 | FileChanged / DirectoryAdded hooks | **DONE (v0.24)**: real file watcher (`src/watch.js`, `fs.watch` + known-path snapshot to disambiguate add/unlink), `FileChanged`/`DirectoryAdded` wired into `HOOK_EVENTS`; `DirectoryAdded` fires from `/add-dir` only on a genuine new addition (bundle-evidenced firing rule); found and fixed a `loadSettings` double-merge bug along the way (HOME === cwd) | Remaining: `watchPaths` hook-registration scoping (bundle has it, rea's watcher always covers the whole cwd tree); `register_repo_root` source (no SDK) | Hooks |
| 18 | More slash commands | **DONE (v0.22)**: `/cd`, `/add-dir`, `/rename`, `/session`, `/config` (settings sources + resolved defaultMode/sandbox/permission counts); `/cd` and `/add-dir` reuse the live `rules.cwd`/`additionalDirectories` switch already built for worktrees | Remaining: most of the ~80-command long tail is IDE/editor-integration-only and not portable to a plain CLI | Breadth |
| 17 | NotebookRead / NotebookEdit | **DONE (v0.21)**: read/replace/insert/delete Jupyter cells, fallback cell ids, Read/Edit permission aliasing (RuleSet now supports `permissionAlias`); live-verified on gpt-5.5 | Remaining: `MultiEdit` (batch edits to one file) | Tools |
| 16 | LSP (code intelligence) | **DONE (v0.20)**: real LSP wire client (Content-Length framing, initialize handshake), definition/typeDefinition/references/hover/documentSymbol, symbol-based position resolution, diagnostics capture, per-extension server registry (`--lsp-config`); live-verified against real clangd | Remaining: workspace/symbol search, code actions, rename, formatting, multi-root workspaces | Tools |
| 15 | Worktrees, StructuredOutput, ToolSearch, per-model windows | **DONE (v0.19)**: EnterWorktree/ExitWorktree (real git plumbing, live cwd switch), StructuredOutput (schema-forced final answer), ToolSearch (deferred/lazy MCP tool schemas), per-model context-window table, session `/fork` | Remaining: `--defer-mcp-tools` auto-threshold (currently an explicit flag), worktree sidechains in transcripts | Breadth + core robustness |
| 14 | OS sandbox | **DONE (v0.18 macOS, v0.23 + Linux)**: Seatbelt confinement of Bash: write roots, protected paths, kernel-enforced Read/Edit deny rules, network switch, auto-approve; bubblewrap companion on Linux (own design — bind-mount layering instead of SBPL); platform dispatch via `sandboxAvailable`/`sandboxKind`/`wrapShellCommand` | Remaining: domain-filtering proxy, sandboxing MCP servers, regex deny-read on Linux (bwrap needs concrete paths), real bwrap execution testing (no Linux host in this environment) | Safety |
| 13 | Compaction depth | **DONE (v0.17)**: micro-compaction of old tool results, file re-attachment with an adaptive budget | Remaining: per-model windows, smarter attachment selection (edited files first) | Long sessions |
| 12 | Core completion | **DONE (v0.16)**: refusal retry/fallback, stop_hook_prevented, api/image/model error split, tool_deferred, background_requested, mid-turn absorption, strip-and-retry, cache monitoring, 9 hook events | Remaining: thinking resume, media limits, fallback_sweep | Core |
| 11 | Shell analysis | **DONE (v0.15)**: tokenizer, command classes, path operands, redirects, wrappers, recursive and symlink checks feed Read/Edit/Write rules | Remaining: OS sandbox, interpreter-aware analysis | Safety |
| 10 | Plan mode + questions | **DONE (v0.13)**: EnterPlanMode/ExitPlanMode with approval dialog, plan file, `/plan`, AskUserQuestion | Remaining: phased interview, external editor, per-project plan storage | Workflow |
| 9 | Long tail (partial) | **v0.12**: WebFetch, WebSearch (SearXNG/Brave), Task tools, /help /model /status /usage /tasks /export /diff /init | Remaining: ~25 tools (worktrees, cron, LSP, notebooks, plan mode, AskUserQuestion...), ~80 slash commands, ~20 hook events | Breadth |
| 8 | TUI | **DONE (v0.11, lightweight; v0.27 theming + multi-line editor; v0.28 full-screen pinned input + mouse + live "/"/"@" dropdowns; v0.29 shared with --backend claude-cli)**: spinner, streamed markdown-lite, diffs, permission dialog, footer, history + completion, per-turn Ctrl-C, 3 color themes, multi-line input editor, `--fullscreen` (VT scroll-region pinned input, not alternate-screen), click-to-position mouse support, live slash-command and file-mention suggestion dropdowns - all shared between the default path and the claude-cli reference-mode backend (`createMultilineAsk()` factory, scoped per-backend via a `commands` list so the dropdown never offers commands a backend doesn't implement); all verified against a real pty (not just piped stdio) - three real bugs (`rl.pause()` breaking the terminal; a footer-row off-by-one for mouse clicks; the dropdown/mouse/fullscreen feature set missing entirely from the claude-cli backend) were found and fixed this way, not by code review alone; no Ink | Remaining: arrow-key selection within the dropdowns (Tab accepts the top hit only), recursive/fuzzy "@" file search, footer redraw during an active turn (only while idle at the prompt) | Last; the loop must stream first |

## 8. A note on provenance

This is analysis of a binary you have installed, used to learn *behavior and structure*. When building your own,
write your own prompts and code rather than copying strings or functions verbatim: the system prompts and tool
descriptions in the bundle are Anthropic's text, and their terms of service apply to how you use the product
and its outputs. Treat `EVIDENCE.md` and this file as design notes, not source to paste.
