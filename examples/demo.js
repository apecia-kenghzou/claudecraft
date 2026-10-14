// Offline demo: a scripted "model" drives the real harness + search tools against this repo.
import { Harness, defaultTools } from '../src/index.js';

const script = [
  { content: [
    { type: 'tool_use', id: '1', name: 'Glob', input: { pattern: 'src/*.js' } },
    { type: 'tool_use', id: '2', name: 'Grep', input: { pattern: 'class \\w+', output_mode: 'content', glob: '*.js' } },
  ] },
  { content: [{ type: 'text', text: 'Found the harness source; see tool results above.' }] },
];
let i = 0;
const h = new Harness({
  model: async () => script[i++],
  tools: defaultTools(),
  permissionMode: 'default', // search tools are read-only, so no prompts
  hooks: { PreToolUse: [({ tool, input }) => { console.log('hook PreToolUse', tool, JSON.stringify(input)); }] },
});
const r = await h.run('where is the harness defined?');
for (const m of r.messages) console.log(JSON.stringify(m, null, 1).slice(0, 700));
