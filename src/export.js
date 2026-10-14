// Render a conversation as Markdown (for /export). Tool results are clipped; thinking blocks are omitted.
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more characters]` : s);
const toText = (c) => (typeof c === 'string' ? c : (c ?? []).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n'));

export function renderTranscript(messages, { title = 'rea session', model, cwd, sessionId } = {}) {
  const out = [`# ${title}`, ''];
  const meta = [model && `model: ${model}`, cwd && `cwd: ${cwd}`, sessionId && `session: ${sessionId}`].filter(Boolean);
  if (meta.length) out.push(meta.map((m) => `- ${m}`).join('\n'), '');
  for (const m of messages) {
    if (m.synthetic) continue;
    if (typeof m.content === 'string') {
      out.push(m.isCompactSummary ? '## Summary of earlier conversation' : `## ${m.role === 'user' ? 'User' : 'Assistant'}`, '', m.content, '');
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) parts.push(b.text);
        if (b.type === 'tool_use') parts.push(`**Tool call:** \`${b.name}\`\n\n\`\`\`json\n${clip(JSON.stringify(b.input, null, 2), 1500)}\n\`\`\``);
      }
      if (parts.length) out.push('## Assistant', '', parts.join('\n\n'), '');
    } else {
      const results = m.content.filter((b) => b.type === 'tool_result');
      for (const r of results) out.push(`**Tool result${r.is_error ? ' (error)' : ''}:**`, '', '```', clip(toText(r.content), 1500), '```', '');
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text.trim()) out.push('## User', '', text, '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}
