// Plan mode (EnterPlanMode / ExitPlanMode) and AskUserQuestion.
// Behaviour follows the bundle (EVIDENCE.md §14): only the main session can enter plan mode; while it is active nothing may be
// modified except the plan file; a turn ends with a clarifying question or a plan-approval request, never a free-text
// "is this ok?". The wording and the approval options are original.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from './harness.js';

export const ENTER_PLAN = 'EnterPlanMode';
export const EXIT_PLAN = 'ExitPlanMode';
export const ASK_TOOL = 'AskUserQuestion';
/** Tools a sub-agent must never receive: they talk to the user or change the session's mode. */
export const MAIN_SESSION_ONLY = [ENTER_PLAN, EXIT_PLAN, ASK_TOOL];

export const planFilePath = (sessionId, home = os.homedir()) => path.join(home, '.rea', 'plans', `${String(sessionId).slice(0, 8)}.md`);

export function planModeReminder(planFile) {
  return `# Plan mode is active
The user asked to plan before any changes are made. You MUST NOT edit files, run commands that change anything, or make commits.
The single exception is the plan file: ${planFile}. Write and refine your plan there (create it if it does not exist).

Workflow: explore the code read-only (delegate broad searches to Explore agents), compare approaches, write the plan, then ask for approval.
The plan should contain: the approach and why, ordered steps, the files to change and existing code to reuse, and how to verify the result.

You may end your turn in exactly two ways:
- call ${ASK_TOOL} to clarify requirements or choose between approaches, or
- call ${EXIT_PLAN} when the plan file is complete, to request the user's approval.
Never ask whether the plan is acceptable in plain text; that is what ${EXIT_PLAN} is for.`;
}

export function createPlanTools({ getHarness, approvePlan }) {
  const enter = defineTool({
    name: ENTER_PLAN,
    description: 'Switch to plan mode for a non-trivial implementation task (new features, several valid approaches, multi-file or architectural changes) '
      + 'so you can explore and design an approach for user approval before changing anything. Do not use it for simple fixes. Main session only.',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    validateInput: () => {
      const h = getHarness();
      if (h.isSubAgent) return { ok: false, message: 'Only the main session can enter plan mode.' };
      if (h.permissionMode === 'plan') return { ok: false, message: 'Already in plan mode.' };
      return { ok: true };
    },
    call: () => {
      const h = getHarness();
      h.enterPlanMode();
      return `Entered plan mode. Explore the codebase read-only and write your plan to ${h.planFile}. DO NOT modify anything else yet. `
        + `When the plan is complete, call ${EXIT_PLAN} to request approval.`;
    },
  });

  const exit = defineTool({
    name: EXIT_PLAN,
    description: 'Present your finished plan to the user for approval and leave plan mode. Call it only in plan mode, after the plan file is written '
      + '(or pass the plan text in `plan`). Do not ask for approval any other way.',
    inputSchema: { type: 'object', properties: { plan: { type: 'string' } } },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    validateInput: ({ plan }) => {
      const h = getHarness();
      if (h.isSubAgent) return { ok: false, message: 'Only the main session can exit plan mode.' };
      if (h.permissionMode !== 'plan') return { ok: false, message: `${EXIT_PLAN} is only valid in plan mode. You are not in plan mode.` };
      if (!plan && !(h.planFile && existsSync(h.planFile))) return { ok: false, message: `No plan found. Write your plan to ${h.planFile} first, or pass it as "plan".` };
      return { ok: true };
    },
    async call({ plan }, _ctx, signal) {
      const h = getHarness();
      if (plan) { mkdirSync(path.dirname(h.planFile), { recursive: true }); writeFileSync(h.planFile, plan); }
      const text = readFileSync(h.planFile, 'utf8');
      if (!approvePlan) {
        throw new Error(`Plan approval needs an interactive session, so it was not approved. The plan is saved at ${h.planFile}; present it to the user as your answer and stop.`);
      }
      const decision = await approvePlan({ plan: text, planFile: h.planFile, previousMode: h.prePlanMode ?? 'default', signal });
      if (!decision?.approved) {
        const fb = decision?.feedback?.trim();
        throw new Error(`The user did not approve this plan${fb ? `. Their feedback: ${fb}` : ' and wants to keep planning'}. Revise the plan file and call ${EXIT_PLAN} again, or ask a clarifying question. You are still in plan mode.`);
      }
      h.exitPlanMode(decision.mode);
      return `The user approved your plan. Plan mode is off (mode: ${h.permissionMode}); you may now make changes. Follow the plan:\n\n${text}`;
    },
  });
  return [enter, exit];
}

const validQuestion = (q) => q && typeof q.question === 'string' && q.question.trim() && Array.isArray(q.options)
  && q.options.length >= 2 && q.options.length <= 4 && q.options.every((o) => o && typeof o.label === 'string' && o.label.trim());

export function createAskTool({ askQuestions }) {
  return defineTool({
    name: ASK_TOOL,
    description: 'Ask the user 1-4 multiple-choice questions to clarify requirements or choose between approaches. Each question has a short header '
      + '(max 12 characters), 2-4 options with a label and description, and may allow several answers (multiSelect). The user can always choose "Other". '
      + 'Put your recommended option first and label it "(Recommended)". Not for plan approval; use ExitPlanMode.',
    inputSchema: {
      type: 'object', required: ['questions'],
      properties: { questions: { type: 'array', description: 'Array of {question, header, options:[{label, description}], multiSelect}' } },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    validateInput: ({ questions }) => {
      if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) return { ok: false, message: 'Provide between 1 and 4 questions.' };
      const bad = questions.findIndex((q) => !validQuestion(q));
      if (bad >= 0) return { ok: false, message: `Question ${bad + 1} is invalid: it needs "question" text and 2-4 options that each have a "label".` };
      const long = questions.findIndex((q) => (q.header ?? '').length > 12);
      if (long >= 0) return { ok: false, message: `Question ${long + 1}: "header" must be at most 12 characters.` };
      return { ok: true };
    },
    async call({ questions }, _ctx, signal) {
      if (!askQuestions) throw new Error('There is no interactive user to ask. Make the most reasonable assumption, state it clearly, and continue.');
      const answers = await askQuestions({ questions, signal });
      if (!answers) throw new Error('The user declined to answer. Proceed with your best judgment, or stop and explain what you need.');
      return `User answers:\n${questions.map((q, i) => `- ${q.header ? `[${q.header}] ` : ''}${q.question}\n  => ${answers[i]}`).join('\n')}`;
    },
  });
}
