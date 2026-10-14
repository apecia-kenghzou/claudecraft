// ToolSearch: lazy loading for tool schemas. A tool created with `deferred: true` is left out of the schemas sent to the
// model; only its name appears in a system-reminder (see Harness#systemPrompt). The model calls ToolSearch to "unlock" it
// (its full schema is then sent on later requests) and gets the schema back immediately as text so it can call it right away.
// Query forms and wording follow this project's own observed behaviour (EVIDENCE.md §20): `select:<name>[,<name>...]` for
// exact names, `+term rest...` to require `term` in the name and rank by the rest, or plain keyword search.
import { defineTool } from './harness.js';

function schemaOf(t) {
  return JSON.stringify({ description: t.description, name: t.name, parameters: t.inputSchema });
}

function scoreKeyword(words, tool) {
  const hay = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
  return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
}

/** Pure matcher so it can be tested without a harness. `deferredTools` is the list of currently-locked tool objects. */
export function matchDeferredTools(query, deferredTools, { maxResults = 5 } = {}) {
  const q = query.trim();
  const select = /^select:(.+)$/.exec(q);
  if (select) {
    const wanted = select[1].split(',').map((s) => s.trim()).filter(Boolean);
    return wanted.map((name) => deferredTools.find((t) => t.name === name)).filter(Boolean);
  }
  const plus = /^\+(\S+)\s*(.*)$/.exec(q);
  if (plus) {
    const [, required, rest] = plus;
    const words = rest.toLowerCase().split(/\s+/).filter(Boolean);
    return deferredTools
      .filter((t) => t.name.toLowerCase().includes(required.toLowerCase()))
      .map((t) => ({ t, s: scoreKeyword(words, t) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, maxResults)
      .map((x) => x.t);
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return deferredTools
    .map((t) => ({ t, s: scoreKeyword(words, t) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, maxResults)
    .map((x) => x.t);
}

export function createToolSearchTool({ getHarness }) {
  return defineTool({
    name: 'ToolSearch',
    description: 'Fetches full schema definitions for deferred tools so they can be called.\n'
      + 'Deferred tools appear by name in a system reminder. Until fetched, only the name is known — there is no parameter '
      + 'schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and '
      + 'returns the matched tools\' complete schema definitions.\n\n'
      + 'Query forms:\n- "select:Read,Edit" — fetch these exact tools by name\n- "notebook jupyter" — keyword search\n'
      + '- "+slack send" — require "slack" in the name, rank by remaining terms',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, max_results: { type: 'number' } } },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: ({ query, max_results = 5 }) => {
      const h = getHarness();
      const locked = [...h.tools.values()].filter((t) => t.deferred && !h.unlockedDeferred.has(t.name));
      const hits = matchDeferredTools(query, locked, { maxResults: max_results });
      if (!hits.length) {
        return locked.length
          ? `No deferred tool matched "${query}". Available: ${locked.map((t) => t.name).join(', ')}`
          : 'No deferred tools are pending.';
      }
      for (const t of hits) h.unlockedDeferred.add(t.name);
      return `<functions>\n${hits.map((t) => `<function>${schemaOf(t)}</function>`).join('\n')}\n</functions>`;
    },
  });
}
