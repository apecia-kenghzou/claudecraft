#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json`: records argv/stdin, emits a scripted JSONL trace.
import { appendFileSync } from 'node:fs';
let prompt = '';
process.stdin.on('data', (b) => { prompt += b; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ argv: process.argv.slice(2), prompt })}\n`);
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (process.env.FAKE_CLAUDE_MODE === 'crash') { process.stderr.write('boom'); process.exit(3); }
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake', tools: ['Read', 'Bash'] });
  process.stdout.write('not json noise\n');
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'a.txt' } }], usage: { output_tokens: 5 } } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: '1\thello', is_error: false }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `Answer to: ${prompt.trim()}` }] } });
  if (process.env.FAKE_CLAUDE_MODE === 'error') out({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '', num_turns: 9 });
  else out({ type: 'result', subtype: 'success', is_error: false, result: `Answer to: ${prompt.trim()}`, num_turns: 2, total_cost_usd: 0.0123, duration_ms: 42, session_id: 's1', usage: { output_tokens: 9 } });
});
