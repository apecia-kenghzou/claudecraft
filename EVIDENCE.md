# Evidence: how search and the harness work in Claude Code

Source: strings extracted from the installed binary
`~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` (v bundled JS, Bun-compiled).
Identifiers are minified; quoted text is verbatim. Reproduce with `strings -n 8 claude.exe | grep ...`.

## 1. Search

| Claim | Evidence (verbatim from binary) | Where implemented |
|---|---|---|
| Grep is ripgrep, not `grep` | `A powerful search tool built on ripgrep` / `ALWAYS use … for search tasks. NEVER invoke grep or rg as a … command. The … tool has been optimized for correct permissions and access.` | `src/tools.js` GrepTool |
| ripgrep is embedded in the binary | `ARGV0=rg claude.exe --version` → `ripgrep 14.1.1`; env var `USE_BUILTIN_RIPGREP` exists | `src/search.js` `findRg()` (uses `REA_RG`/`rg`, falls back to Node) |
| Exact rg flags | `Pe=["--hidden"] … Pe.push("--max-columns","500") … "-U","--multiline-dotall" … "-i" … "-l" / "-c","-H" … "-n" … "-C"/"-B"/"-A" … "--type" … "--glob"` | `src/search.js` `grep()` |
| VCS dirs always excluded | `voo=[".git",".svn",".hg",".bzr",".jj",".sl"]` each pushed as `--glob !<dir>` | `VCS_DIRS` |
| 3 output modes, default `files_with_matches` | `Output mode: "content" … "files_with_matches" … "count" … Defaults to "files_with_matches".` | `outputMode` |
| Result paging | `head_limit … Defaults to 250 when unspecified. Pass 0 for unlimited`, plus `offset` | `DEFAULT_HEAD_LIMIT`, `page()` |
| Glob splitting rule | `ro.includes("{")&&ro.includes("}") ? keep : ro.split(",")` after `split(/\s+/)` | `splitGlobs()` |
| Multiline is opt-in | `By default patterns match within single lines only … use multiline: true` | `multiline` |
| Glob tool | `Returns matching file paths sorted by modification time` | `glob()` |
| Search results are permission-filtered | after rg runs: read-deny rules applied to results (`Ui(path,perms,"read","deny")`) | not ported (no permission-rule engine; see harness `deny`) |
| Open-ended search delegated to a subagent | `When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the … tool instead` and Explore agent prompt `You are a file search specialist for Claude Code` | not ported (needs a sub-Harness; easy to add) |
| Deferred tool discovery | ToolSearch: `Fetches full schema definitions for deferred tools`, query form `^select:(.+)$`, tools carry a `searchHint` | not ported |

## 2. Harness

| Claim | Evidence | Where implemented |
|---|---|---|
| Hook lifecycle events | `["PreToolUse","PostToolUse","PostToolUseFailure","PostToolBatch","Notification","UserPromptSubmit",…,"Stop","SubagentStart","SubagentStop","PreCompact",…,"PermissionRequest","PermissionDenied",…]` (33 events) | `HOOK_EVENTS` (subset of 5) |
| Permission modes | `"acceptEdits","bypassPermissions","plan","dontAsk","auto"` (+ `default`): `'default' - Standard behavior, prompts for dangerous operations. 'acceptEdits' - Auto-accept file…` | `PERMISSION_MODES`, `#permit()` (`auto` classifier not ported) |
| Tool contract with fail-closed defaults | `fl={isEnabled:()=>!0,isConcurrencySafe:()=>!1,isReadOnly:()=>!1,isDestructive:()=>!1,…}` | `defineTool()` |
| Tool input validated before run | `inputSchema.safeParse(...)` in `f_()`; failures reported as `InputValidationError` | `validateInput()` |
| Parallelism is bounded | env `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`; `isConcurrencySafe` gates batching | `#partition()`, `pMap()` |
| Bounded turns | env `CLAUDE_CODE_MAX_TURNS` | `maxTurns` |
| Output size caps per tool | `maxResultSizeChars:1e5` on tool definitions | head_limit truncation only |

## Not verified (superseded by §4 for ordering)
~~Exact ordering of hook vs. permission evaluation was inferred.~~ Now read directly from source: see §4.

## 3. Cross-check with rea-agents (`rea` 6.4.0)

How it was done: the JS modules embedded in `claude.exe` (Bun standalone) were carved out at NUL boundaries
into a scratch folder, then `rea analyze-javascript-application <dir> --artifact-format directory`.
`rea analyze claude.exe` directly (Ghidra 12.1.4) timed out at 330 s: the logic is JS text, not machine code.

| Input | Result |
|---|---|
| 43 app segments (4.6 MB; Grep prompt, hook events, tool contract) | 43/43 parsed, 0 failures, 966,344 AST nodes; 1,451 function nodes retained for 2 modules (result budget) |
| Grep-tool module alone (`seg-164`) | 658 functions, 2,228 call-sites, 13k+ relations |
| Main entry bundle (`// @bun @bytecode`, 4.76 MB, contains the rg flag assembly) | parsed, 0 failures, 1,164,360 AST nodes; call graph NOT retained (exceeds semantic budget), file-level node only |

What this confirms: the carved text is syntactically valid JavaScript (zero parse failures), so the string
evidence in §1–§2 comes from real parsed source, not binary noise.

What it did not give: a function-level call graph of the Grep implementation. The enclosing function
(the one assembling `--hidden`, `--max-columns`, …) lives in the 4.76 MB main bundle, which `rea` only indexed
at module level. The §1–§2 claims therefore remain string evidence, not control-flow proof.

## 4. Harness: function-level evidence (carved from the binary, queried with `rea`)

Method: modules carved from `claude.exe`, each analyzed separately with
`rea analyze-javascript-application` (43 files parsed, 0 failures; `seg-269` and `seg-285` yielded call graphs).
Identifiers are minified. Snippets are verbatim.

### 4.1 Batching by concurrency safety: `seg-269`, fn `$a`
```js
function $a(e,s,n){return e.reduce((r,y)=>{let T=fn(s,y.name,n),h=T?.inputSchema.safeParse(y.input),
 b=h?.success?(()=>{try{return Boolean(T?.isConcurrencySafe(h.data))}catch{return!1}})():!1;
 if(b&&r.at(-1)?.isConcurrencySafe)r.at(-1).blocks.push(y);else r.push({isConcurrencySafe:b,blocks:[y]});return r},[])}
```
- Input is `safeParse`d first; invalid input is unsafe. A throwing `isConcurrencySafe` is unsafe.
- Consecutive safe calls merge into one batch; everything else is its own batch.
- rea call graph inside `$a`: `e.reduce`, `inputSchema.safeParse`, `isConcurrencySafe`, `r.at`, `r.push`, `Boolean`.
- Ported: `Harness.#isSafe`, test "isConcurrencySafe that throws counts as unsafe".

### 4.2 Limit and runners: `seg-269`
```js
function Ha(){return a.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY??10}
async function*Zo(e,s,n,r){ ... for(let{isConcurrencySafe:T,blocks:h}of $a(e,y.options.tools,...)) if(T){ ... Ka(h,...) } else { ... Wa(...) }
async function*Ka(e,...){yield*Skn(e.map(async function*(y){yield*l2(y,...)...}),Ha())}   // safe batch: merged, capped at Ha()
async function*Wa(e,...){for(let T of e){for await(let h of l2(T,...)) ...}}            // unsafe batch: one at a time
```
- Ported: `REA_MAX_TOOL_CONCURRENCY` (default 10), `ToolExecutor.maxConcurrency`.

### 4.3 Streaming executor: `seg-285`
```js
canExecuteTool(e){let o=this.tools.filter((n)=>n.status==="executing");return o.length===0||e&&o.every((n)=>n.isConcurrencySafe)}
async processQueue(){for(let e of this.tools){if(e.status!=="queued")continue;
  if(this.canExecuteTool(e.isConcurrencySafe))this.applyEndedRunLayers(),await this.executeTool(e);
  else if(!e.isConcurrencySafe)break}}
```
- Tools are queued as they stream in. An unsafe tool is a barrier (`break`); a blocked safe tool is skipped.
- Synthetic results exist for `user_interrupted` / `background` / user-rejected (`toolDenialKind`: interrupted, cancelled, user-rejected).
- Ported: `src/executor.js` (`ToolExecutor`); tests "unsafe tool is a barrier", "abort produces synthetic errors".

### 4.4 Per-tool pipeline order: `main.js`, fns `l2` -> `GWo` -> `KWo`
| Step | Evidence (verbatim fragments) | Ported in |
|---|---|---|
| Tool lookup, aliases, wait for pending MCP tool | `fn(s.options.tools,w,s.options.toolAliases)`, `tengu_mcp_pending_tool_wait` | lookup only |
| Unknown tool | `<tool_use_error>Error: No such tool available: ${w}${...}</tool_use_error>` | `#runOne` |
| Unparsable JSON input | `${e.name} was called with input that could not be parsed as JSON. You sent (first ${es.length} of ${hr} bytes) ... Common causes: unescaped backslashes ... Retry with valid JSON.` | `#parse` |
| Schema validation ignoring extra keys | `r.error.issues.filter((h)=>h.code!=="unrecognized_keys")` | `validateInput` |
| Tool-specific validation with remedy | `tool_validate_input_rejected` ... `toolResultRemedy:uo.remedy` | `tool.validateInput` |
| PreToolUse hooks (events below) | `for await(let uo of Dsr(Pt,e,Rt,n,...))switch(uo.type){case"message"... "hookPermissionResult" ... "hookUpdatedInput" ... "preventContinuation" ... "stopReason" ... "additionalContext" ... "defer" ... "stop"}` | `#runOne` hook loop |
| Permission decision AFTER hooks, fed by the hook | `no=await Msr(qt,e,Rt,{...},h,...)`, `tn=no.decision; Rt=no.input` (`qt` = hookPermissionResult; the decision can rewrite input) | `#permit(tool,input,hookPermission)` |
| Denied / ask -> error result | `tn.behavior!=="allow"` -> `{type:"tool_result",content:es,is_error:!0}`; hook stop text `Execution stopped by PreToolUse hook${...}` | `Permission denied: ...` |
| `defer` only in print mode and only for a solo tool call | `defer is print-mode only`, `defer is solo-only` | not ported |
| Pipeline is middleware around `tool.call` | `nt=k7t({core:{"tool.call":Je.core},managed:{"tool.call":Je.managed}, withoutModuleHandlers:s.options.settingsHooksOff...})`; `nt.tool.call($e)` then `DWo` (post-processing) | simplified to a hook loop |
| Any thrown error -> error result | `Error calling tool${nt}: ${Je}` inside `<tool_use_error>` | `#runOne` catch |
| Results stream through an async queue with progress / `tool_heartbeat` events | `_e=new bv; _e.enqueue(...)` | not ported |

### 4.5 What changed in this repo because of §4
- Hooks now run **before** permission and can return `permission: allow | deny | ask`, `updatedInput`, `stop`, `additionalContext`
  (v0.1 ran permission first and could only deny/rewrite).
- The tool loop uses `ToolExecutor` rather than ad-hoc batches.
- Failures use `<tool_use_error>` wrapping and the exact "No such tool available" wording.

### 4.6 Design choices NOT taken from evidence
- A static `deny` list always beats a hook `allow`. The bundle shows hook results feeding `Msr`; I did not verify how deny
  *rules* interact with a hook allow, so this is the conservative choice.
- The concurrency cap inside the streaming executor is mine; the bundle applies its cap in the batch path (`Ka`).

## 5. Hook output field names (found in the bundle)
`hookSpecificOutput.{action, additionalContext, classifierContext, content, decision, displayContent, hookEventName,
initialUserMessage, permissionDecision, permissionDecisionReason, reloadSkills, retry, sessionTitle,
suppressOriginalPrompt, updatedInput, updatedMCPToolOutput, updatedToolOutput, watchPaths, worktreePath}`.
Ported (subset) in `src/hooks.js` `normalizeHookOutput`. Full subsystem map: [ARCHITECTURE.md](ARCHITECTURE.md).

## 6. Loop recovery behaviour read from `yd` (m0567), and what v0.3 does about it
Verbatim control flow, telemetry stripped. Our implementation is original code with the same observable behaviour.

| Bundle behaviour (fragment) | rea v0.3 |
|---|---|
| Output cut off: `transition:{reason:"max_output_tokens_recovery",attempt:ue}` after appending a meta user message; bounded by a limit (`ue<=kr`); beyond it the error is surfaced | `max_tokens` -> keep partial answer, nudge, up to 3 attempts, then terminal `max_output_tokens_exhausted` (own name) |
| `(h?.message.stop_reason??Mn)==="tool_use"&&xt.length===0` -> tombstone partial messages, append meta message, `malformedToolUseRetried:!0`; second time `{reason:"malformed_tool_use_exhausted"}` with text "The model's tool call could not be parsed (retry also failed)." | same one-retry-then-exhaust behaviour |
| `end_turn`/`stop_sequence` with no non-empty text block -> `thinkingOnlyNudged:!0`, `messages:[...I,ue]` (the empty assistant message is *not* kept), `transition:{reason:"thinking_only_retry"}` | same, one nudge |
| Stop hook `blockingErrors` appended as messages, `stopHookBlockingCount`, cap `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? 8`, then warning and `{reason:"completed"}` | same (`REA_STOP_HOOK_BLOCK_CAP`, default 8) |
| `if(v&&ue>v) ... {reason:"max_turns",turnCount:ue}` after yielding a `max_turns_reached` event | same event and reason |
| Aborts: `aborted_streaming` (during model call) vs `aborted_tools` (during tool execution) | same two reasons; queued tools get synthetic "Interrupted" results so every tool_use has a tool_result |

## 7. Compaction: behaviour read from the bundle (main bundle, functions `w5`, `O4`, `D$e`, `L$e`, `sio`, `Drr`, `T1`, `wF`)
| Bundle fragment | Meaning | rea (`src/context.js`) |
|---|---|---|
| `w5(e,n){let r=Math.min(e.maxOutputTokens,Hrr)...return h-r}`, `Hrr=20000` | effective window = context window - min(maxOutputTokens, 20000) | `effectiveWindow` |
| `O4(e,n){let r=e-13000; ... pct override: Math.min(Math.floor(e*(s/100)),r); return r}` | hard reserve of 13,000 tokens; `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` caps the threshold | `compactThreshold` (`REA_AUTOCOMPACT_PCT_OVERRIDE`) |
| `D$e(e,n){return Math.min(e-Math.round(e*n.precomputeBufferFraction),O4(e,n))}`, default fraction `zle=0.2` | compact when 20% of the window is left, never later than the hard reserve | `DEFAULT_BUFFER_FRACTION` |
| `L$e`: `blocked` at `window-3000`; `compact` at threshold if enabled; `warn` at `threshold-20000`; else `ok` | four context levels | `contextLevel` |
| `sio(e){return e?.compacted===!0&&e.turnCounter<3?(e?.consecutiveRapidRefills??0)+1:0}`, `Drr`: `n>=3?"trip":"proceed"` | circuit breaker: 3 compactions in a row within 3 turns of each other | `nextRefillState` |
| `B9r="Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row."` | the user-facing message | own wording, same meaning |
| `T1(trigger,preTokens,...,messagesSummarized)` -> `{type:"system",subtype:"compact_boundary",compactMetadata:{trigger,preTokens,userContext,messagesSummarized}}` | boundary marker with trigger and counts | `compactions` log + `compact_end` event |
| `wF(e){return[e.boundaryMarker,...e.summaryMessages,...e.replacement??[],...e.messagesToKeep,...e.attachments,...e.hookResults]}` | replacement history = boundary + summary + some messages kept verbatim + re-attached context | summary message + kept latest user turn (attachments not ported) |
| `won(e,...)`: `Compaction blocked by PreCompact hook: ${e.blockedBy}` | PreCompact hooks can veto | `PreCompact` hook `stop`/`deny` |
| Summary prompt: 9 sections (request, concepts, files, errors, problem solving, **all user messages**, pending, current work, next step), `<analysis>` scratchpad then `<summary>` | structure of the summarization request | `buildCompactionPrompt` (own wording, same sections) |
| `hasAttemptedReactiveCompact` in loop state; reason `prompt_too_long` | reactive compaction once per query on a too-long error | `g.reactiveTried` |

Not ported: re-attaching recently read files after compaction, per-model window tables, server-side context editing,
micro-compaction of tool results, the `/compact` "summarize from here" variant, transcript-level boundary persistence.

## 8. Sessions: behaviour read from the bundle and from the shape of a real transcript (keys only, no content)
| Finding | Evidence | rea (`src/session.js`) |
|---|---|---|
| One append-only JSONL file per session, in a per-project directory named from the cwd | `rc(YRt(),`${e}.jsonl`)`; slug `cwd.replace(/[^a-zA-Z0-9]/g,"-")`; real dir `~/.claude/projects/-Users-...-rea/<uuid>.jsonl` | `~/.rea/projects/<slug>/<sessionId>.jsonl`, same slug rule |
| Entry per message with `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`, `isSidechain`, `message` | keys of real `user`/`assistant`/`system` entries | same minus `gitBranch`/`isSidechain` |
| Metadata entries: `custom-title`, `ai-title`, `last-prompt`, `mode`, `permission-mode`, `tag`, `queue-operation`, `file-history-snapshot` | `type:"..."` constructors and counts in a real file | `meta` entries: `title`, `last-prompt` |
| Compaction boundary is a `system` entry with `compactMetadata{trigger,preTokens,userContext,messagesSummarized}` and a `logicalParentUuid` that bridges the chain | `T1(...)` constructor | `recordCompaction` writes the boundary, then the new history |
| Reload starts at the last boundary | `ri(e){let r=WMe(e);return r===-1?e:e.slice(r)}`, `WMe` = last index of a `compact_boundary` | `loadSession` slices after the last boundary |
| Transcript file mode 0600 / directory 0700 (for sibling state files) | `atomicWrite(path, data, 384)`, `mkdir(dir, 448)` | same modes |
| Resume has fallbacks (worktree lookup, transcript-id scan) and a size cap of 50 MB (`tJr=52428800`) | `Jho`, `eyo`, `tJr` | not ported |

Added by rea, not from the bundle: `repairHistory` (synthetic results for dangling `tool_use` after a crash, never persisted).
Not ported: sidechains for subagents, `--fork-session`, AI-generated titles, the picker UI, cross-worktree lookup.

## 9. Permission rules: what is verified and what is not
| Behaviour | Status | Evidence |
|---|---|---|
| Rule strings are `Tool` or `Tool(content)`; content `""` or `"*"` means the whole tool; `\(`, `\)`, `\\` escape; malformed if the name contains parens or `)` is not last | **verified** | `hpe`, `Un`, `_n`, `vAo`, `kAo`, `h` in module `m0214` |
| Bash content kinds: `cmd:*` is a prefix rule; an unescaped `*` makes a wildcard; otherwise exact; exact rules keep their text as written | **verified** | `Bxe`, `oko`, `jxe` in `m0251` |
| Wildcard: `*` -> `.*`, `\*` literal, whitespace runs collapse, a single trailing ` *` also matches the bare command | **verified** | `uZ` in `m0251` |
| File-pattern tools: Read, Write, Edit, Glob, NotebookRead, NotebookEdit, Cd; WebFetch uses `domain:host`; WebSearch forbids wildcards | **verified** | `wUe` in `m0251` |
| Rule storage by behaviour and source: `alwaysAllowRules` / `alwaysDenyRules` / `alwaysAskRules`; sources include `userSettings`, `projectSettings`, `localSettings`, `cliArg`, `session`, `policySettings`; `additionalWorkingDirectories` | **verified** (names) | `m0444`, `VAn` |
| Precedence deny > ask > allow; deny rules still apply in bypass mode | documented behaviour, not traced in the bundle | |
| Compound commands: deny/ask on any part, allow only if all parts allowed; substitutions and output redirection are never auto-allowed by a broad rule | my conservative design (the bundle has a full shell parser, not read) | |
| Path roots `//abs`, `~/`, `/root-relative`, `./cwd-relative`, bare basename | documented conventions, not verified in the bundle | |
| Reads outside the working directories ask | documented behaviour, not traced | |

Not ported: the shell parser and command-injection checks, `safetyCheck` decision reasons, classifier ("auto") mode, managed/policy settings,
WebFetch domain rules, rule editing UI, `Task(AgentType)` rules.

## 10. Subagents: what the bundle shows, and what rea does
| Finding | Evidence | rea (`src/agents.js`) |
|---|---|---|
| Agent definition fields: `agentType`, `whenToUse`, `tools` (`["*"]` or list), `disallowedTools`, `model: "inherit"`, `source`, `omitClaudeMd`, `getSystemPrompt`, plus `background`, `isolation`, `requiredMcpServers` | `TT={agentType:"Explore",whenToUse:...,disallowedTools:[...],source:"built-in",model:"inherit",omitClaudeMd:!0,getSystemPrompt:()=>KWn()}` ; `i2={agentType:"general-purpose",tools:["*"],...}` | same core fields; `permissionMode`, `maxTurns` added |
| Built-in types: general-purpose (all tools), Explore (read-only, fast), Plan (read-only architect), statusline-setup | `TT`, `ute`, `i2`, `DHo` | first three; statusline-setup not ported |
| Explore and Plan are read-only by *disallowing* write tools and by prompt; they cannot spawn agents | `disallowedTools:[yt,...UQ,vw,ht,Xt,Zi]` | `plan` permission mode + no Write/Edit/Agent in tool list |
| Agent tool input: `prompt`, `description`, `subagent_type`, `model`, `run_in_background`, `cwd`, `isolation` (`worktree`/`remote`) | `zt=(n,e)=>({...n,prompt:e.prompt,description:e.description,subagent_type:e.subagentType,model:e.model,run_in_background:e.background,cwd:e.cwd})`, `Sn` | `description`, `prompt`, `subagent_type`; background rejected; no model/cwd/isolation |
| Result to the parent: the child's final content blocks, `(Subagent completed but returned no output.)` when empty, then `agentId: ... <usage>subagent_tokens: N tool_uses: N duration_ms: N</usage>` | `m0539` result builder | same footer, own wording elsewhere |
| A finished agent can be continued by id via SendMessage; async agents notify on completion | `use SendMessage with to: '${agentId}'`, `status:"completed"` / async branch | not ported |
| `CLAUDE.md` memory is omitted for read-only agents | `omitClaudeMd:!0` | n/a (rea has no memory loader yet) |
| Agents get their own transcripts and an `isSidechain` flag; subagent stop hooks replace `Stop` | `isSidechain`, `SubagentStop`, `SubagentStart` | `<session>/subagents/<agentId>.jsonl`; `SubagentStop` used as the child's Stop |

Design decisions that are mine, not read from the bundle: children cannot nest (no Agent tool); parallel `Agent` calls run concurrently
(the tool is marked concurrency-safe); permission prompts are serialized in the CLI so parallel agents cannot interleave questions;
`subagent_tokens` sums per-call input+output.
Not ported: background agents and notifications, SendMessage/continue, worktree and remote isolation, per-agent model selection,
agent teams/teammates, `Task(AgentType)` permission rules, plugin-provided agents.

## 11. Memory and skills
### Memory (CLAUDE.md family)
| Finding | Evidence | rea (`src/memory.js`) |
|---|---|---|
| Search list per directory: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/CLAUDE.md`, `.claude/AGENTS.md`, `.claude/rules` | `eRt=[["CLAUDE.md"],["CLAUDE.local.md"],["AGENTS.md"],[".claude","CLAUDE.md"],[".claude","AGENTS.md"],[".claude","rules"]]`, `tRt=[[".claude","rules"]]` | `REA.md`, `REA.local.md`, `AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.rea/{REA,AGENTS}.md`, `.claude/{CLAUDE,AGENTS}.md`, `.rea/rules`, `.claude/rules` (the Claude names are read for compatibility) |
| Files are collected "within" a directory and "above" it (parent walk) | `cZn=(e,n)=>({within:...,above:(r)=>...})` | ancestors from outermost to cwd, user files first |
| `@path` includes are separate entries; HTML comments stripped; non-text files skipped with a log line | `YNe`: `Skipping non-text file in @include`, `<!--` lexed and removed, `includePaths` | same (depth limit 5, cycle-safe) |
| Rules may carry `paths`/globs (conditional) | `OZn` returns `{content, paths}` | conditional rules are skipped and reported by `/memory` (not applied) |
| Delivered as meta user content labelled with the file path (`Contents of <path>:`) | `nested_memory:(e)=>...Contents of ${e.content.path}: ${e.content.content}`, `isMeta:!0` | appended to the system prompt in `<memory-file path type>` blocks |
| Read-only built-in agents omit memory | `omitClaudeMd:!0` on Explore and Plan | `omitMemory: true` on Explore and Plan |
| `InstructionsLoaded` is a hook event | hook event list | emitted at startup with the file list |

### Skills
| Finding | Evidence | rea (`src/skills.js`) |
|---|---|---|
| A skill is a directory with `SKILL.md`; name sanitized to `[a-zA-Z0-9_-]`; file size limit | `eue(e,"SKILL.md")`, `.replace(/[^a-zA-Z0-9_-]/g,"-")`, `jHe` byte limit | same; 256 KB limit |
| Frontmatter: `name`, `description`, `model`, `allowed-tools`, `disallowed-tools`, `argument-hint`, `disable-model-invocation`, `user-invocable` | the zod schema `iVn` | all except `model` (parsed, not applied) |
| `disable-model-invocation` hides a skill from the model; `user-invocable: false` hides the slash command | `iVn` descriptions, `Bae(e)` | same |
| Model path is the Skill tool; user path is `/name`; a mention in a message prompts the model to use the skill | `skill_mention`: "The user's message contains /${e.skillName}, which is the name of a skill..." | Skill tool + `/name args` expansion (mention hinting not ported) |
| `allowed-tools` grants tool availability while the skill is active | schema description | session allow rules with source `skill:<name>`; deny rules still win |

Not ported: plugins and plugin skills, bundled/remote skills, conditional (`paths`) rules, auto-memory ("AutoMem"), nested directory
memory loaded when a file in that directory is read, skill `model` override, `disallowed-tools` while active, argument typing.

## 12. MCP: what the bundle shows, and what rea does
| Finding | Evidence | rea (`src/mcp.js`) |
|---|---|---|
| Project config is `.mcp.json` with a top-level `mcpServers` object | `Epo`: reads `.mcp.json`, requires `"mcpServers"in r` | same; also `mcpServers` in settings files and `--mcp-config` |
| Transports: stdio (default), `sse`, `http`, `ws`; servers have `command`/`args`/`env` or `url` | `r.push({name,transport:"sse"/"http"/"ws",url,...})`, config `type` field | stdio and streamable HTTP; `sse` and `ws` rejected with a clear error |
| Tool name `mcp__<normalized server>__<tool>`; server-prefix matching `mcp__<server>__` | `cre=(e,n)=>`mcp__${In(e)}__${n}``, `O5`, `e_` | `mcp__<server>__<tool>`, `[^a-zA-Z0-9_-]` -> `_` (normalization rule assumed) |
| Tool descriptions are capped (env `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`) | `Px()` | 2048 characters (default value is mine) |
| Tool metadata containing fake tool-call markup (`<invoke>`) or HTML-ish tags is flagged | `V8t=["<invoke>","<invoke ",...]`, `Y8t=new Set([...html tag names])`, `Hjo` | tools whose description or parameter descriptions contain `<invoke`/`<function_calls>` are dropped with a warning |
| `.mcp.json` servers are gated by approval (`enableAllProjectMcpServers`, `enabledMcpjsonServers`) | env/setting names in the bundle | approval by name in `.rea/settings.local.json`; interactive prompt with "always" |
| Resource listing and reading are tools | searchHints: "list resources from connected MCP servers", "read a specific MCP resource by URI" | `ListMcpResources`, `ReadMcpResource` |

From the MCP specification (not the bundle): JSON-RPC 2.0, newline-delimited on stdio; `initialize` then `notifications/initialized`;
`tools/list` with `nextCursor`; `tools/call` returning `content[]` and `isError`; `resources/list` / `resources/read`;
`notifications/cancelled` for timeouts and aborts; HTTP uses POST with `Accept: application/json, text/event-stream` and `Mcp-Session-Id`.

Design choices of mine: a server's `readOnlyHint` is not trusted (all MCP tools ask unless an allow rule such as `mcp__server` exists);
output capped at 100k characters; startup timeout 30 s (`MCP_TIMEOUT`); servers that fail to start are skipped with a warning.
Not ported: OAuth and auth flows, SSE and WebSocket transports, prompts as slash commands, `list_changed` refresh, sampling and elicitation,
deferred tool loading (ToolSearch), plugin-provided servers, per-agent server requirements.

## 13. Web tools, tasks and extra slash commands: provenance
| Item | Status |
|---|---|
| WebFetch permission content is `domain:hostname`; URLs and `http...` are rejected in rules with the hint "use domain:hostname" | **verified** (`wUe.customValidation.WebFetch` in `m0251`) |
| WebSearch rules reject `*` and `?` ("WebSearch does not support wildcards") | **verified** (same table) |
| Tool names `WebFetch`, `WebSearch`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`; hints "fetch and extract content from a URL", "search the web for current information", "create a task in the task list", "retrieve a task by ID", "list all tasks", "update a task", "manage the session task checklist" | **verified** (tool `searchHint` strings) |
| Slash commands `/help /model /status /export /diff /init /usage /tasks /context /compact /clear /resume` exist | **verified** (command registry) |
| Everything else: HTML-to-text conversion, SSRF guard, same-site redirect policy, extraction step with an untrusted-content prompt, SearXNG/Brave backends, task data model, `/export` format | **my design**, not read from the bundle |

Claude Code's WebSearch is a server-side tool of the Anthropic API; an OpenAI-compatible endpoint has no equivalent, so rea uses a
configured backend (SearXNG or Brave) and registers the tool only when one is set. Not ported: WebFetch result caching and
pre-approved host lists, `domain:` rules with paths, search result citations, task owners and cross-session task lists.

## 14. Plan mode and AskUserQuestion
| Finding | Evidence | rea (`src/plan.js`) |
|---|---|---|
| `EnterPlanMode` is main-session only; it sets the permission mode to `plan` for the session; read-only and concurrency-safe; "Only the main session can enter plan mode." | `validateInput(){if(e.agentId)return{result:!1,message:"Only the main session can enter plan mode."...}}`, `setToolPermissionContext(... {type:"setMode",mode:"plan",destination:"session"})` | `enterPlanMode()`, `isSubAgent` check |
| Tool result tells the model to explore, consider approaches, ask questions if needed, design, then present with ExitPlanMode; "DO NOT write or edit any files yet" | `mapToolResultToToolResultBlockParam` | tool result wording (own) |
| While active: "you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools ... This supercedes any other instructions" | plan-mode reminder `SDn` | `planModeReminder()` appended to the system prompt in plan mode |
| A turn may end only with a clarifying question or ExitPlanMode; never ask for plan approval in text | `xLn`: "your turn should only end with either using the AskUserQuestion tool OR calling ExitPlanMode" | same rule in the reminder |
| Plan lives in a plan file; the model is told its path; later "A plan file exists from plan mode at: ..." | `plan_file_reference` attachment | `~/.rea/plans/<session8>.md`, the only writable file; readable (with its directory) in plan mode |
| Phased workflow using Explore (understanding) and Plan agents (design), then review, final plan, ExitPlanMode | `jqr()` "Phase 1: Initial Understanding ... Launch up to N Explore agents IN PARALLEL" | summarized as a workflow hint; agents already exist |
| AskUserQuestion caps options at 4; no pre-selected default; recommended option first with "(recommended)" | skill text near `multiSelect` | 2-4 options, 1-4 questions, header <= 12 chars, "Other" always offered |

Design decisions that are mine: approval options (proceed in the previous mode / proceed with auto-accept edits / keep planning with typed
feedback), plan text may be passed to ExitPlanMode directly, non-interactive sessions get an explanatory error and stay in plan mode,
sub-agents never receive these three tools.
Not ported: plan-mode interview/phase gating, plan editing in an external editor, "ultraplan", saving approved plans per project, hooks on plan events.

## 15. Safeguards added after the long live session (rea-original; not read from the bundle)
Found by running a ~6-minute, ~40-request build session and a hostile resume on `gpt-5.5` (window 60k, threshold forced to 20-25%):

| Failure observed live | Cause | Fix |
|---|---|---|
| Compaction made the context *larger* (10.4k -> 11.2k) | Summarizing 1 short message produced a longer summary | `MIN_SUMMARIZE_TOKENS` (1,500): skip silently; a compaction that frees < `MIN_COMPACT_GAIN` (500) is reverted and counted as a failure |
| The thrash breaker fired and every later prompt ended instantly without calling the model (session unusable until `/clear`) | Fixed overhead (system + ~35 tool definitions) sat just under the threshold | A trip now *suspends* auto-compaction (warning, `/compact`/`/clear` or recovery re-enables it) instead of ending every turn |
| Threshold could sit at or below the fixed overhead | `compactPct` / small windows ignored the baseline | Threshold floor = baseline + max(4,000, 10% of window); `feasible` is false (and shown) when the budget cannot work |
| After five compactions the model mis-stated the first request and forgot task subjects | Summaries of summaries drift | The user's prompts and the task list are carried **verbatim** in the summary (`<user-messages>`, `<session-state>`) and rebuilt on resume |
| `Compaction failed: terminated` / `fetch failed` bursts when the VPN dropped | Environment | Verified behaviour: 4 retries with backoff, non-streaming fallback, clean per-turn failure, session intact |

## 16. Shell analysis for Bash permissions
| Finding | Evidence (bundle, main bundle chunk `c007`) | rea (`src/shell.js`, `src/permissions.js`) |
|---|---|---|
| Commands are classified by operation: `read` (cd, ls, find, cat, head, tail, sort, uniq, wc, cut, paste, column, tr, file, stat, diff, awk, grep/rg, jq, git, sha*sum ...), `create` (mkdir, touch), `write` (rm, rmdir, mv, cp, sed, tee) | `Jx={cd:"read",ls:"read",...,mkdir:"create",touch:"create",rm:"write",...,sed:"write",...,tee:"write"}` | per-command tables with the same three classes (own list; awk/sed/env are *not* auto-allowed) |
| Per-command argument parsers extract path operands (generic positional, `find` special flags, `cut`/`paste`/`column` valued flags, `tr`, `awk`, `tee`) | `b7={cd:...,ls:...,find:(e)=>...,cut:dw({booleanShort,valuedShort,...}),...}` | `pathOperands()`: positional + valued-flag handling, pattern-first commands (grep/rg/jq), `sed` script, `find` expression boundary, `cp`/`mv` targets |
| Output redirections (`>`, `>|`, `&>`, `>>`, `&>>`, `>&`) are write targets; `/dev/null` and fd duplication (`>&2`, `>&-`) are exempt | `svr=new Set([">",">|","&>",">>","&>>",">&"])`, `V.op===">&"&&/^(?:\d+\|-)$/`, `b!=="/dev/null"` | same exemptions; `<` is a read; here-docs/here-strings carry no path |
| Deny rules on output-redirection targets deny; targets outside the working directory ask | `lvr`: `sR(b.target,n,r,"create")`, `decisionReason.type==="rule" -> deny`, else `ask` | `#pathRules` (deny/ask) + harness workspace boundary |
| `cd` combined with output redirection needs approval because the final directory cannot be determined reliably | "Commands that change directories and write via output redirection require explicit approval ... Claude Code cannot automatically determine the final working directory" | `cdWithWrite` -> ask (rea additionally tracks literal `cd` targets for later relative paths) |
| `env -C dir`, `pushd` change the directory seen by later commands | `zwr`: `h==="env"` with `-C`/`--chdir`, `pushd` | `unwrap()` and `cd` tracking |
| `mv`/`cp` target-directory forms, `sort -o`, `uniq in out`, `find -exec/-delete/-fprint` treated as writes | `bJo`: `sort ... -o`, `uniq && X.length>=2`, `find && RXt(_e)` | `mutatingFlags()` / `pathOperands()` |

rea-original: the tokenizer (quotes, escapes, here-docs with quoted/unquoted delimiters, process substitution, grouping, keywords,
dangerous environment assignments), wrapper stripping (`time nice timeout nohup command env`), recursive-operation overlap checks
(`rm -r src` against `Edit(./src/**)`, `rg`/`grep -r` against `Read(.env)`), symlink target checks, "unresolvable path asks when path
rules exist", and the strict git read-only subset.

**Known limits (stated, not hidden):** this is argument analysis, not a sandbox. `python3 -c`, `node -e`, `bash -c`, scripts, `xargs`,
`eval`, aliases, shell functions and anything unrecognized can read or write arbitrary paths; unrecognized commands ask in default mode,
but an explicit allow rule such as `Bash(python3:*)` lets them past path rules. TOCTOU between check and execution is not addressed.
The real fix is OS-level sandboxing (the bundle uses seatbelt/bubblewrap); that subsystem is still L0.

## 17. Remaining core loop and model-layer behaviours (v0.16)
| Bundle behaviour (function `yd` / `cln`) | Evidence | rea |
|---|---|---|
| `refusal_retry`: on a refused response the refused output is removed (`kept`/`notRun`), a nudge is appended, guard `refusalRetrySpent:!0`, `transition:{reason:"refusal_retry",model}`; a refusal can also fall back to another model (`model_refusal_fallback`, "retry") | `za({refused,kept,answered,started,...})`, `W={guards:{...De,refusalRetrySpent:!0},...transition:{reason:"refusal_retry",model:Se}}` | `stop_reason: 'refusal'` (OpenAI `content_filter` mapped) -> drop, nudge, retry once; optional `refusalFallbackModel`, restored afterwards |
| `stop_hook_prevented`: Stop hooks return `preventContinuation` and there are no blocking errors | `if(Cr>0&&Pe.blockingErrors.length===0)if(Pe.preventContinuation)return{reason:"stop_hook_prevented"}` | Stop hook `continue:false` -> `stop_hook_prevented` (a block takes precedence) |
| `api_error` (an API error message ended the turn; carries `errorKind`, `isTransient`, `quotaLimits`) vs `model_error` (exception while querying) vs `image_error` (media errors) | `return{reason:"api_error",errorKind:h.error,isTransient:tQr(h),...}`, `A?"image_error":"model_error"` | `ModelError` -> `api_error` (+`errorKind`, `isTransient`); media-related invalid request -> `image_error`; anything else `model_error`; `StopFailure` hook on api/model errors |
| `tool_deferred`: a PreToolUse hook `permissionDecision:"defer"` ends a solo call in a non-interactive session ("defer is print-mode only", "solo-only ... siblings would be orphaned") | `if(he.toolWasDeferred)return uo(p,b),{reason:"tool_deferred"}`, `hook_deferred_tool` | `permission:'defer'` + `nonInteractive` + batch of one -> `tool_deferred` with the call; otherwise treated as ask |
| `background_requested`: `shouldStopBeforeNextApiCall?.()` checked before each API call | `if(Tr&&W.toolUseContext.shouldStopBeforeNextApiCall?.())return yield*Xt,{reason:"background_requested"}` | `requestStop(why)`; loop returns at the next boundary with tool results intact |
| `absorbed_mid_turn`: queued user commands are folded into the conversation at turn start (`p.consume(De,{reason:"absorbed_mid_turn"})`) | `isMidTurnFoldSuspended`, `getCommandQueue().filter(...)` | `queueMessage()`; CLI queues lines typed during a turn (terminal mode) |
| Strip-and-retry on rejected optional features (`retry:inline-tools-strip`, `retry:effort-unsupported`, `retry:structured-outputs-unsupported`, beta header rejections ...) | the `retry:*` labels in `cln` | OpenAI client: drops `stream_options`, then swaps `max_completion_tokens` -> `max_tokens`; Anthropic client: drops `cache_control`; each once, with a warning |
| Prompt-cache coverage monitoring (`cache_coverage_loss`, `api_prompt_cache_coverage`) | telemetry names in `cln` | `cache_miss` event + counter when cached tokens fall to zero after hits |
| Hook events `PermissionRequest`, `PermissionDenied`, `StopFailure`, `Notification`, `UserPromptExpansion`, `PreModelSwitch`, `PostModelSwitch`, `TaskCreated`, `TaskCompleted` | hook event list | emitted from the permission path, loop failure paths, `/model`, slash expansion and the task list |

Not ported: `fallback_sweep` (mid-stream tombstoning; rea's retry events cover the visible behaviour), `rapid_refill_breaker` details beyond
what exists, thinking-block resume and signature stripping, media limits, quota-limit payloads, `truncated_response_recovery` (folded into
the max-output recovery), and the remaining ~10 hook events that need subsystems rea does not have (worktrees, file watching, config reload).

## 18. Compaction depth: micro-compaction and file re-attachment (v0.17)
| Item | Evidence | rea |
|---|---|---|
| Replacement history is `[boundary, summary, replacement, messagesToKeep, attachments, hookResults]`: attachments (re-read context) are re-added after a compaction | `wF(e){return[e.boundaryMarker,...e.summaryMessages,...e.replacement??[],...e.messagesToKeep,...e.attachments,...e.hookResults]}` | summary, then one `isFileAttachment` message with current file contents, then kept turn |
| Old tool results can be cleared in place with a marker, driven largely by server-side context editing (`clear_at` headers, `microcompact`, marker `"[Old tool result content cleared]"`) | marker constant and `retry:kept-reminder-clear-at` / `api_kept_reminder_clear_at` labels | client-side only (no such API on other providers): same marker, own policy |
| Policy details (which tools, how many kept, thresholds) | not recoverable from the bundle (server-side) | **mine**: compactable tools Read/Grep/Glob/Bash/WebFetch/WebSearch/MCP; keep the 4 most recent results; only results >= 1,500 chars; errors never cleared; runs at >= 70% of the compaction threshold |
| Attachment policy (how many files, budgets) | not read | **mine**: up to 5 recently read/written files, 5k tokens each, total <= min(20k tokens, 10% of window, **half of what the summary freed**) |

Found by running it live (gpt-5.5, 60k window, 10% threshold):
- A fixed 10%-of-window attachment budget made a compaction *net-negative* in a small context (8.5k -> 8.7k) and the guard reverted it.
  The budget is now capped at half of the tokens freed, so a compaction always nets a real reduction.
- The "compacting..." line was printed before the not-worth-it check, so skipped compactions looked like silent failures; skips are now announced.
- Outcome of the recall check: the most recent file is recovered exactly; older files are not (budget), and the model says so instead
  of guessing. Micro-compaction did not trigger in that scenario (fewer than five large results); it is covered by unit tests only.

## 19. OS sandbox (macOS Seatbelt)
| Finding | Evidence (module `m0345`, functions `a5`, `$mr`) | rea (`src/sandbox.js`) |
|---|---|---|
| Commands are wrapped as `env ... /usr/bin/sandbox-exec -p <profile> <shell> -c <command>`; nothing is wrapped when there is nothing to restrict | `A9(["env",...,"/usr/bin/sandbox-exec","-p",$e,or,"-c",r])`, `if(!s&&!nt&&!pt&&!Rt&&!Se)return r` | `wrapShellCommand()`; only when the sandbox is on |
| Profile structure: `(version 1)`, `(deny default (with message ...))`, process/mach/ipc/iokit/sysctl allowances (Chrome-sandbox style), then `; Network`, `; File read`, `; File write` sections, optional pty support | `a5({readConfig, writeConfig, needsNetworkRestriction, httpProxyPort, ...})` | `(allow default)` base instead of deny-default; same three concerns |
| Reads: allowed except `denyOnly` paths; writes: `allowOnly` roots with deny-within-allow; unlink/create denied for protected files | `X6(e??{denyOnly:[]},n?.allowOnly,r)`, `s5(...)`, `i5(...)`, `Ia("deny",["file-write*"],...)`, `["file-write-unlink","file-write-create"]` | `denyRead` filters, `writeRoots`, protected write paths (`.rea/`, `.claude/`, `.git/hooks`, `.git/config`, `.mcp.json`, `~/.rea`) |
| Network: `(allow network*)` when no restriction, otherwise only localhost proxy ports (domain filtering happens in a local proxy) | `if(!y)H.push("(allow network*)");else{... (allow network-outbound (remote ip "localhost:*")) ...}` | `network: allow|deny`; deny keeps localhost and unix sockets, no proxy |
| Sandboxed Bash commands can be auto-approved | setting `autoAllowBashIfSandboxed` (name seen in settings schema) | `sandbox.autoAllow` (default true when the sandbox is on) |
| Linux uses bubblewrap/seccomp | `bwrap`/`bubblewrap`/`seccomp` strings (58 hits) | **not implemented** (macOS only) |

rea-original policy: deny rules `Read(...)`/`Edit(...)` are translated into kernel filters (subpath / regex), so they hold even for
`python -c` or a symlink; the sandbox never auto-approves in plan mode; an explanatory hint is appended to sandboxed failures.

Limits (stated): file tools (Read/Write/Edit/Glob/Grep) and MCP servers run in the rea process, not in the sandbox, and are governed by
permission rules only; `(allow default)` leaves process, IPC and mach services open, so this confines files and (optionally) network,
not everything; `sandbox-exec` is deprecated by Apple though still functional; no domain-level network filtering; a command can still
read anything not explicitly denied (as in the bundle: reads are allow-by-default).

## 20. "Port out" additions (v0.19): worktrees, structured output, ToolSearch, per-model windows
| Feature | Evidence | rea |
|---|---|---|
| EnterWorktree: "create an isolated git worktree and switch into it"; blocks Edit/Write in the main checkout until called; main-session only | tool `searchHint` string; `bgIsolation`/`"'worktree' (default) blocks Edit/Write in the main checkout until EnterWorktree is called"` (settings schema description) | `src/worktree.js`: real `git worktree add`, switches `rules.cwd` live, one level deep, main-session only |
| ExitWorktree: "exit a worktree session and return to the original directory" | tool `searchHint` string | restores `rules.cwd`, removes the worktree by default (`remove:false` keeps it) |
| `WorktreeCreate` hook gives `worktreePath` (absolute path to the created worktree); hook event list has `WorktreeCreate`/`WorktreeRemove` | `_0=p(()=>u({hookEventName:C("WorktreeCreate"),worktreePath:o()})...)` | both hooks fire with `{worktreePath, worktreeBranch}` |
| StructuredOutput tool: `searchHint:"return the final response as structured JSON"`, `description:"Return structured output in the requested format"`, prompt "Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response", `isReadOnly:!0`, `isConcurrencySafe:!0`, input schema is the caller-supplied schema itself | main bundle (harness area, `me()`/`Ea` tool definition) | `src/structured.js` + harness: a successful call ends the turn with `structuredOutput`; CLI's `--output-schema <file>` registers it; print mode prints the JSON |
| ToolSearch: "Fetches full schema definitions for deferred tools... Deferred tools appear by name in `<system-reminder>` messages... query forms: `select:<name>[,<name>...]`, free-text keyword search, `+slack send` (require the term in the name, rank by the rest)" | this session's own system-reminder text (live observed behaviour of Claude Code, the strongest evidence available) | `src/toolsearch.js` + harness: `deferred:true` tools are withheld from the tools array and named in a reminder; `ToolSearch` unlocks them for later turns in the same query |

Design choices that are mine, not from the bundle: worktree placement (`<repo>.worktrees/<branch>`, sibling to the repo, collision-numbered),
one-level-deep nesting restriction, `ExitWorktree`'s `remove` default, the `+term rest` scoring function, and that deferred-tool schemas
are withheld for the rest of the *process* tool list sent to the model (the bundle's actual gating mechanism for what counts as
"deferred" in the first place — e.g. a size threshold vs. an explicit per-tool flag — was not found in readable form).
Per-model context windows (`src/models.js`) are **entirely rea's own static table**, not read from the bundle; it will drift as
providers change limits and should be treated as a best-effort default, overridable with `--context-window`.

A real bug this round's tests caught (not a port-out item, a latent harness bug): the per-query tool-definition list was computed
once before the turn loop and reused for every turn in that `query()` call, so a tool unlocked by ToolSearch mid-query would not
actually appear in the next request's `tools` array until the *next* top-level `run()` call. Fixed by recomputing `#toolDefs()`
every turn; covered by `test/portout.test.js`.

## 21. LSP tool (v0.20): code intelligence
| Finding | Evidence | rea |
|---|---|---|
| Tool name "LSP", `searchHint:"code intelligence (definitions, references, symbols, hover)"` | tool `searchHint` string (metrics/reference.json coding_tools entry seen in this session's own tool-search listing) | `src/lsp.js`: `LSP` tool with `action: definition\|typeDefinition\|references\|hover\|documentSymbol` |
| Wire protocol (Content-Length framing, `initialize`/`initialized` handshake, `textDocument/didOpen`, `textDocument/publishDiagnostics`) | public Language Server Protocol specification, not the bundle (the bundle's own LSP client internals were not located) | `LspConnection`: real LSP wire client, independent of any specific server |

Everything else is rea's own design, not read from the bundle: the per-extension server registry (overridable via `--lsp-config`),
resolving a position from `line` + `symbol` text (rather than asking the model for an exact UTF-16 column, which it cannot reliably
produce), the diagnostics-capture-after-open behaviour, and the plain-text result formatting.

Verified live against two real language servers already installed on this machine (not just the mock fixture): `clangd` on a small
C program — correct `documentSymbol`, `definition` (including through a symlinked `/tmp`), `hover` (signature + parameters), and a
real compiler diagnostic surfaced verbatim ("Expected ';' at end of declaration"). `typescript-language-server`/`pylsp`/`gopls`/
`rust-analyzer` paths are implemented identically but only `rust-analyzer`'s binary was present and not separately live-tested
this round (clangd covers the same code path).

Two real bugs found live, not by the unit tests, and fixed:
1. **Server `env` was never forwarded** from the registry entry to the spawned process — any server-specific environment
   variable was silently dropped. (Caught by a mock-server test using `env` to switch its behaviour.)
2. **A model-supplied `character: 0` (a meaningless default) silently overrode a valid `symbol`.** Real models send both fields
   even when told only one is needed, and the harness picked the unchecked one. Fixed by preferring `symbol` whenever present —
   it is verified against the real line text, `character` is not. This is the more consequential bug: it would have made
   `definition`/`hover`/`references` silently fail (or worse, resolve to the wrong position) on realistic model output,
   and it only showed up once a live model was driving the tool, not from any unit test design that specified inputs by hand.

## 22. NotebookRead / NotebookEdit (v0.21)
| Finding | Evidence | rea |
|---|---|---|
| Tool names `NotebookRead`/`NotebookEdit`, `searchHint:"edit Jupyter notebook cells (.ipynb)"`, `ruleContentField:"notebook_path"` | tool definitions in the main bundle (`Kt({name:Zi,ruleContentField:"notebook_path",...})`, `Zi="NotebookEdit"`) | `src/notebook.js`: same two tool names, same `notebook_path` field |
| Input fields `cell_id`, `new_source`, `cell_type` ("current cell type... required if edit_mode=insert"), `edit_mode: replace\|insert\|delete` (defaults to replace) | zod schema fragment (`cjr=p(()=>u({new_source:o()...edit_mode:U(["replace","insert","delete"]).optional()...}))`) | identical field names and default |
| `cell_id ?? `cell-${index}`` fallback when a cell has no nbformat `id` | `y={...,cell_id:h}` where `h=e.id??`cell-${n}`` | `cellId(cell, index)` — exact same fallback pattern |
| `NotebookRead`/`NotebookEdit` are in `filePatternTools` (governed by path rules), and a `NotebookEdit`/`Write`/`MultiEdit` rule is explicitly *not* matched by file permission checks — only `Edit(path)` rules are; the product warns and suggests `Edit(path)` instead | `wUe.filePatternTools=[...,"NotebookRead","NotebookEdit",...]`; `r.toolName==="Write"\|\|r.toolName==="NotebookEdit"\|\|r.toolName==="MultiEdit"?"Edit":...` | `permissionAlias: 'Edit'`/`'Read'` on the two tools, consulted by `RuleSet#matchOne` — an `Edit(path)`/`Read(path)` rule governs the notebook tools directly (rea's own choice: make the alias work rather than warn that it doesn't) |
| Error wording: "Notebook file is not a valid Jupyter notebook", "Notebook file exceeds the maximum size this tool can read" | bundle string constants (`Sve`, `e7()`) | same wording, 10MB cap (cap value is rea's own) |

Not read from the bundle (own design): the plain-text rendering format for `NotebookRead`, the exact insert-position rule
("after `cell_id`, or at the start if omitted" — plausible from the schema but not directly evidenced), and that a source
edit does not clear `execution_count`/`outputs` unless the cell type changes (ordinary nbformat semantics, not bundle-specific).
`MultiEdit` (seen alongside NotebookEdit in the same tool-grouping arrays) was noticed but not built this round — it is a
batch-of-edits-to-one-file tool, functionally covered by calling `Edit` several times, so it was judged lower priority.

Live-verified on gpt-5.5: read a 2-cell notebook, correctly edited a code cell\'s source in place, correctly inserted a new
markdown cell after it with a fresh fallback id, and the written-back file was valid, reloadable JSON with the rest of the
notebook\'s metadata untouched.

## 23. /cd, /add-dir, /rename, /session, /config (v0.22)
Own design, not bundle-verified beyond the command *names* (which do appear as strings in the bundle: `"cd"`, `"add-dir"`,
`"rename"`, `"config"` all show up among the slash-command string table, consistent with the product having commands with
these names). The exact behavior, output format, and `/session` (vs. the product's richer session-management UI) are rea's
own implementation, built on infrastructure already in place:
- `/cd [dir]`: reassigns `rules.cwd`/`rules.root`, the same live-switch mechanism `EnterWorktree`/`ExitWorktree` already use
  (`src/worktree.js`), so Bash/Read/Edit/sandbox immediately follow the new directory — no new plumbing needed.
- `/add-dir [dir]`: pushes onto `rules.additionalDirectories` (already read by `isInWorkspace()` in `src/permissions.js`,
  previously only populated from `--add-dir`/settings at startup; this makes it mutable at runtime too).
- `/rename <title>`: calls the existing `store.meta('title', ...)` path already used internally on first user message.
- `/session`: prints the current session id, transcript file, and cwd — a read-only companion to `/resume` (which lists
  *other* saved sessions) and `/fork` (which branches the current one).
- `/config`: lists the three settings file paths from `settingsSources(cwd)` (exported from `src/hooks.js`, same table
  `loadSettings` already merges) plus the resolved `defaultMode`, `sandbox` config, and permission-rule count — a read-only
  summary; it does not support `/config set` (no settings editor was attempted).

## 24. Linux sandbox (bubblewrap) (v0.23)
Own design, not bundle-evidenced. §19 established that Claude Code's sandbox evidence in the bundle is Seatbelt-specific
(the strings and profile-building logic found are macOS-only); nothing in the bundle was found describing a Linux sandboxing
path, so this is rea's own companion implementation built to the same guarantee rather than a ported one:
- `buildBwrapArgs()` (`src/sandbox.js`) composes a `bwrap` argv instead of an SBPL profile: `--ro-bind / /` makes everything
  readable by default (matching Seatbelt's "read everything except denied paths"), each write root gets a `--bind` on top
  to make it read-write again, protected paths (`protectedWritePaths()`, shared with the Seatbelt path) and explicit
  `denyWrite` entries get a further `--ro-bind` to pull them back to read-only, and `denyRead` entries get a `--tmpfs`
  (directories) or a `--ro-bind /dev/null` (files) on top of everything — bubblewrap has no read-deny primitive, so this
  hides the content rather than merely blocking reads (stricter than Seatbelt's EPERM-on-read, not weaker).
- `--unshare-net` for network deny, `--die-with-parent`/`--unshare-pid` for cleanup, `--proc /proc --dev /dev --chdir <cwd>`
  for a usable process environment.
- `sandboxAvailable()`/`sandboxKind()` now dispatch on `process.platform`; `wrapShellCommand()` takes an optional `platform`
  override (defaults to `process.platform`) so the argv-construction logic is fully unit-testable from any host.
- Known gap carried over honestly: `denyRead` entries of `kind: 'regex'` (glob patterns from permission rules) are skipped —
  bubblewrap binds need concrete existing paths, so only literal/subpath deny-read rules are enforced on Linux; Seatbelt's
  regex deny-read has no equivalent here. Not live-tested against a real `bwrap` binary (this project's environment is
  macOS); `test/sandbox.test.js` covers argument construction and platform dispatch, with a real-execution test that
  self-skips when `bwrap` isn't present (mirrors how the Seatbelt tests self-skip off-macOS).

## 25. FileChanged, DirectoryAdded hooks (v0.24)
Payload shapes are bundle-evidenced; the file watcher that drives FileChanged is rea's own design (no watcher
implementation details were found in the bundle, only the hook's event schema and registration shape):
- `FileChanged`: `{hook_event_name:"FileChanged", file_path, event:["change","add","unlink"]}` (zod fragment `VK`), plus a
  registration-time `{hookEventName:"FileChanged", watchPaths: string[] optional}` (`c0`) - a scoping field rea does not
  implement (its watcher always covers the whole cwd tree; no `watchPaths` filter).
- `DirectoryAdded`: `{hook_event_name:"DirectoryAdded", directory: <absolute path>, source: "slash_command"|"register_repo_root"}`
  (zod fragment `jK`) - `"slash_command"` is literally for `/add-dir`, `"register_repo_root"` is an SDK `control_request`
  rea has no equivalent of (no SDK). A nearby string makes the firing rule explicit: "A directory that is already a
  registered working directory (including a duplicate of an earlier request) is denied with an error; the registration
  pipeline and DirectoryAdded hooks do not re-run" - i.e. it fires only for genuinely new runtime additions, never for
  `--add-dir`/settings directories already present at startup. rea's `/add-dir` (`src/cli.js`) matches this exactly: it
  checks `rules.additionalDirectories.includes(abs)` first and only pushes + fires the hook on a real addition.
- rea's own deviation, documented inline at the call site: `buildHooks`'s generic payload wrapper already uses a flat
  `event` key for the *hook name* (e.g. `"FileChanged"`); the bundle's literal field name for the file-change kind is
  also `event`, which would silently clobber the hook name on spread. rea passes it as `change` instead
  (`{file_path, change: 'add'|'change'|'unlink'}`), not `event`, to avoid the collision.
- `src/watch.js` (`createFileWatcher`): `fs.watch(root, {recursive: true})`, falling back to non-recursive watching when
  the platform doesn't support `recursive` (Linux); a snapshot of known paths disambiguates `fs.watch`'s ambiguous
  `'rename'` event into `add`/`unlink`. `.git/`, `node_modules/`, `.rea/` are ignored by default - the last one doubles as
  loop protection, since a FileChanged hook that logs to a file *inside* the watched tree would otherwise retrigger itself
  (a general file-watcher footgun, not something rea suppresses beyond the default ignore list; documented in README.md).
- Found and fixed along the way (not a Linux-sandbox issue this time): `loadSettings` (`src/hooks.js`) merged a settings
  file twice - once as `userSettings`, once as `projectSettings` - whenever `$HOME` equals the project `cwd` (unusual for
  a real user, but exactly what this project's own e2e test harness used to do by setting `HOME: cwd` for isolation),
  silently doubling every hook. Fixed with a `seen` file-path set in `loadSettings`; regression test in `test/hooks.test.js`.
- Found and fixed in a later round (v0.25): `test/watch.test.js` was occasionally flaky under the full suite's heavy
  concurrent load - the OS would, rarely, drop a single fs.watch notification outright rather than just deliver it late,
  so even a generous timeout didn't help. Fixed by having the poll helper periodically re-trigger the write/unlink it's
  waiting on, so a dropped notification gets a fresh chance instead of the test waiting out a dead signal.

## 26. MCP Elicitation / ElicitationResult hooks (v0.25)
Payload shapes are bundle-evidenced (zod fragments `OK`/`kK`); the protocol plumbing is MCP spec (`elicitation/create`
server->client request, `{message, requestedSchema}` -> `{action, content?}`), which the bundle's hook schema flattens:
- `Elicitation`: `{hook_event_name:"Elicitation", mcp_server_name, message, mode:["form","url"] (optional), url (optional),
  elicitation_id (optional), requested_schema (optional)}`, described as "Fired when an MCP server requests user input.
  Hooks can auto-respond (accept/decline) instead of showing the dialog."
- `ElicitationResult`: `{hook_event_name:"ElicitationResult", mcp_server_name, elicitation_id (optional), mode (optional),
  action:["accept","decline","cancel"], content (optional)}`, described as firing "after the user responds... Hooks can
  observe or override the response before it is sent to the server."
- `mode: "url"` (opening a browser, e.g. an OAuth-style flow) is in the bundle's schema but not implemented here - rea only
  does `mode: "form"` (the actual MCP-spec elicitation). Registration-time `watchPaths`-style scoping has no equivalent
  for these two events in the bundle text found, so none was added.
Own design, not bundle-evidenced:
- The exact field a hook uses to auto-respond/override. No string was found naming a dedicated field (e.g. an
  "elicitationDecision" counterpart to `permissionDecision`), so rea reuses its existing generic hook-output convention:
  `permission: "allow"|"deny"` maps to `accept`/`decline`, and `updatedInput` supplies the `content`. This keeps the same
  `normalizeHookOutput()` path every other hook already uses, rather than inventing a parallel field just for these two.
- `src/mcp.js`: `elicitation/create` is answered only over the stdio transport (`StdioRpc#serverRequest` already handles
  bidirectional server->client requests for `ping`/`roots/list`). The HTTP transport here is request/response only with
  no SSE listener for server-initiated pushes (an existing gap - EVIDENCE.md §12), so HTTP servers cannot elicit; this is
  a known, documented limitation rather than a silent one.
- `src/cli.js`'s `elicitDialog()`: the interactive terminal prompt (ask to provide input, then one line per schema
  property, required fields enforced) is rea's own UI - the bundle's evidence covers payload shapes, not dialog design.
  Non-interactive sessions (print mode, no tty) decline rather than hang, matching the existing pattern for permission
  prompts with no terminal to ask on.

## 27. Managed (policy) settings (v0.26)
Bundle evidence for the concept and precedence is extensive (`policy_settings`, `managedSettings`, `--managed-settings`
flag, `managed-settings.json`/`managed-settings.d`, fixed OS paths including `/Library/Application Support/ClaudeCode`
and `/etc/claude-code`, "it cannot be widened", "takes precedence over all three keys/this table", "first-wins ... the
SDK parent tier ... layers under this admin tier"); the full system behind it is enterprise MDM/remote-policy machinery
rea does not attempt to port:
- A remote/MDM delivery channel and a `policyHelper`/`policyHelpers` mechanism (an external script whose stdout becomes
  the managed settings, with `"replace"`/`"merge"` composition modes, retries, timeouts, refresh intervals).
- Admin-only fields found in the same area (`autoUpdate`, `modelPricing`, API-provider allowlists) - these configure
  product behavior rea doesn't have (its own update mechanism, its own pricing model), so there is nothing to gate.
- Windows/WSL-specific delivery (registry key, HKCU double opt-in, `--settings`/`--managed-settings` flag forwarding
  across the WSL/Windows boundary).
What rea implements (file-based, local-only): `--managed-settings <file>` (`src/cli.js`), or - if omitted - a fixed
default path read only if it exists: `defaultManagedSettingsPath()` in `src/hooks.js`. The bundle's literal OS paths are
product-specific (`ClaudeCode`/`claude-code`), so rea uses its own `.rea`-branded equivalent instead of reusing them:
`/Library/Application Support/rea/managed-settings.json` (macOS), `/etc/rea/managed-settings.json` (Linux), none on
other platforms. `loadSettings()` reads it *last*, so its `defaultMode`/`sandbox` config wins over every other source
(matching "takes precedence"), and its permission rules feed the same deny/ask/allow buckets every other source does -
which already gives "cannot be widened" for free, since a deny from any source always beats an allow from any other
regardless of read order (no extra enforcement code needed; this is just how `RuleSet` already worked). `/config` and
`settingsSources()` list it as a fourth source alongside user/project/local settings.

## 28. Multi-line input editor, theming (v0.27)
**Multi-line input.** The newline conventions are bundle-evidenced: the strings `"shift+enter"`, `"ctrl+j"`, and
`"backslash (\) + return to add newline"` appear together in the bundle's own help text, naming exactly the three
ways to add a newline instead of submitting. The editor itself (`src/editor.js`) is rea's own design:
- `parseKey()` turns raw stdin bytes into a structured key event - Enter is CR (`\r`), Ctrl+J is LF (`\n`); in raw
  mode these are genuinely different bytes, which is how the two can be told apart at all. `shift+enter` is only
  recognized when the terminal actually sends a distinguishable sequence for it (the Kitty keyboard protocol's
  `CSI 13;2u`) - this project never sends the protocol's own opt-in handshake, so on most terminals "shift+enter"
  degrades to a plain Enter (submits), same as any other terminal app that doesn't ask for that handshake either.
  Documented as a real, not silent, gap.
- `LineEditor` is a pure multi-line buffer + cursor (insert, backspace/delete across line boundaries, arrow
  navigation, home/end, kill-to-end/kill-line) with no terminal dependency at all, fully unit-tested
  (`test/editor.test.js`).
- The raw-mode wiring and screen redraw (`multilineAsk()` in `src/cli.js`) is opt-in via `--multiline` (default off)
  for exactly one reason: it cannot be automated-tested in this environment (no pty), and readline (used for every
  *other* prompt - permission dialogs, plan approval, questions) already manages stdin's raw mode and its own
  internal data listener for the session's whole life. Toggling raw mode a second time would fight readline;
  instead, readline's own `'data'` listener is detached while the editor is active and restored verbatim
  afterward, using only public `EventEmitter` APIs (no readline internals). Row-count math assumes one screen row
  per logical line (no soft-wrap awareness for very long single lines) and terminal resize isn't handled -
  acceptable, documented limits for a v1, not something this environment can verify further without a real pty.

**Theming.** Own design; no bundle evidence for specific color codes or a `dark`/`light`/`mono` naming scheme was
sought (out of scope - this is a visual-polish feature, not a loop/protocol behavior). `createStyle()`
(`src/ui.js`) now takes a theme name and keeps the same semantic role names (`red`/`green`/.../`gray`,
`bold`/`dim`/`italic`/`underline`) across all three presets, so no call site in `cli.js` had to change.
`--theme`, `REA_THEME`, and `{"ui":{"theme":...}}` in settings resolve in that precedence order.

## 29. Full-screen pinned input, mouse, live "/" and "@" suggestion dropdowns (v0.28)
Prompted by the user pointing out three screenshots of the real product's TUI mid-session: a pinned input box with
divider lines above/below it and a status footer; a live "/" command dropdown (filtered list + descriptions,
updating per keystroke); a live "@" file-mention picker (directory listing with a "+" marker). Own design
throughout - no bundle evidence was sought for exact rendering/layout (out of scope: this is a visual-polish
feature built from a screenshot of running behavior, not a protocol or loop semantic), except where noted:

- **Full-screen layout** (`--fullscreen`, `src/screen.js`): NOT the alternate-screen-buffer approach
  (`\x1b[?1049h`) the real product's Ink/React app almost certainly uses - that would require every one of the
  dozens of existing `stdout.write` call sites throughout the turn-handling code to go through a redraw-aware
  layer. Instead, a VT scrolling region (DECSTBM, `CSI r`) confines normal scrollback to the top rows and pins the
  last `footerRows` rows as a separately-drawn area - the technique vim/tmux use for a status line, applied to an
  input box. Deliberately scoped to be active only while idle at the main prompt, not during a running turn (which
  still prints normally into the full scroll area) - a documented limit, not a silent one.
- **Mouse** (click-to-position-cursor only): SGR extended mouse reporting (`CSI ?1000h` + `CSI ?1006h`), parsed in
  `parseMouseEvent()`. Only a left-click on the footer's actual input row repositions the cursor; everything else
  (scroll-wheel, right-click, other footer rows) is ignored rather than guessed. Scroll-wheel needs no handling at
  all - DECSTBM leaves the terminal's own scrollback and mouse-wheel behavior completely intact above the pinned
  region, which is part of why this approach was chosen over alternate-screen.
- **Live "/" dropdown** (`suggestSlashCommands`/`formatSlashSuggestions` in `src/ui.js`): a smaller, read-only
  version of what the screenshot showed - filters `SLASH_COMMANDS` (now the single source of truth `/help` also
  reads from, so the two can't drift) plus matching skills, updates every keystroke. No arrow-key selection within
  the dropdown; Tab accepts the top hit (reusing the same Tab-completion gesture, now dropdown-aware instead of
  just readline's own completer).
- **Live "@" file-mention dropdown** (`suggestFileMentions`/`formatFileMentions`): top-level working-directory
  entries only (gathered once per process), substring-filtered. Not recursive, no fuzzy ranking, no `.gitignore`
  awareness - a real, documented gap versus the live-indexed picker the screenshot showed, not a silent one.
- **Found and fixed via real pty testing, not just reasoning about it**: calling `rl.pause()` on a real TTY-backed
  `readline` interface (as the original multi-line-editor draft did, to stop it from double-processing keystrokes
  alongside the custom raw-mode reader) broke the underlying terminal for *all* further writes - not just within
  this feature, permanently, for the rest of the process. Confirmed by writing to the pty's master side from a
  Python test harness and observing immediate `EIO` only after `rl.pause()` had run, never before, and never when
  it was removed. Fixed by relying solely on detaching/reattaching readline's `'data'` listener (already the
  mechanism that matters), with `rl.pause()`/`rl.resume()` removed entirely.
- **Found and fixed via the same pty testing**: `footerCursorPosition()` and `mouseToEditorColumn()` initially
  disagreed about which footer row holds the actual input line whenever a header row (the top divider) sits above
  it - clicks landed one row off, silently rejected as "not the input row" rather than mapping to the wrong
  column, which is exactly why a passive code read alone did not catch it. Fixed by giving both functions an
  explicit shared `headerRows` parameter instead of one of them special-casing a `+1` inline at the call site.

## 30. --multiline/--fullscreen/--theme reach --backend claude-cli too (v0.29)
Found via the user's own report ("i type / or @ nth shows up") after v0.28 shipped: the live suggestion
dropdowns, mouse support and full-screen pinned input were built only into the default provider path's prompt
loop, never wired into `--backend claude-cli`'s separate (and simpler) REPL loop - an honest oversight, not a
bundle-evidence question (this entire area is rea's own design; see EVIDENCE.md §28/§29).
Fixed by extracting the raw-mode editor (previously inline inside `main()`) into a standalone `createMultilineAsk()`
factory function (`src/cli.js`, module scope), parameterized over everything that used to be a closure variable:
`cwd` (a getter, since `main()`'s `rules.cwd` can change via `/cd` but `--backend claude-cli`'s is fixed),
`ask`/`onInterrupt`/`style`/`rl`, and - importantly - `commands`: the live "/" dropdown must not offer the default
path's ~26 commands to a backend that only actually implements `/exit`/`/quit` (`runClaudeCli` relays Claude Code's
own loop; slash commands beyond those two are not rea's to answer here). `suggestSlashCommands()` (`src/ui.js`)
gained an optional `commands` parameter (defaulting to the shared `SLASH_COMMANDS` table) specifically so this
backend's dropdown could be scoped correctly without a second copy of the filtering logic.
Both call sites (`main()` and `mainClaudeCli()`) now share one implementation; verified via the same real-pty
method as §29, confirming `/ex` + Tab completes correctly and `/status` (a default-path-only command) correctly
does not appear in this backend's dropdown.

## 31. --fullscreen is now the default (v0.30)
At the user's request. `--no-fullscreen` opts back out to the plain scrollback prompt (what `--multiline` alone
still gives, without the pinned footer/mouse/dropdowns). Since `termMode` already gates all of this on a real TTY
(`stdin.isTTY`), defaulting `fullscreen: true` in `parseArgs()` changes nothing for any piped/non-interactive use
(print mode, tests, CI) - verified via a real pty both ways: a bare invocation with no flags now sets the VT
scroll region and enables mouse reporting; `--no-fullscreen` suppresses both.

## 32. --fullscreen reverted to opt-in; --multiline is the default instead (v0.31)
The default-on --fullscreen from §31 created a visible bug of its own: the scroll region and pinned footer were
set up lazily on the *first* prompt (inside multilineAsk), which is after the banner had already printed at the
top of a fresh, tall terminal - and the whole enable/disable cycle repeated on every turn rather than once per
session. The result was a large, growing blank gap between the banner and the pinned input box, worse in taller
terminal windows. At the user's request (and before attempting the real fix - properly hoisting the scroll-region
setup to session start with the cursor anchored at the bottom row, done once, not per turn - was worth the extra
risk for a cosmetic feature): `--fullscreen` is opt-in again, `--multiline` (the simpler, more-tested path - no
scroll region, no mouse, no lazy/cyclical state) is on by default instead. `--no-multiline`/`--no-fullscreen` are
both available to opt out of either. The underlying --fullscreen bug is not yet fixed, just no longer defaulted on.
