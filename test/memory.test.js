import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverMemory, renderMemory, stripComments, findImports } from '../src/memory.js';
import { parseFrontmatter, toList, toBool } from '../src/frontmatter.js';
import { parseSkill, loadSkills, expandSkill, createSkillTool } from '../src/skills.js';
import { Harness } from '../src/harness.js';
import { RuleSet } from '../src/permissions.js';
import { createAgentTool, BUILT_IN_AGENTS } from '../src/agents.js';
import { defineTool } from '../src/harness.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'rea-mem-'));
const put = (f, c) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, c); };

test('frontmatter: scalars, comma lists, dash lists, quotes, no frontmatter', () => {
  const r = parseFrontmatter('---\nname: "x"\ntools: Read, Grep\nallowed-tools:\n  - Bash(git:*)\n  - Read\nflag: true\n---\nbody here');
  assert.equal(r.data.name, 'x');
  assert.deepEqual(toList(r.data.tools), ['Read', 'Grep']);
  assert.deepEqual(r.data['allowed-tools'], ['Bash(git:*)', 'Read']);
  assert.equal(toBool(r.data.flag), true);
  assert.equal(r.body, 'body here');
  assert.equal(parseFrontmatter('plain'), null);
});

test('stripComments keeps fenced code; findImports ignores emails, inline code and fences', () => {
  assert.equal(stripComments('a <!-- hidden --> b\n```\n<!-- keep -->\n```').includes('hidden'), false);
  assert.ok(stripComments('```\n<!-- keep -->\n```').includes('<!-- keep -->'));
  const t = 'See @docs/style.md and `@no/code.md` mail me@example.com\n```\n@in/fence.md\n```\n(@./rel.md)';
  assert.deepEqual(findImports(t), ['docs/style.md', './rel.md']);
});

test('discoverMemory: user, ancestors outermost-first, local files, AGENTS/CLAUDE compat, rules', () => {
  const home = tmp(), root = tmp();
  const proj = path.join(root, 'app'), sub = path.join(proj, 'pkg');
  put(path.join(home, '.rea', 'REA.md'), 'USER RULES');
  put(path.join(root, 'REA.md'), 'ROOT');
  put(path.join(proj, 'REA.md'), 'PROJECT');
  put(path.join(proj, 'REA.local.md'), 'LOCAL');
  put(path.join(proj, 'CLAUDE.md'), 'CLAUDE COMPAT');
  put(path.join(sub, 'AGENTS.md'), 'SUB AGENTS');
  put(path.join(proj, '.rea', 'rules', 'b-style.md'), 'STYLE RULE');
  const { files } = discoverMemory(sub, { home });
  const names = files.map((f) => f.content);
  assert.deepEqual(names, ['USER RULES', 'ROOT', 'PROJECT', 'LOCAL', 'CLAUDE COMPAT', 'STYLE RULE', 'SUB AGENTS']);
  assert.equal(files.find((f) => f.content === 'LOCAL').type, 'local');
  assert.equal(files.find((f) => f.content === 'STYLE RULE').type, 'rules');
});

test('imports: relative, ~/, nested, cycle-safe, non-text skipped, depth bounded', () => {
  const home = tmp(), proj = tmp();
  put(path.join(proj, 'REA.md'), 'main\n@docs/a.md\n@~/shared.md\n@logo.png');
  put(path.join(proj, 'docs', 'a.md'), 'A body\n@b.md');
  put(path.join(proj, 'docs', 'b.md'), 'B body\n@a.md');       // cycle back to a
  put(path.join(home, 'shared.md'), 'SHARED');
  const { files, skipped } = discoverMemory(proj, { home });
  assert.deepEqual(files.map((f) => f.content.split('\n')[0]), ['main', 'A body', 'B body', 'SHARED']);
  assert.equal(files[1].importedBy, path.join(proj, 'REA.md'));
  assert.ok(skipped.some((s) => /logo\.png$/.test(s.path) && /not a text file/.test(s.reason)));
});

test('conditional rules (paths:) are skipped and reported; HTML comments stripped; symlink dupes ignored; caps applied', () => {
  const home = tmp(), proj = tmp();
  put(path.join(proj, '.rea', 'rules', 'ts.md'), '---\npaths: src/**/*.ts\n---\nTS ONLY');
  put(path.join(proj, '.rea', 'rules', 'all.md'), '---\ndescription: x\n---\nALWAYS');
  put(path.join(proj, 'REA.md'), 'keep <!-- secret note --> this');
  symlinkSync(path.join(proj, 'REA.md'), path.join(proj, 'AGENTS.md'));
  put(path.join(proj, 'big', 'REA.md'), 'x'.repeat(500));
  const warns = [];
  const r = discoverMemory(proj, { home, maxFileChars: 100, warn: (m) => warns.push(m) });
  assert.ok(r.skipped.some((s) => /conditional rule/.test(s.reason)));
  const text = r.files.map((f) => f.content).join('\n');
  assert.match(text, /ALWAYS/);
  assert.doesNotMatch(text, /TS ONLY|secret note/);
  assert.equal(r.files.filter((f) => /keep\s+this/.test(f.content)).length, 1);      // symlink not loaded twice
  assert.match(renderMemory(r.files), /<memory-file path=".*REA\.md" type="project">/);
  assert.equal(renderMemory([]), '');
});

test('skills: dir layout, commands dir, name sanitising, frontmatter flags, precedence project > user', () => {
  const home = tmp(), proj = tmp(), warns = [];
  put(path.join(home, '.rea', 'skills', 'deploy', 'SKILL.md'), '---\ndescription: user deploy\n---\nuser steps');
  put(path.join(proj, '.rea', 'skills', 'deploy', 'SKILL.md'), '---\ndescription: project deploy\nallowed-tools: Bash(make:*), Read\nargument-hint: <env>\n---\nRun make $ARGUMENTS');
  put(path.join(proj, '.rea', 'skills', 'secret', 'SKILL.md'), '---\ndisable-model-invocation: true\n---\nonly the user');
  put(path.join(proj, '.rea', 'commands', 'lint it.md'), 'Run the linter.');
  put(path.join(proj, '.rea', 'skills', 'empty', 'SKILL.md'), '---\nname: empty\n---\n');
  const skills = loadSkills(proj, { home, warn: (m) => warns.push(m) });
  const by = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.equal(by.deploy.description, 'project deploy');
  assert.deepEqual(by.deploy.allowedTools, ['Bash(make:*)', 'Read']);
  assert.equal(by.secret.disableModelInvocation, true);
  assert.ok(by['lint-it']);
  assert.equal(by['lint-it'].description, 'Run the linter.');
  assert.equal(warns.length, 1);                                  // the empty skill
  assert.equal(expandSkill(by.deploy, 'prod'), 'Run make prod');
  assert.equal(expandSkill(by['lint-it'], 'src/'), 'Run the linter.\n\nARGUMENTS: src/');
});

test('Skill tool: lists model-invocable skills, refuses unknown and user-only, adds allowed-tools as session rules', async () => {
  const skills = [
    parseSkill('---\ndescription: ship it\nallowed-tools: Bash(make:*)\n---\nShip $ARGUMENTS', '/s/ship/SKILL.md', 'ship'),
    parseSkill('---\ndisable-model-invocation: true\n---\nuser only', '/s/priv/SKILL.md', 'priv'),
  ];
  const rules = new RuleSet({ cwd: '/p' });
  const tool = createSkillTool({ skills, addAllowRule: (r, src) => rules.add('allow', r, src) });
  assert.match(tool.description, /- ship: ship it/);
  assert.doesNotMatch(tool.description, /priv/);
  assert.equal(tool.validateInput({ skill: 'nope' }).ok, false);
  assert.match(tool.validateInput({ skill: 'priv' }).message, /only be invoked by the user/);
  assert.equal(tool.validateInput({ skill: '/ship' }).ok, true);
  const out = tool.call({ skill: 'ship', args: 'v2' });
  assert.match(out, /Ship v2/);
  assert.deepEqual(rules.list().map((r) => [r.rule, r.source]), [['Bash(make:*)', 'skill:ship']]);
});

test('memory reaches the model in the system prompt; read-only agents omit it, general-purpose keeps it', async () => {
  const seen = [];
  let step = 0;
  const model = async (req) => {
    seen.push(req.system);
    if (/read-only code exploration/.test(req.system) || /sub-agent of a terminal/.test(req.system)) return { content: [{ type: 'text', text: 'child done' }], stop_reason: 'end_turn' };
    step++;
    if (step === 1) return { content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: { description: 'd', prompt: 'p', subagent_type: 'Explore' } }, { type: 'tool_use', id: 'b', name: 'Agent', input: { description: 'd', prompt: 'p' } }], stop_reason: 'tool_use' };
    return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
  };
  let h;
  const tools = [defineTool({ name: 'Read', isReadOnly: () => true, call: () => 'x' })];
  tools.push(createAgentTool({ getParent: () => h, definitions: BUILT_IN_AGENTS, cwd: '/p' }));
  h = new Harness({ model, tools, system: 'BASE', memory: 'MEMORY: always use tabs', permissionMode: 'bypassPermissions', cwd: '/p' });
  await h.run('go');
  assert.match(seen[0], /BASE\n\nMEMORY: always use tabs/);                           // parent
  const explore = seen.find((s) => /read-only code exploration/.test(s));
  const general = seen.find((s) => /sub-agent of a terminal/.test(s));
  assert.doesNotMatch(explore, /always use tabs/);
  assert.match(general, /always use tabs/);
});
