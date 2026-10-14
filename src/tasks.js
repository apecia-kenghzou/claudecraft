// Session task list: TaskCreate / TaskGet / TaskList / TaskUpdate (tool names and "session task checklist" purpose
// from the bundle's tool hints; data model and wording are original).
import { defineTool } from './harness.js';

export const STATUSES = ['pending', 'in_progress', 'completed'];
const SYMBOL = { pending: '☐', in_progress: '◐', completed: '☒' };

export class TaskList {
  constructor(items = [], onChange, onEvent) {
    this.onEvent = onEvent;
    this.items = items.map((t) => ({ ...t }));
    this.next = this.items.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0) + 1;
    this.onChange = onChange;
  }

  #changed() { this.onChange?.(this.items); }

  /** Replace the whole list (used when resuming a session). */
  replace(items) {
    this.items = items.map((t) => ({ ...t }));
    this.next = this.items.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0) + 1;
  }

  create({ subject, description = '', activeForm }) {
    const t = { id: String(this.next++), subject, description, status: 'pending', activeForm, blocks: [], blockedBy: [] };
    this.items.push(t); this.#changed(); this.onEvent?.({ type: 'created', task: t }); return t;
  }

  get(id) { return this.items.find((t) => t.id === String(id)); }

  update(id, patch) {
    const t = this.get(id);
    if (!t) throw new Error(`No task with id ${id}`);
    if (patch.status === 'deleted') {
      this.items = this.items.filter((x) => x !== t);
      for (const o of this.items) { o.blocks = o.blocks.filter((b) => b !== t.id); o.blockedBy = o.blockedBy.filter((b) => b !== t.id); }
      this.#changed(); return { deleted: true, task: t };
    }
    const was = t.status;
    for (const k of ['subject', 'description', 'activeForm', 'status']) if (patch[k] !== undefined) t[k] = patch[k];
    if (was !== 'completed' && t.status === 'completed') this.onEvent?.({ type: 'completed', task: t });
    for (const other of patch.addBlockedBy ?? []) {
      if (!this.get(other)) throw new Error(`No task with id ${other}`);
      if (!t.blockedBy.includes(String(other))) t.blockedBy.push(String(other));
      const o = this.get(other); if (!o.blocks.includes(t.id)) o.blocks.push(t.id);
    }
    for (const other of patch.addBlocks ?? []) {
      if (!this.get(other)) throw new Error(`No task with id ${other}`);
      if (!t.blocks.includes(String(other))) t.blocks.push(String(other));
      const o = this.get(other); if (!o.blockedBy.includes(t.id)) o.blockedBy.push(t.id);
    }
    this.#changed(); return { task: t };
  }

  /** Open blockers only (completed blockers no longer block). */
  openBlockers(t) { return t.blockedBy.filter((b) => { const o = this.get(b); return o && o.status !== 'completed'; }); }

  render() {
    if (!this.items.length) return '(no tasks)';
    return this.items.map((t) => {
      const blockers = this.openBlockers(t);
      return `${SYMBOL[t.status] ?? '?'} #${t.id} [${t.status}] ${t.subject}${blockers.length ? ` (blocked by ${blockers.map((b) => `#${b}`).join(', ')})` : ''}`;
    }).join('\n');
  }
}

export function createTaskTools(list) {
  const idSchema = { type: 'string' };
  return [
    defineTool({
      name: 'TaskCreate', description: 'Create a task in the session task list. Use it to plan multi-step work and track progress. Tasks start as pending.',
      inputSchema: { type: 'object', required: ['subject'], properties: { subject: { type: 'string' }, description: { type: 'string' }, activeForm: { type: 'string' } } },
      isReadOnly: () => true,
      call: (i) => { const t = list.create(i); return `Task #${t.id} created: ${t.subject}`; },
    }),
    defineTool({
      name: 'TaskGet', description: 'Retrieve one task by id, including description and dependencies.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: idSchema } },
      isReadOnly: () => true, isConcurrencySafe: () => true,
      call: ({ id }) => {
        const t = list.get(id);
        if (!t) throw new Error(`No task with id ${id}`);
        return JSON.stringify({ ...t, openBlockers: list.openBlockers(t) }, null, 1);
      },
    }),
    defineTool({
      name: 'TaskList', description: 'List all tasks with their status and open blockers.',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: () => true, isConcurrencySafe: () => true,
      call: () => list.render(),
    }),
    defineTool({
      name: 'TaskUpdate',
      description: 'Update a task: set status (pending, in_progress, completed, or deleted to remove it), edit subject/description, or add dependencies. Mark a task in_progress before starting it and completed as soon as it is done.',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: {
          id: idSchema, status: { type: 'string', enum: [...STATUSES, 'deleted'] }, subject: { type: 'string' }, description: { type: 'string' },
          activeForm: { type: 'string' }, addBlocks: { type: 'array' }, addBlockedBy: { type: 'array' },
        },
      },
      isReadOnly: () => true,
      call: ({ id, ...patch }) => {
        const r = list.update(id, patch);
        if (r.deleted) return `Task #${r.task.id} deleted.`;
        const open = list.items.filter((t) => t.status !== 'completed').length;
        return `Task #${r.task.id} is now ${r.task.status}.${open === 0 ? ' All tasks are completed.' : ` ${open} task${open === 1 ? '' : 's'} remaining.`}`;
      },
    }),
  ];
}
