// Skills: reusable prompts in `<name>/SKILL.md` (or plain command files), invocable by the model through the
// `Skill` tool and by the user as `/name args`. Frontmatter keys follow the bundle (EVIDENCE.md §11):
// name, description, allowed-tools, disallowed-tools, argument-hint, disable-model-invocation, user-invocable, model.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter, toBool, toList } from './frontmatter.js';
import { defineTool } from './harness.js';

export const SKILL_TOOL_NAME = 'Skill';
export const MAX_SKILL_BYTES = 256 * 1024;
const sanitize = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '-');

export function parseSkill(text, file, fallbackName) {
  const fm = parseFrontmatter(text);
  const data = fm?.data ?? {};
  const body = (fm?.body ?? text).trim();
  if (!body) throw new Error(`${file}: empty skill`);
  const name = sanitize(String(data.name || fallbackName).trim());
  if (!name) throw new Error(`${file}: skill has no name`);
  const firstLine = body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim().slice(0, 120);
  return {
    name, description: data.description || firstLine || '(no description)', content: body,
    baseDir: path.dirname(file), file,
    allowedTools: toList(data['allowed-tools']) ?? [], disallowedTools: toList(data['disallowed-tools']) ?? [],
    argumentHint: data['argument-hint'], model: data.model,
    disableModelInvocation: toBool(data['disable-model-invocation']), userInvocable: toBool(data['user-invocable'], true),
  };
}

/** user dirs first, then project dirs; later definitions override earlier ones by name. */
export function loadSkills(cwd, { home = os.homedir(), warn = () => {} } = {}) {
  const byName = new Map();
  const roots = [
    ['skills', path.join(home, '.rea', 'skills')], ['commands', path.join(home, '.rea', 'commands')],
    ['skills', path.join(home, '.claude', 'skills')], ['commands', path.join(home, '.claude', 'commands')],
    ['skills', path.join(cwd, '.rea', 'skills')], ['commands', path.join(cwd, '.rea', 'commands')],
    ['skills', path.join(cwd, '.claude', 'skills')], ['commands', path.join(cwd, '.claude', 'commands')],
  ];
  const take = (file, fallback, source) => {
    try {
      if (statSync(file).size > MAX_SKILL_BYTES) { warn(`skipping ${file}: larger than ${MAX_SKILL_BYTES} bytes`); return; }
      const s = parseSkill(readFileSync(file, 'utf8'), file, fallback);
      byName.set(s.name, { ...s, source });
    } catch (e) { warn(`skipping skill: ${e.message}`); }
  };
  for (const [kind, dir] of roots) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (kind === 'skills' && e.isDirectory()) {
        const f = path.join(dir, e.name, 'SKILL.md');
        if (existsSync(f)) take(f, e.name, dir);
      } else if (kind === 'commands' && e.isFile() && e.name.endsWith('.md')) take(path.join(dir, e.name), e.name.slice(0, -3), dir);
    }
  }
  return [...byName.values()];
}

/** `$ARGUMENTS` is replaced; if the skill has no placeholder, arguments are appended. */
export function expandSkill(skill, args = '') {
  const a = args.trim();
  if (skill.content.includes('$ARGUMENTS')) return skill.content.replaceAll('$ARGUMENTS', a);
  return a ? `${skill.content}\n\nARGUMENTS: ${a}` : skill.content;
}

export function createSkillTool({ skills, addAllowRule }) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const invocable = skills.filter((s) => !s.disableModelInvocation);
  return defineTool({
    name: SKILL_TOOL_NAME,
    description: `Load a skill: a stored procedure the user has set up for a kind of task. Call it when the user's request matches a skill, then follow the returned instructions.
Available skills:
${invocable.length ? invocable.map((s) => `- ${s.name}: ${s.description}${s.argumentHint ? ` (args: ${s.argumentHint})` : ''}`).join('\n') : '(none)'}`,
    inputSchema: { type: 'object', required: ['skill'], properties: { skill: { type: 'string' }, args: { type: 'string' } } },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionContent: ({ skill }) => ({ kind: 'string', value: skill }),
    validateInput: ({ skill }) => {
      const s = byName.get(skill.replace(/^\//, ''));
      if (!s) return { ok: false, message: `Unknown skill "${skill}". Available: ${invocable.map((x) => x.name).join(', ') || '(none)'}` };
      if (s.disableModelInvocation) return { ok: false, message: `Skill "${s.name}" can only be invoked by the user (/${s.name}).` };
      return { ok: true };
    },
    call: ({ skill, args = '' }) => {
      const s = byName.get(skill.replace(/^\//, ''));
      for (const rule of s.allowedTools) { try { addAllowRule(rule, `skill:${s.name}`); } catch { /* ignore malformed */ } }
      return `Skill "${s.name}" loaded (from ${s.file}). Follow these instructions; relative paths resolve against ${s.baseDir}.\n\n${expandSkill(s, args)}`;
    },
  });
}
