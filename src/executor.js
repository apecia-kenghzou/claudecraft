// Tool executor modelled on Claude Code's streaming executor (EVIDENCE.md §4):
//   canExecute(safe) = nothing running  OR  (safe AND every running tool is safe)
//   processQueue walks the queue in order and STOPS at a blocked unsafe tool (an ordering barrier);
//   a blocked safe tool is skipped over. On abort, queued tools get a synthetic error result.
// Addition over the original: a concurrency cap (Claude applies its cap, default 10, in the batch path).

export const DEFAULT_MAX_CONCURRENCY = Number(process.env.REA_MAX_TOOL_CONCURRENCY) || 10;

export class ToolExecutor {
  /**
   * @param {(block:object, signal?:AbortSignal)=>Promise<object>} run  executes one tool_use, returns a tool_result
   */
  constructor({ run, maxConcurrency = DEFAULT_MAX_CONCURRENCY, signal } = {}) {
    this.run = run;
    this.maxConcurrency = maxConcurrency;
    this.signal = signal;
    this.tools = [];
    signal?.addEventListener('abort', () => this.#interruptQueued(), { once: true });
  }

  /** Queue a tool call as soon as it is known (works while the model is still streaming). */
  add(block, { safe = false } = {}) {
    const entry = { block, safe, status: 'queued', result: undefined };
    entry.done = new Promise((resolve) => { entry.resolve = resolve; });
    this.tools.push(entry);
    if (this.signal?.aborted) this.#interrupt(entry);
    else this.#processQueue();
    return entry.done;
  }

  #canExecute(safe) {
    const running = this.tools.filter((t) => t.status === 'executing');
    return running.length === 0 || (safe && running.every((t) => t.safe) && running.length < this.maxConcurrency);
  }

  #processQueue() {
    for (const t of this.tools) {
      if (t.status !== 'queued') continue;
      if (this.#canExecute(t.safe)) this.#start(t);
      else if (!t.safe) break;
    }
  }

  #start(t) {
    t.status = 'executing';
    Promise.resolve()
      .then(() => this.run(t.block, this.signal))
      .catch((err) => ({
        type: 'tool_result', tool_use_id: t.block.id, is_error: true,
        content: `<tool_use_error>Error calling tool: ${err?.message ?? err}</tool_use_error>`,
      }))
      .then((result) => {
        t.status = 'done'; t.result = result; t.resolve(result);
        this.#processQueue();
      });
  }

  #interrupt(t) {
    t.status = 'done';
    t.result = {
      type: 'tool_result', tool_use_id: t.block.id, is_error: true,
      content: '<tool_use_error>Interrupted before this tool ran.</tool_use_error>',
    };
    t.resolve(t.result);
  }

  #interruptQueued() {
    for (const t of this.tools) if (t.status === 'queued') this.#interrupt(t);
  }

  /** Results in the order the calls were added (the API requires matching order). */
  async drain() {
    await Promise.all(this.tools.map((t) => t.done));
    return this.tools.map((t) => t.result);
  }
}
