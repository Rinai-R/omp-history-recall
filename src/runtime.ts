import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import { ompModel } from "./omp-model";
import { canonicalPath, RecallError } from "./source";
import { HistoryStore, type IndexResult } from "./store";
import { DEFAULT_INDEX_CONCURRENCY, validateConcurrency } from "./concurrency";
type SessionState = {
  store: HistoryStore;
  worker?: Promise<IndexResult>;
  controller?: AbortController;
  lastError?: string;
};

type IndexOptions = {
  file?: string;
  force?: boolean;
  maxJobs?: number;
  signal?: AbortSignal;
};

function budget(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new RecallError("invalid_budget", `${name} must be an integer from 1 to 10000.`);
  }
  return value;
}

/** Owns per-session stores and indexing cancellation; tool registration stays in index.ts. */
export class HistoryRuntime {
  private readonly states = new Map<string, SessionState>();

  async state(ctx: ExtensionContext): Promise<SessionState> {
    const id = ctx.sessionManager.getSessionId();
    const project = await canonicalPath(ctx.cwd);
    const existing = this.states.get(id);
    if (existing?.store.project === project) return existing;
    if (existing) {
      await this.stop(existing);
      existing.store.close();
      this.states.delete(id);
    }
    const ready = this.states.get(id);
    if (ready) return ready;
    const root = path.dirname(path.resolve(ctx.sessionManager.getSessionDir()));
    const databasePath = process.env.OMP_HISTORY_RECALL_DB ?? path.join(root, "history-recall", "index.db");
    const state: SessionState = { store: new HistoryStore(databasePath, project, id) };
    this.states.set(id, state);
    return state;
  }

  async initialize(ctx: ExtensionContext): Promise<void> {
    try {
      await this.state(ctx);
    } catch (error) {
      const code = error instanceof RecallError ? error.code : "history_unavailable";
      ctx.ui.notify(`History recall: ${code}. Normal conversation can continue.`, "warning");
    }
  }

  async index(ctx: ExtensionContext, options: IndexOptions = {}): Promise<IndexResult> {
    options.signal?.throwIfAborted();
    const concurrency = validateConcurrency(Number(process.env.OMP_HISTORY_RECALL_CONCURRENCY ?? DEFAULT_INDEX_CONCURRENCY));
    const state = await this.state(ctx);
    if (options.force) state.controller?.abort();
    // Serialize requests, but never return another file's indexing result to this caller.
    while (state.worker) {
      try { await state.worker; } catch { /* This caller owns a separate request. */ }
      options.signal?.throwIfAborted();
    }
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    state.controller = controller;
    const directory = ctx.sessionManager.getSessionDir();
    const file = options.file ? path.resolve(directory, options.file) : undefined;
    const run = async (): Promise<IndexResult> => {
      signal.throwIfAborted();
      if (options.force) state.store.clearSemanticCache();
      await state.store.discover(directory, { file, force: options.force, signal });
      const model = ompModel(ctx, metric => state.store.recordModelCall("index", metric));
      return state.store.work(model, {
        file,
        maxJobs: options.maxJobs ?? budget("OMP_HISTORY_RECALL_BATCH_SESSIONS", file ? 1 : 2),
        maxCalls: budget("OMP_HISTORY_RECALL_BATCH_CALLS", 12),
        maxDailyCalls: budget("OMP_HISTORY_RECALL_DAILY_CALLS", 60),
        concurrency,
        signal,
      });
    };
    state.worker = run().then(result => {
      const code = result.errors.at(-1)?.code;
      if (code && code !== state.lastError) {
        ctx.ui.notify(`History indexing: ${code}; progress is retained. See /history-recall status.`, "warning");
      }
      state.lastError = code;
      return result;
    }).catch(error => {
      state.lastError = signal.aborted ? "cancelled" : error instanceof RecallError ? error.code : "history_unavailable";
      throw error;
    }).finally(() => {
      state.worker = undefined;
      state.controller = undefined;
    });
    return state.worker;
  }

  cancel(ctx: ExtensionContext): void {
    this.states.get(ctx.sessionManager.getSessionId())?.controller?.abort();
  }

  async dispose(ctx: ExtensionContext): Promise<void> {
    const id = ctx.sessionManager.getSessionId();
    const state = this.states.get(id);
    if (!state) return;
    await this.stop(state);
    state.store.close();
    this.states.delete(id);
  }

  async retainCurrentSession(ctx: ExtensionContext): Promise<void> {
    const current = ctx.sessionManager.getSessionId();
    for (const [id, state] of this.states) {
      if (id === current) continue;
      await this.stop(state);
      state.store.close();
      this.states.delete(id);
    }
    await this.initialize(ctx);
  }

  private async stop(state: SessionState): Promise<void> {
    state.controller?.abort();
    try { await state.worker; } catch { /* The original caller receives the failure. */ }
  }
}
