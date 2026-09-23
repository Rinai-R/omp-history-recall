import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import { ompModel, resolveRecallModel, type ModelMetric } from "./omp-model";
import { ompRepairRunner } from "./omp-repair";
import { RecallError } from "./source";
import { HistoryStore, type IndexResult } from "./store";
import { resolveRecallScope } from "./scope";

import { announce, IndexProgress } from "./progress";

const STARTUP_CWD = process.cwd();
type SessionState = {
  sessionId: string;
  store: HistoryStore;
  worker?: Promise<IndexResult>;
  controller?: AbortController;
  lastError?: string;
  progress?: IndexProgress;
};

type IndexOptions = {
  file?: string;
  force?: boolean;
  signal?: AbortSignal;
};


/** Owns per-session stores and indexing cancellation; tool registration stays in index.ts. */
export class HistoryRuntime {
  private readonly states = new Map<string, SessionState>();
  private readonly databaseOverride = process.env.OMP_HISTORY_RECALL_DB === undefined
    ? undefined : path.resolve(STARTUP_CWD, process.env.OMP_HISTORY_RECALL_DB);

  async state(ctx: ExtensionContext): Promise<SessionState> {
    const sessionId = ctx.sessionManager.getSessionId();
    const scope = await resolveRecallScope();
    const databasePath = this.databaseOverride ?? path.join(scope.sessionsRoot, "history-recall", "index.db");
    const key = JSON.stringify([sessionId, scope.id, databasePath]);
    const access = { sessionDir: ctx.sessionManager.getSessionDir(), activeFile: ctx.sessionManager.getSessionFile(), activeSessionId: sessionId };
    const existing = this.states.get(key);
    if (existing) {
      existing.store.setSourceAccess(access);
      return existing;
    }
    const state: SessionState = { sessionId, store: new HistoryStore(databasePath, scope, access) };
    this.states.set(key, state);
    return state;
  }

  async initialize(ctx: ExtensionContext): Promise<void> {
    try {
      await this.state(ctx);
    } catch (error) {
      const code = error instanceof RecallError ? error.code : "history_unavailable";
      announce(ctx, `History recall: ${code}. Normal conversation can continue.`, "warning");
    }
  }

  async index(ctx: ExtensionContext, options: IndexOptions = {}): Promise<IndexResult> {
    options.signal?.throwIfAborted();
    const file = options.file;
    if (file !== undefined && !path.isAbsolute(file)) throw new RecallError("invalid_file", "Use the absolute source_file returned by history_recall_conversations.");
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
    state.lastError = undefined;
    state.progress?.dispose();
    const progress = new IndexProgress(ctx);
    state.progress = progress;
    const onCancel = () => progress.cancelling();
    signal.addEventListener("abort", onCancel, { once: true });
    const run = async (): Promise<IndexResult> => {
      signal.throwIfAborted();
      if (options.force) state.store.clearSemanticCache();
      await state.store.discover({ file, force: options.force, signal });
      const selected = resolveRecallModel(ctx);
      const pending = state.store.status().jobs;
      progress.setQueue(pending.filter(job => (file === undefined || job.file === file) && job.lease_until <= Date.now()).length,
        pending.length, `${selected.provider}/${selected.id}`);
      const observe = (metric: ModelMetric) => {
        progress.modelCall();
        state.store.recordModelCall("index", metric);
      };
      const model = ompModel(ctx, observe, selected);
      const repair = ompRepairRunner(ctx, observe, selected);
      return state.store.work(model, repair, {
        file,
        signal,
        onProgress: update => progress.update(update),
      });
    };
    state.worker = run().then(result => {
      state.lastError = result.errors.at(-1)?.code;
      progress.finish(result, state.store.status().jobs.length);
      return result;
    }).catch(error => {
      state.lastError = signal.aborted ? "cancelled" : error instanceof RecallError ? error.code : "history_unavailable";
      progress.fail(state.lastError);
      throw error;
    }).finally(() => {
      signal.removeEventListener("abort", onCancel);
      state.worker = undefined;
      state.controller = undefined;
    });
    return state.worker;
  }

  cancel(ctx: ExtensionContext): void {
    for (const state of this.states.values()) {
      if (state.sessionId !== ctx.sessionManager.getSessionId()) continue;
      state.controller?.abort();
      if (!state.worker) { state.progress?.dispose(); state.progress = undefined; }
    }
  }

  async dispose(ctx: ExtensionContext): Promise<void> {
    const id = ctx.sessionManager.getSessionId();
    for (const [key, state] of this.states) {
      if (state.sessionId !== id) continue;
      await this.stop(state);
      state.store.close();
      this.states.delete(key);
    }
  }

  async retainCurrentSession(ctx: ExtensionContext): Promise<void> {
    const current = ctx.sessionManager.getSessionId();
    for (const [key, state] of this.states) {
      if (state.sessionId === current) continue;
      await this.stop(state);
      state.store.close();
      this.states.delete(key);
    }
    await this.initialize(ctx);
  }

  private async stop(state: SessionState): Promise<void> {
    state.controller?.abort();
    try { await state.worker; } catch { /* The original caller receives the failure. */ }
    state.progress?.dispose();
    state.progress = undefined;
  }
}
