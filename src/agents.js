// Subagents: definitions (built-in + user files), and the `Agent` tool that runs one as an isolated child loop.
// Structure follows what the bundle does (EVIDENCE.md §10): a definition has agentType / whenToUse / tools or
// disallowedTools / model; read-only types for exploration and planning; the parent receives only the child's
// final text plus an agentId and usage footer. Prompts and code here are original.
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from './harness.js';
import { parseFrontmatter, toList } from './frontmatter.js';
import { SessionStore } from './session.js';
import { usageTokens } from './context.js';
import { MAIN_SESSION_ONLY } from './plan.js';
import { WORKTREE_MAIN_SESSION_ONLY } from './worktree.js';

export const AGENT_TOOL_NAME = 'Agent';
const READ_ONLY_DENY = ['Write', 'Edit', 'NotebookEdit', AGENT_TOOL_NAME];

const REPORT_RULES = `When you finish, your final message is the only thing the requester will see: make it a complete, concise report.
Lead with the answer. Cite files as path:line. Do not narrate your process.`;

export const BUILT_IN_AGENTS = [
  {
    agentType: 'general-purpose',
    whenToUse: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Use it when a search may take several rounds or a subtask is independent of the main conversation.',
    tools: ['*'], disallowedTools: [AGENT_TOOL_NAME], source: 'built-in', permissionMode: undefined,
    systemPrompt: ({ cwd }) => `You are a sub-agent of a terminal coding assistant. You were given one self-contained task; complete it fully using your tools, then report.
Search broadly when unsure where something lives; check several locations and naming conventions before concluding something does not exist.
Prefer editing existing files to creating new ones. Do not create documentation files unless asked.
${REPORT_RULES}\nWorking directory: ${cwd}`,
  },
  {
    agentType: 'Explore',
    whenToUse: 'Fast read-only agent for exploring a codebase: finding files by pattern, searching code for keywords, answering "how does X work". State the desired thoroughness: "quick", "medium" or "very thorough".',
    tools: ['Read', 'Glob', 'Grep', 'Bash'], disallowedTools: READ_ONLY_DENY, source: 'built-in', permissionMode: 'plan', maxTurns: 20, omitMemory: true,
    systemPrompt: ({ cwd }) => `You are a read-only code exploration agent. You cannot and must not modify anything: no file edits or creation, no commands that change state.
Use Glob to find files by name, Grep to search contents, Read to inspect files. Use Bash only for read-only commands such as ls or git log.
Be fast: issue independent searches in the same turn. Match your effort to the thoroughness the requester asked for.
${REPORT_RULES}\nWorking directory: ${cwd}`,
  },
  {
    agentType: 'Plan',
    whenToUse: 'Read-only planning agent. Give it requirements; it explores the code and returns a step-by-step implementation plan, the critical files, and trade-offs.',
    tools: ['Read', 'Glob', 'Grep', 'Bash'], disallowedTools: READ_ONLY_DENY, source: 'built-in', permissionMode: 'plan', maxTurns: 20, omitMemory: true,
    systemPrompt: ({ cwd }) => `You are a software architect agent. Explore the codebase read-only, then design an implementation plan. You cannot modify anything.
Return: (1) the approach and why, (2) ordered concrete steps, (3) the files that will change and the key existing code to reuse, (4) risks and open questions.
${REPORT_RULES}\nWorking directory: ${cwd}`,
  },
];

// ---- user-defined agents (markdown with frontmatter) ------------------------------------------------------
export function parseAgentFile(text, file = '') {
  const fm = parseFrontmatter(text);
  if (!fm) throw new Error(`${file}: missing --- frontmatter ---`);
  const d = fm.data;
  const name = d.name ?? path.basename(file, '.md');
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new Error(`${file}: invalid agent name "${name}"`);
  if (!d.description) throw new Error(`${file}: "description" is required`);
  return {
    agentType: name, whenToUse: d.description, tools: toList(d.tools) ?? ['*'],
    disallowedTools: [...new Set([...(toList(d.disallowedTools) ?? []), AGENT_TOOL_NAME])],
    model: d.model || 'inherit', maxTurns: d.maxTurns ? Number(d.maxTurns) : undefined,
    permissionMode: d.permissionMode || undefined, omitMemory: /^(true|yes)$/i.test(d.omitMemory ?? ''),
    source: file, systemPrompt: () => fm.body.trim(),
  };
}

/** Built-ins, then user (~/.rea/agents), then project (.rea/agents): later sources override earlier ones by name. */
export function loadAgents(cwd, { home = os.homedir(), warn = () => {} } = {}) {
  const byName = new Map(BUILT_IN_AGENTS.map((a) => [a.agentType, a]));
  for (const dir of [path.join(home, '.rea', 'agents'), path.join(cwd, '.rea', 'agents')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      try { const a = parseAgentFile(readFileSync(path.join(dir, f), 'utf8'), path.join(dir, f)); byName.set(a.agentType, a); }
      catch (e) { warn(`skipping agent file: ${e.message}`); }
    }
  }
  return [...byName.values()];
}

/** The tool set a child may use. Never includes the Agent tool (no nesting). */
export function filterTools(allTools, def) {
  const allowAll = def.tools.includes('*');
  return allTools.filter((t) => t.name !== AGENT_TOOL_NAME && !MAIN_SESSION_ONLY.includes(t.name) && !WORKTREE_MAIN_SESSION_ONLY.includes(t.name)
    && (allowAll || def.tools.includes(t.name))
    && !(def.disallowedTools ?? []).includes(t.name));
}

// ---- the Agent tool ---------------------------------------------------------------------------------------
/**
 * @param {object} o
 * @param {()=>import('./harness.js').Harness} o.getParent  the harness that owns this tool (lazy: tool is registered in it)
 * @param {object[]} o.definitions
 * @param {(e:object)=>void} [o.onEvent]  receives { type:'subagent_event', agentId, agentType, event }
 */
export function createAgentTool({ getParent, definitions, onEvent, cwd = process.cwd(), home = os.homedir() }) {
  const byType = new Map(definitions.map((d) => [d.agentType, d]));
  const catalog = definitions.map((d) => `- ${d.agentType}: ${d.whenToUse} (tools: ${d.tools.join(', ')}${d.disallowedTools?.length ? `; not: ${d.disallowedTools.filter((x) => x !== AGENT_TOOL_NAME).join(', ') || 'n/a'}` : ''})`).join('\n');

  return defineTool({
    name: AGENT_TOOL_NAME,
    description: `Launch a sub-agent to handle a task in an isolated context. The agent starts with no memory of this conversation, so the prompt must contain everything it needs.
Its final message is returned to you; the user does not see it. Launch several agents in one turn to run them in parallel. Do not use it for a single file read or a one-shot search.
Available agent types:
${catalog}`,
    inputSchema: {
      type: 'object', required: ['description', 'prompt'],
      properties: {
        description: { type: 'string' }, prompt: { type: 'string' }, subagent_type: { type: 'string' },
        run_in_background: { type: 'boolean' },
      },
    },
    isReadOnly: () => true,          // launching is not itself a mutation; the child's tools go through permissions
    isConcurrencySafe: () => true,
    validateInput: ({ subagent_type, run_in_background }) => {
      if (subagent_type && !byType.has(subagent_type)) {
        return { ok: false, message: `Unknown agent type "${subagent_type}". Available: ${[...byType.keys()].join(', ')}` };
      }
      if (run_in_background) return { ok: false, message: 'run_in_background is not supported yet; run the agent in the foreground.' };
      return { ok: true };
    },
    async call({ description, prompt, subagent_type = 'general-purpose' }, ctx, signal) {
      const parent = getParent();
      const def = byType.get(subagent_type);
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      const started = Date.now();
      const tools = filterTools([...parent.tools.values()], def);
      const sessionId = parent.store?.sessionId;
      let store;
      if (parent.store) {
        const dir = path.join(parent.store.dir, sessionId, 'subagents');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        store = new SessionStore({ cwd, home, sessionId: agentId, dir });
      }
      const hooks = { ...parent.hooks, Stop: parent.hooks.SubagentStop ?? [] };   // a child ends with SubagentStop, not Stop
      const stats = { toolUses: 0, tokens: 0 };
      const child = parent.fork({
        tools, system: def.systemPrompt({ cwd: parent.rules.cwd }), memory: def.omitMemory ? '' : parent.memory, permissionMode: def.permissionMode ?? parent.permissionMode,
        maxTurns: def.maxTurns ?? 25, store, signal, hooks,
        onEvent: (e) => {
          if (e.type === 'assistant') { stats.tokens += usageTokens(e.usage); stats.toolUses += e.content.filter((b) => b.type === 'tool_use').length; }
          onEvent?.({ type: 'subagent_event', agentId, agentType: def.agentType, description, event: e });
        },
      });
      await parent.emitHook('SubagentStart', { agentId, agentType: def.agentType, description, prompt });
      let r;
      try { r = await child.run(prompt, { agentId }); } finally { store?.sync(child.messages); }
      await parent.emitHook('SubagentStop', { agentId, agentType: def.agentType, reason: r?.reason, text: r?.text });

      if (r.reason === 'model_error' || r.reason === 'prompt_too_long') throw new Error(`sub-agent failed: ${r.error?.message ?? r.reason}`);
      if (r.reason === 'aborted_streaming' || r.reason === 'aborted_tools') throw new Error('sub-agent was interrupted');
      let text = r.text.trim() || '(Subagent completed but returned no output.)';
      if (r.reason === 'max_turns') text += `\n\n[The sub-agent stopped after ${r.turns} turns (its limit); the report above may be incomplete.]`;
      if (r.reason === 'blocking_limit' || r.reason === 'rapid_refill_breaker') text += `\n\n[The sub-agent stopped early: ${r.reason}.]`;
      return `${text}\n\nagentId: ${agentId}\n<usage>subagent_tokens: ${stats.tokens} tool_uses: ${stats.toolUses} duration_ms: ${Date.now() - started}</usage>`;
    },
  });
}
