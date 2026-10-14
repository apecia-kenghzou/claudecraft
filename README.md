<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node >= 18">
  <img src="https://img.shields.io/badge/dependencies-zero-success?style=flat-square" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-informational?style=flat-square" alt="macOS and Linux">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license">
  <img src="https://img.shields.io/badge/status-experimental-blue?style=flat-square" alt="Experimental">
</p>

<h1 align="center">ClaudeCraft</h1>
<p align="center"><b>An independent, open-source coding agent CLI, built by reverse-engineering how Claude Code behaves.</b></p>
<p align="center"><i>Zero runtime dependencies. Works with Anthropic's API or any OpenAI-compatible endpoint.</i></p>

> [!NOTE]
> ClaudeCraft is an independent clean-room re-implementation, not a fork. It is built from *observed behavior* of the
> `@anthropic-ai/claude-code` CLI (tool names, hook payloads, permission rules, loop semantics) — never from its source
> code or any copied strings/prompts. It is not affiliated with, endorsed by, or associated with Anthropic. See
> [EVIDENCE.md](EVIDENCE.md) for exactly what was observed vs. what is ClaudeCraft's own design.

[What's ported](#whats-ported-and-whats-not) · [Quick start](#quick-start) · [Architecture](#architecture) ·
[Features](#features) · [Permissions and sandbox](#permissions-and-sandbox) · [Tests](#tests) · [Docs](#project-docs)

## Why

Claude Code is closed source. ClaudeCraft exists to answer, concretely and testably, "what does an agentic coding CLI
actually need to do under the hood?" — the tool-call loop, permission rules, sandboxing, context compaction, sessions,
MCP, hooks — rebuilt from scratch, with a test for every behavior and a document tracking what's verified vs. guessed.

## What's ported, and what's not

Coverage below is generated from the source (`node scripts/metrics.mjs` → [METRICS.md](METRICS.md)), not hand-counted.

| Area | Coverage | Notes |
|---|---|---|
| Tools (Read, Edit, Bash, Grep, Agent, MCP, LSP, Notebooks, Worktrees, …) | 26 / 36 (72%) | core file/shell/search tools are L3 (built + tested) |
| Hook events | 28 / 33 (85%) | PreToolUse → permission ordering, FileChanged/DirectoryAdded, MCP Elicitation |
| Permission modes | 5 / 6 (83%) | missing: `auto` (classifier-gated; no reference implementation to port) |
| Settings sources | 6 / 8 (75%) | user/project/local/managed settings; missing: remote/MDM delivery |
| Slash commands | 25 / 92 (27%) | the ~65 missing are mostly IDE-integration-only, not relevant to a plain CLI |
| Loop terminal reasons / transitions | 15/17, 6/7 | the state machine that decides when a turn ends |
| Model-layer features | 11 / 13 (85%) | streaming, retries, prompt caching, model fallback; missing: extended thinking resume, media limits |
| Built-in agent types | 3 / 4 (75%) | `general-purpose`, `Explore`, `Plan` |

**Fully built and tested (L3 — re-implemented, not just identified):** the tool-call loop, permission engine (rule
grammar + Bash argument analysis), context compaction, sessions/resume/fork, subagents, MCP client (stdio + HTTP),
memory/skills, plan mode, the terminal UI, git worktree isolation, structured output, a real LSP client, Jupyter
notebook editing, and an OS sandbox (macOS Seatbelt + a Linux bubblewrap companion).

**Deliberately not ported** (documented, not silently skipped — see EVIDENCE.md for why each one):
- **`auto` permission mode** — described in the bundle as classifier-gated, but no reference classifier exists to port;
  building one means inventing the policy, not reverse-engineering it.
- **Enterprise policy delivery** — remote/MDM settings push, `policyHelper` scripts, admin-only fields
  (`autoUpdate`, `modelPricing`, provider allowlists). ClaudeCraft supports local managed-settings files only.
- **OAuth login to Anthropic's own consumer subscription** — intentionally refused; that flow is scoped to
  Anthropic's official client, and porting it means impersonating Claude Code to bypass that restriction.
- **MCP OAuth, SSE/WebSocket transports, prompts** · **Plugins** · **Extended-thinking resume** · **Windows**.

## Quick start

Not published to npm yet — run it from a clone:

```sh
git clone https://github.com/apecia-kenghzou/claudecraft.git
cd claudecraft && npm link      # installs the `claudecraft` command locally (or just: node bin/claudecraft.js)
```

```sh
# with Anthropic's API
export ANTHROPIC_API_KEY=sk-ant-...
claudecraft                                   # interactive
claudecraft -p "list the TODOs in src/"       # one-shot

# or with any OpenAI-compatible endpoint (local model server, proxy, etc.)
export OPENAI_API_KEY=...
claudecraft --provider openai --base-url http://localhost:8080/v1 --model your-model
```

## Architecture

```
  CLI (bin/claudecraft.js)
    │
    ├─ Harness ── the agent loop: model call → tool calls → permission check → hooks → compact?
    │     │
    │     ├─ Model layer ─── Anthropic Messages API  │  any OpenAI-compatible chat.completions endpoint
    │     ├─ Tool executor ─ concurrency-safe batching, one unsafe tool = a barrier
    │     └─ Context ─────── thresholds, levels, micro-compaction, file re-attachment
    │
    ├─ Permissions ── rule grammar (Tool / Tool(pattern)) + a real Bash command-safety parser
    ├─ Sandbox ────── macOS Seatbelt (sandbox-exec) or Linux bubblewrap, same guarantee either way
    ├─ MCP client ──── stdio + HTTP servers, tool/resource discovery, elicitation
    └─ Sessions ────── JSONL transcript, resume, fork, compaction-safe repair
```

## Features

- **Dual model backends** — Anthropic Messages API or any OpenAI-compatible endpoint, both streaming, with retry/backoff
  and automatic fallback.
- **Real permission engine** — `Tool(pattern)` rules, deny > ask > allow precedence, and a Bash *argument* analyzer
  (not just a regex) that understands redirects, chained commands, and symlinks.
- **OS-level sandboxing** — macOS Seatbelt or Linux bubblewrap confine what Bash can write to and read, kernel-enforced,
  not just policy.
- **Context compaction** that survives repeated compactions without losing the original task or re-attaching the wrong
  files.
- **MCP client** — stdio and HTTP servers, resource tools, and user-input elicitation mid-call.
- **Terminal UI** — 3 color themes (`--theme dark|light|mono`) and an opt-in (`--multiline`) multi-line input editor
  (arrow keys move within the input across lines; Enter submits, `ctrl+j`/a trailing `\` add a newline instead).
  Experimental — not verified against every terminal, hence opt-in.
- **Git worktree isolation, structured output, lazy (deferred) tool loading, a real LSP client, Jupyter notebook
  editing, hooks (including a real file watcher and MCP elicitation)** — flag-level detail for every feature is in
  [ARCHITECTURE.md](ARCHITECTURE.md) (what's built, per subsystem) and [EVIDENCE.md](EVIDENCE.md) (exactly how).

## Permissions and sandbox

Rules are `Tool` or `Tool(pattern)`, loaded from `~/.rea/settings.json`, `.rea/settings.json`,
`.rea/settings.local.json`, `--allowedTools`/`--disallowedTools`, and an optional `--managed-settings` file that always
wins. Precedence is deny → ask → allow, regardless of which source a rule came from — a managed-settings deny can
never be widened by an allow anywhere else.

```json
{ "permissions": {
    "allow": ["Bash(git status:*)", "Bash(npm run *)", "Read(./src/**)"],
    "deny":  ["Read(.env)", "Bash(rm:*)"],
    "defaultMode": "acceptEdits" } }
```

`--sandbox` runs Bash commands kernel-confined (write-only under the working directory and temp dirs; protected paths
read-only) instead of merely asking permission for each one.

## Tests

```sh
npm test
```

267 tests across 27 files, `node --test`, zero network calls and zero mocked-away behavior where a real one
(a real git repo, a real MCP server, a real language server, a real sandbox) could be exercised instead.

## Project docs

- **[EVIDENCE.md](EVIDENCE.md)** — for every feature, what was directly observed in the real binary vs. ClaudeCraft's own design.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the subsystem-by-subsystem build log and what's left.
- **[METRICS.md](METRICS.md)** — the coverage numbers above, regenerated from source, never hand-edited.

## License and credits

MIT. ClaudeCraft is an independent project with no affiliation to Anthropic. "Claude" and "Claude Code" are trademarks
of Anthropic, referenced here only to describe what this project reverse-engineers and re-implements.
