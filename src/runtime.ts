import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import { ompModel, resolveRecallModel } from "./omp-model";
import { ompRepairRunner } from "./omp-repair";
import { RecallError } from "./source";
import { HistoryStore, type IndexResult } from "./store";
import { DEFAULT_INDEX_CONCURRENCY, validateConcurrency } from "./concurrency";
import { resolveRecallScope } from "./scope";

const STARTUP_CWD = process.cwd();
type SessionState = {
  sessionId: string;
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
      ctx.ui.notify(`History recall: ${code}. Normal conversation can continue.`, "warning");
    }
  }

  async index(ctx: ExtensionContext, options: IndexOptions = {}): Promise<IndexResult> {
    options.signal?.throwIfAborted();
    const concurrency = validateConcurrency(Number(process.env.OMP_HISTORY_RECALL_CONCURRENCY ?? DEFAULT_INDEX_CONCURRENCY));
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
    const run = async (): Promise<IndexResult> => {
      signal.throwIfAborted();
      if (options.force) state.store.clearSemanticCache();
      await state.store.discover({ file, force: options.force, signal });
      const selected = resolveRecallModel(ctx);
      const observe = (metric: Parameters<HistoryStore["recordModelCall"]>[1]) => state.store.recordModelCall("index", metric);
      const model = ompModel(ctx, observe, selected);
      const repair = ompRepairRunner(ctx, observe, selected);
      return state.store.work(model, repair, {
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
      if (result.repair_deferred.length) {
        ctx.ui.notify(`History repair: ${result.repair_deferred.length} historical sources are not yet available for repair; the complete history has not been repaired.`, "warning");
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
    for (const state of this.states.values()) if (state.sessionId === ctx.sessionManager.getSessionId()) state.controller?.abort();
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
  }
}
