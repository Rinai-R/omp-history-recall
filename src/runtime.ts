import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import { RecallError } from "./source";
import { resolveRecallScope, type RecallScope, type SourceAccess } from "./scope";
import { HistoryStore, type SyncResult } from "./store";

const STARTUP_CWD = process.cwd();
const DEFAULT_INGEST_FILES = 64;
const DEFAULT_INGEST_BYTES = 32 * 1024 * 1024;

export type SessionState = {
  sessionId: string;
  scope: RecallScope;
  store: HistoryStore;
  syncing?: Promise<SyncResult>;
  controller?: AbortController;
  lastError?: string;
};

export type SyncOptions = { maxFiles?: number; signal?: AbortSignal };

function ingestBudget(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RecallError("invalid_budget", `${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

/** Owns per-session stores and bounded synchronization; tool registration stays in index.ts. */
export class HistoryRuntime {
  private readonly states = new Map<string, SessionState>();
  private readonly databaseOverride = process.env.OMP_HISTORY_RECALL_DB === undefined
    ? undefined : path.resolve(STARTUP_CWD, process.env.OMP_HISTORY_RECALL_DB);

  async state(ctx: ExtensionContext): Promise<SessionState> {
    const sessionId = ctx.sessionManager.getSessionId();
    const scope = await resolveRecallScope();
    const databasePath = this.databaseOverride ?? path.join(scope.sessionsRoot, "history-recall", "index.db");
    const key = `${scope.id}\0${databasePath}\0${sessionId}`;
    const access: SourceAccess = {
      sessionDir: ctx.sessionManager.getSessionDir() || undefined,
      activeFile: ctx.sessionManager.getSessionFile(),
      activeSessionId: sessionId,
    };
    const existing = this.states.get(key);
    if (existing) {
      existing.store.setSourceAccess(access);
      return existing;
    }
    for (const [id, state] of this.states) {
      if (state.sessionId !== sessionId) {
        await this.stop(state);
        state.store.close();
        this.states.delete(id);
      }
    }
    const state: SessionState = {
      sessionId, scope, store: new HistoryStore(databasePath, scope, access),
    };
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

  /** Run one bounded, model-free ingestion pass. Concurrent callers share the run. */
  async sync(ctx: ExtensionContext, options: SyncOptions = {}): Promise<SyncResult> {
    options.signal?.throwIfAborted();
    const state = await this.state(ctx);
    if (state.syncing) {
      try { await state.syncing; } catch { /* This caller owns a separate request. */ }
      options.signal?.throwIfAborted();
    }
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    state.controller = controller;
    state.syncing = state.store.sync({
      maxFiles: options.maxFiles ?? ingestBudget("OMP_HISTORY_RECALL_INGEST_FILES", DEFAULT_INGEST_FILES, 10_000),
      maxBytes: ingestBudget("OMP_HISTORY_RECALL_INGEST_BYTES", DEFAULT_INGEST_BYTES, 1_073_741_824),
      signal,
    }).then(result => {
      state.lastError = result.failures.at(-1)?.code;
      return result;
    }).catch(error => {
      state.lastError = signal.aborted ? "cancelled" : error instanceof RecallError ? error.code : "index_error";
      throw error;
    }).finally(() => {
      state.syncing = undefined;
      state.controller = undefined;
    });
    return state.syncing;
  }

  cancel(ctx: ExtensionContext): void {
    for (const state of this.states.values()) {
      if (state.sessionId === ctx.sessionManager.getSessionId()) state.controller?.abort();
    }
  }

  async dispose(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    for (const [key, state] of this.states) {
      if (state.sessionId !== sessionId) continue;
      await this.stop(state);
      state.store.close();
      this.states.delete(key);
    }
  }

  async retainCurrentSession(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    for (const [key, state] of this.states) {
      if (state.sessionId === sessionId) continue;
      await this.stop(state);
      state.store.close();
      this.states.delete(key);
    }
    await this.initialize(ctx);
  }

  private async stop(state: SessionState): Promise<void> {
    state.controller?.abort();
    try { await state.syncing; } catch { /* The original caller receives the failure. */ }
  }
}
