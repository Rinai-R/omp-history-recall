import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { analyzeConversation, conversationFacts, rewriteQuery, SEMANTIC_VERSION, validateConversationAnalysis, type ActiveWindow, type ConversationFacts, type JsonModel } from "./semantic";
import { digest, loadSource, readSourceEvidence, RecallError, type SessionSource } from "./source";
import { timeRange, type TimeFilter, type TimeRange } from "./time";
import type { ModelMetric } from "./omp-model";
import { openHistoryDatabase } from "./database";
import { validateConcurrency } from "./concurrency";
import { enumerateSources, validateSourceFile, type RecallScope, type SourceAccess, type SourceFileInfo, type SourceWarning } from "./scope";
import { TopicRegistry } from "./topic-registry";
import { selectTopics, TOPIC_VERSION, type ClusterPlan, type IncomingConversation, type TopicChangeCounts } from "./topics";
import { ModelBudget } from "./model-budget";
import { RepairProtocol, type DeferredRepair, type RepairRunner } from "./repair";
import { inputBudget } from "./chunking";

type Job = { file: string; stamp: string; attempts: number; token: string };
type ConversationRow = {
  id: string; session_id: string; file: string; source_cwd: string;
  source_hash: string; title: string; summary: string; started_at: string; last_active_at: string;
  entry_count: number; message_count: number; user_turn_count: number; branch_count: number;
  active_windows: string; size_bytes: number; model: string;
};
type TopicRow = { id: string; title: string; description: string; aliases: string };
export type CatalogEntry = SourceFileInfo & {
  indexed: boolean; conversation_id: string | null; session_id: string | null;
  title: string | null; description: string | null; source_cwd: string | null;
  time_basis: "filesystem" | "indexed"; started_at: string | null; last_active_at: string | null;
};
export type CatalogResult = { scope_id: string; conversations: CatalogEntry[]; next_cursor: string | null; warnings: SourceWarning[] };
export type DiscoveryResult = { scope_id: string; discovered: number; queued: number; warnings: SourceWarning[] };
export type BrowseOptions = TimeFilter & { topic_id?: string; cursor?: string; limit?: number };
export type IndexResult = { completed: number; failed: number; calls: number; errors: { file: string; code: string }[]; topic_changes: TopicChangeCounts; repair_deferred: DeferredRepair[] };
export type WorkOptions = { file?: string; maxJobs?: number; maxCalls?: number; maxDailyCalls?: number; concurrency?: number; signal?: AbortSignal };

function browseCursor(value: string, binding: string): { offset: number; range: TimeRange } {
  try {
    if (value.length > 512) throw new Error();
    const cursor: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!cursor || typeof cursor !== "object" || !("b" in cursor) || cursor.b !== binding
      || !("o" in cursor) || typeof cursor.o !== "number" || !Number.isSafeInteger(cursor.o) || cursor.o < 0
      || !("r" in cursor) || !cursor.r || typeof cursor.r !== "object") throw new Error();
    const range = cursor.r;
    if (!("from" in range) || !("to" in range)
      || (range.from !== null && typeof range.from !== "string")
      || (range.to !== null && typeof range.to !== "string")) throw new Error();
    return { offset: cursor.o, range: timeRange({ from: range.from ?? undefined, to: range.to ?? undefined }) };
  } catch {
    throw new RecallError("stale_cursor", "Directory changed, filters differ, or cursor is invalid; restart without a cursor.");
  }
}

function searchTerms(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const values = [...normalized.matchAll(/[a-z0-9_]+|\p{Script=Han}+/gu)].flatMap(match => {
    const word = match[0];
    if (!/\p{Script=Han}/u.test(word)) return word.length > 1 ? [word] : [];
    return word.length < 2 ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2));
  });
  return [...new Set(values)];
}

function pageLimit(value = 10): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new RecallError("invalid_limit", "limit must be between 1 and 50.");
  return value;
}

function formatDate(value: string): string {
  return new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function windowNarrative(windows: readonly ActiveWindow[]): string {
  if (windows.length === 0) return "no recorded activity";
  return windows.map(window => `${formatDate(window.from)} to ${formatDate(window.to)} (${window.entries} entries)`).join("; ");
}

function conversationPresentation(row: ConversationRow) {
  return {
    id: row.id, session_id: row.session_id, title: row.title,
    description: `${row.summary}\nActive: ${windowNarrative(JSON.parse(row.active_windows) as ActiveWindow[])}.`,
    started_at: row.started_at, last_active_at: row.last_active_at, entry_count: row.entry_count,
    message_count: row.message_count, user_turn_count: row.user_turn_count, branch_count: row.branch_count,
    size_bytes: row.size_bytes, source_file: row.file, source_cwd: row.source_cwd,
  };
}

function topicPresentation(topic: TopicRow, newestFirst: readonly ConversationRow[]) {
  const latest = newestFirst.slice(0, 3).map(row => `${row.title}: ${row.summary}`).join(" / ");
  let earliest = newestFirst[0]?.started_at;
  for (const row of newestFirst) if (!earliest || row.started_at < earliest) earliest = row.started_at;
  const span = earliest ? `${formatDate(earliest)} to ${newestFirst[0].last_active_at}` : "no indexed activity";
  return { id: topic.id, title: topic.title,
    description: `${topic.description} Timeline: ${span} across ${newestFirst.length} conversation(s).${latest ? ` Latest: ${latest}` : ""}`,
    member_count: newestFirst.length,
    aliases: JSON.parse(topic.aliases) as string[] };
}

export class HistoryStore {
  readonly db: Database;
  readonly excludedSessionId: string;
  private access: SourceAccess;
  private readonly registry: TopicRegistry;
  private closed = false;

  constructor(readonly dbPath: string, readonly scope: RecallScope, access: SourceAccess) {
    this.access = { ...access };
    this.excludedSessionId = access.activeSessionId;
    this.db = openHistoryDatabase(dbPath);
    this.db.run("INSERT OR IGNORE INTO hr_scopes(scope_id,revision) VALUES (?,0)", [scope.id]);
    this.registry = new TopicRegistry(this.db, scope.id, access.activeSessionId);
  }

  setSourceAccess(access: SourceAccess): void {
    if (access.activeSessionId !== this.excludedSessionId) throw new RecallError("scope_conflict", "Create a new store when the active session changes.");
    this.access = { ...access };
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }

  clearSemanticCache(): void {
    this.db.run("DELETE FROM hr_cache WHERE scope_id=?", [this.scope.id]);
  }

  recordModelCall(purpose: "index" | "search", metric: ModelMetric) {
    this.db.run("INSERT INTO hr_model_calls(scope_id,timestamp,purpose,metric) VALUES (?,?,?,?)",
      [this.scope.id, Date.now(), purpose, JSON.stringify(metric)]);
    this.db.run("DELETE FROM hr_model_calls WHERE scope_id=? AND timestamp<?", [this.scope.id, Date.now() - 30 * 86_400_000]);
  }

  modelCalls(since = 0) {
    return this.db.query<{ timestamp: number; purpose: string; metric: string }, [string, number]>(
      "SELECT timestamp,purpose,metric FROM hr_model_calls WHERE scope_id=? AND timestamp>=? ORDER BY id")
      .all(this.scope.id, since)
      .map(row => ({ timestamp: row.timestamp, purpose: row.purpose, ...JSON.parse(row.metric) as ModelMetric }));
  }

  private sources(signal?: AbortSignal) {
    const remembered = this.db.query<{ file: string }, [string, string]>(
      "SELECT file FROM hr_conversations WHERE scope_id=? UNION SELECT file FROM hr_jobs WHERE scope_id=?")
      .all(this.scope.id, this.scope.id).map(row => row.file);
    return enumerateSources(this.scope, this.access, remembered, signal);
  }

  async catalog(options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<CatalogResult> {
    const limit = pageLimit(options.limit);
    const { files, warnings } = await this.sources(options.signal);
    options.signal?.throwIfAborted();
    files.sort((a, b) => b.mtime_ms - a.mtime_ms || (a.source_file < b.source_file ? -1 : a.source_file > b.source_file ? 1 : 0));
    return this.db.transaction(() => {
      const binding = digest(JSON.stringify([this.scope.id, this.access.activeFile, this.excludedSessionId, limit,
        this.revision(), files.map(file => [file.source_file, file.mtime_ms, file.size_bytes])]));
      let offset = 0;
      if (options.cursor) offset = browseCursor(options.cursor, binding).offset;
      const indexed = new Map(this.db.query<ConversationRow, [string]>(
        "SELECT * FROM hr_conversations WHERE scope_id=?").all(this.scope.id).map(row => [row.file, row]));
      const visible = files.filter(file => indexed.get(file.source_file)?.session_id !== this.excludedSessionId);
      if (offset > visible.length) throw new RecallError("stale_cursor", "The catalog cursor is outside this source snapshot.");
      const conversations = visible.slice(offset, offset + limit).map((file): CatalogEntry => {
        const row = indexed.get(file.source_file);
        return { ...file, indexed: row !== undefined, conversation_id: row?.id ?? null,
          session_id: row?.session_id ?? null, title: row?.title ?? null,
          description: row ? conversationPresentation(row).description : null, source_cwd: row?.source_cwd ?? null,
          time_basis: row ? "indexed" : "filesystem", started_at: row?.started_at ?? null, last_active_at: row?.last_active_at ?? null };
      });
      return { scope_id: this.scope.id, conversations, warnings,
        next_cursor: offset + limit < visible.length
          ? Buffer.from(JSON.stringify({ b: binding, o: offset + limit, r: { from: null, to: null } })).toString("base64url") : null };
    })();
  }

  async discover(options: { file?: string; force?: boolean; signal?: AbortSignal } = {}): Promise<DiscoveryResult> {
    const { files, warnings } = await this.sources(options.signal);
    const selected = options.file === undefined ? files : [await validateSourceFile(options.file, files, options.signal)];
    let queued = 0;
    for (const file of selected) {
      options.signal?.throwIfAborted();
      const stamp = `${file.mtime_ms}:${file.size_bytes}`;
      const existing = this.db.query<{ stamp: string; session_id: string }, [string, string]>(
        "SELECT stamp,session_id FROM hr_conversations WHERE scope_id=? AND file=?").get(this.scope.id, file.source_file);
      if (existing?.session_id === this.excludedSessionId) continue;
      if (!options.force && existing?.stamp === stamp) continue;
      const change = this.db.run(`INSERT INTO hr_jobs(scope_id,file,directory,stamp) VALUES (?,?,?,?)
        ON CONFLICT(scope_id,file) DO UPDATE SET stamp=excluded.stamp,attempts=0,error=NULL,retry_at=0,lease_until=0,token=''
        WHERE (hr_jobs.stamp<>excluded.stamp OR ?=1) AND hr_jobs.lease_until<=?`,
        [this.scope.id, file.source_file, file.directory, stamp, options.force ? 1 : 0, Date.now()]);
      queued += change.changes;
    }
    return { scope_id: this.scope.id, discovered: selected.length, queued, warnings };
  }

  private claim(file?: string): Job | null {
    const now = Date.now();
    return this.db.transaction(() => {
      const job = this.db.query<Omit<Job, "token">, [string, string | null, string | null, number, number]>(
        `SELECT file,stamp,attempts FROM hr_jobs
         WHERE scope_id=? AND (? IS NULL OR file=?) AND attempts<3 AND retry_at<=? AND lease_until<=?
         ORDER BY file LIMIT 1`)
        .get(this.scope.id, file ?? null, file ?? null, now, now);
      if (!job) return null;
      const token = randomUUID();
      this.db.run("UPDATE hr_jobs SET token=?,lease_until=? WHERE scope_id=? AND file=?",
        [token, now + 120_000, this.scope.id, job.file]);
      return { ...job, token };
    }).immediate();
  }

  async work(model: JsonModel, repair: RepairRunner, options: WorkOptions = {}): Promise<IndexResult> {
    const concurrency = validateConcurrency(options.concurrency);
    const maxJobs = options.maxJobs ?? 1;
    const maxCalls = options.maxCalls ?? 12;
    const maxDailyCalls = options.maxDailyCalls ?? 60;
    for (const value of [maxJobs, maxCalls, maxDailyCalls]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new RecallError("invalid_budget", "Work budgets must be integers between 1 and 10000.");
    }
    if (options.file !== undefined && !path.isAbsolute(options.file)) throw new RecallError("invalid_file", "Use an absolute source_file from the catalog.");
    const modelBinding = [model.identity, model.contextWindow, model.maxOutputTokens];
    const budget = new ModelBudget(this.db, this.scope.id, { maxCalls, maxDailyCalls });
    const budgeted = budget.wrapJson(model, input => {
      const stage = input && typeof input === "object" && "stage" in input ? input.stage : undefined;
      return typeof stage === "string" && stage.startsWith("analysis_") ? SEMANTIC_VERSION : TOPIC_VERSION;
    });
    let completed = 0, failed = 0;
    const errors: IndexResult["errors"] = [];
    const deferred = new Map<string, DeferredRepair>();
    const topic_changes: TopicChangeCounts = { created: 0, updated: 0, merged: 0, reassigned: 0 };
    for (let index = 0; index < maxJobs; index++) {
      options.signal?.throwIfAborted();
      const job = this.claim(options.file);
      if (!job) break;
      const heartbeat = setInterval(() => {
        try { if (!this.closed) this.db.run("UPDATE hr_jobs SET lease_until=? WHERE scope_id=? AND file=? AND token=?",
          [Date.now() + 120_000, this.scope.id, job.file, job.token]); }
        catch { /* Publication checks lease ownership again. */ }
      }, 30_000);
      heartbeat.unref();
      try {
        await validateSourceFile(job.file, (await this.sources(options.signal)).files, options.signal);
        const source = await loadSource(job.file, { signal: options.signal });
        if (source.sessionId === this.excludedSessionId) throw new RecallError("invalid_file", "The active session cannot be indexed.");
        await this.checkSourceIdentity(source);
        const facts = conversationFacts(source);
        const cacheKey = digest(JSON.stringify([this.scope.id, "analysis", SEMANTIC_VERSION, modelBinding, source.fingerprint]));
        const cached = this.db.query<{ payload: string }, [string, string]>(
          "SELECT payload FROM hr_cache WHERE scope_id=? AND key=?").get(this.scope.id, cacheKey);
        let analysis;
        if (cached) {
          try { analysis = validateConversationAnalysis(JSON.parse(cached.payload), source); }
          catch {
            this.db.run("DELETE FROM hr_cache WHERE scope_id=? AND key=?", [this.scope.id, cacheKey]);
            throw new RecallError("invalid_model_output", "Cached conversation analysis does not match this source.");
          }
        } else {
          analysis = await analyzeConversation(budgeted, source, facts, { signal: options.signal, concurrency });
          this.db.run("INSERT OR REPLACE INTO hr_cache VALUES (?,?,?,?)", [this.scope.id, cacheKey, JSON.stringify(analysis), Date.now()]);
        }
        const incoming: IncomingConversation = {
          id: `c_${digest(JSON.stringify([this.scope.id, source.sessionId])).slice(0, 24)}`,
          sourceHash: source.fingerprint, analysis,
          evidenceById: new Map(source.entries.map(({ id, hash }) => [id, { id, hash }])),
        };
        const snapshot = this.registry.snapshot();
        const modelOptions = { signal: options.signal, concurrency };
        const selection = await selectTopics(budgeted, analysis, snapshot.cards, modelOptions);
        const protocol = new RepairProtocol(this.scope, this.registry, incoming, source, selection, snapshot,
          (id, signal) => this.readRepairSource(id, snapshot.revision, signal),
          { inputBytes: inputBudget(model.contextWindow, model.maxOutputTokens), concurrency });
        protocol.bindModel(model);
        await protocol.prepare(options.signal);
        const completion = protocol.hasUsableHistory
          ? await repair({ protocol, budget, signal: options.signal, concurrency })
          : { proposal_id: null, reason: "No available indexed historical members require maintenance." };
        const validated = protocol.finalize(completion);
        const plan: ClusterPlan = { expectedRevision: snapshot.revision, selection, repair: validated };
        // Never reuse protocol evidence reads here: every used source is checked anew.
        for (const guard of validated.sourceGuards) {
          if (guard.conversationId === incoming.id) continue;
          try {
            const current = await this.readRepairSource(guard.conversationId, snapshot.revision, options.signal);
            if (current.sessionId !== guard.sessionId || current.file !== guard.file || current.fingerprint !== guard.sourceHash) {
              throw new RecallError("stale_evidence", "Historical evidence changed before publication.");
            }
          } catch (error) {
            options.signal?.throwIfAborted();
            if (error instanceof RecallError && ["cancelled", "topic_state_changed", "scope_conflict"].includes(error.code)) throw error;
            throw new RecallError("stale_evidence", "Previously used historical evidence is no longer available at its verified version.");
          }
        }
        let current: SessionSource;
        try {
          await validateSourceFile(job.file, (await this.sources(options.signal)).files, options.signal);
          current = await loadSource(job.file, { signal: options.signal });
          if (current.fingerprint !== source.fingerprint || current.sessionId !== source.sessionId) {
            throw new RecallError("source_busy", "Source changed during preparation.");
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          throw new RecallError("source_busy", "Incoming source changed or became unavailable during preparation.");
        }
        await this.checkSourceIdentity(current);
        options.signal?.throwIfAborted();
        const changes = this.publish(current, facts, incoming, plan, model.identity, job);
        for (const key of ["created", "updated", "merged", "reassigned"] as const) topic_changes[key] += changes[key];
        for (const warning of protocol.deferred()) deferred.set(JSON.stringify([warning.conversation_id, warning.code]), warning);
        completed++;
      } catch (error) {
        const code = error instanceof RecallError ? error.code : options.signal?.aborted ? "cancelled" : "index_error";
        this.releaseJob(job, code);
        if (options.signal?.aborted) throw error;
        failed++;
        errors.push({ file: job.file, code });
      } finally { clearInterval(heartbeat); }
    }
    return { completed, failed, calls: budget.calls, errors, topic_changes, repair_deferred: [...deferred.values()] };
  }

  private async readRepairSource(conversationId: string, expectedRevision: number, signal?: AbortSignal): Promise<SessionSource> {
    signal?.throwIfAborted();
    this.registry.assertRevision(expectedRevision);
    const row = this.db.query<ConversationRow, [string, string, string]>(
      "SELECT * FROM hr_conversations WHERE scope_id=? AND id=? AND session_id<>?")
      .get(this.scope.id, conversationId, this.excludedSessionId);
    if (!row) throw new RecallError("invalid_model_output", "Repair evidence must belong to an indexed, non-active conversation in this scope.");
    const catalog = await this.sources(signal);
    if (!catalog.files.some(file => file.source_file === row.file)) {
      const warning = catalog.warnings.find(item => item.path === row.file);
      throw new RecallError(warning?.code ?? "source_unreadable", "Indexed historical source is missing, unreadable, or no longer canonical.");
    }
    await validateSourceFile(row.file, catalog.files, signal);
    const source = await loadSource(row.file, { signal });
    signal?.throwIfAborted();
    this.registry.assertRevision(expectedRevision);
    if (source.sessionId !== row.session_id || source.fingerprint !== row.source_hash) {
      throw new RecallError("stale_evidence", "Historical source no longer matches its indexed revision.");
    }
    return source;
  }

  private async checkSourceIdentity(source: SessionSource): Promise<void> {
    const atPath = this.db.query<{ session_id: string }, [string, string]>(
      "SELECT session_id FROM hr_conversations WHERE scope_id=? AND file=?").get(this.scope.id, source.file);
    if (atPath && atPath.session_id !== source.sessionId) throw new RecallError("source_identity_changed", "This path now claims a different session; the previous index is retained.");
    const duplicate = this.db.query<{ file: string }, [string, string]>(
      "SELECT file FROM hr_conversations WHERE scope_id=? AND session_id=?").get(this.scope.id, source.sessionId);
    if (duplicate && duplicate.file !== source.file) {
      try { await fs.lstat(duplicate.file); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      throw new RecallError("duplicate_session", "Two existing files claim the same session identity.");
    }
  }


  private releaseJob(job: Job, code: string): void {
    const retryable = ["cancelled", "work_budget", "source_busy", "daily_budget", "topic_state_changed"].includes(code);
    const now = Date.now();
    const retryAt = code === "daily_budget"
      ? Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000
      : now + (retryable ? 1000 : 30_000 * (job.attempts + 1));
    this.db.run(`UPDATE hr_jobs SET token='',lease_until=0,attempts=attempts+?,error=?,retry_at=? WHERE scope_id=? AND file=? AND token=?`,
      [retryable ? 0 : 1, code, retryAt, this.scope.id, job.file, job.token]);
  }

  private publish(source: SessionSource, facts: ConversationFacts, incoming: IncomingConversation, plan: ClusterPlan, model: string, job: Job): TopicChangeCounts {
    return this.db.transaction(() => {
      const lease = this.db.query<{ token: string }, [string, string]>(
        "SELECT token FROM hr_jobs WHERE scope_id=? AND file=?").get(this.scope.id, source.file);
      if (lease?.token !== job.token) throw new RecallError("lease_lost", "Another worker owns this indexing revision.");
      if (this.revision() !== plan.expectedRevision) throw new RecallError("topic_state_changed", "Topic state changed; retry against a fresh snapshot.");
      const previous = this.db.query<ConversationRow, [string, string]>(
        "SELECT * FROM hr_conversations WHERE scope_id=? AND id=?").get(this.scope.id, incoming.id);
      this.registry.captureIncoming(incoming, plan.expectedRevision);
      const now = new Date().toISOString();
      this.db.run(`INSERT INTO hr_conversations(scope_id,id,session_id,file,directory,stamp,source_cwd,source_hash,title,summary,
        started_at,last_active_at,entry_count,message_count,user_turn_count,branch_count,active_windows,size_bytes,model,indexed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_id,id) DO UPDATE SET
        file=excluded.file,directory=excluded.directory,stamp=excluded.stamp,source_cwd=excluded.source_cwd,source_hash=excluded.source_hash,
        title=excluded.title,summary=excluded.summary,started_at=excluded.started_at,last_active_at=excluded.last_active_at,
        entry_count=excluded.entry_count,message_count=excluded.message_count,user_turn_count=excluded.user_turn_count,
        branch_count=excluded.branch_count,active_windows=excluded.active_windows,size_bytes=excluded.size_bytes,model=excluded.model,indexed_at=excluded.indexed_at`, [
        this.scope.id, incoming.id, source.sessionId, source.file, path.dirname(source.file), source.stamp, source.cwd, source.fingerprint,
        source.title, incoming.analysis.summary, facts.active_windows[0]?.from ?? source.timestamp, facts.active_windows.at(-1)?.to ?? source.timestamp,
        facts.entry_count, facts.message_count, facts.user_turn_count, facts.branch_count, JSON.stringify(facts.active_windows), source.sizeBytes, model, now,
      ]);
      if (previous?.source_hash !== source.fingerprint) {
        this.db.run("DELETE FROM hr_search WHERE scope_id=? AND conversation_id=?", [this.scope.id, incoming.id]);
        this.db.run("DELETE FROM hr_entries WHERE scope_id=? AND conversation_id=?", [this.scope.id, incoming.id]);
        const insertEntry = this.db.prepare("INSERT INTO hr_entries(scope_id,id,conversation_id,entry_id,parent_id,timestamp,role,line,hash,text) VALUES (?,?,?,?,?,?,?,?,?,?)");
        const insertSearch = this.db.prepare("INSERT INTO hr_search(row_id,scope_id,conversation_id,body) VALUES (?,?,?,?)");
        for (const entry of source.entries) {
          const rowId = `e_${digest(JSON.stringify([this.scope.id, source.sessionId, entry.id])).slice(0, 24)}`;
          insertEntry.run(this.scope.id, rowId, incoming.id, entry.id, entry.parentId, entry.timestamp, entry.role || entry.type, entry.line, entry.hash, entry.text);
          if (entry.text.trim()) insertSearch.run(rowId, this.scope.id, incoming.id, searchTerms(entry.text).join(" "));
        }
      }
      const changes = this.registry.apply(plan, incoming, now);
      this.db.run("UPDATE hr_scopes SET revision=revision+1 WHERE scope_id=?", [this.scope.id]);
      this.db.run("DELETE FROM hr_jobs WHERE scope_id=? AND file=? AND token=?", [this.scope.id, source.file, job.token]);
      this.db.run("DELETE FROM hr_cache WHERE scope_id=? AND created_at<?", [this.scope.id, Date.now() - 30 * 86_400_000]);
      return changes;
    }).immediate();
  }


  private predicate(range: TimeRange) {
    return {
      sql: "c.scope_id=? AND c.session_id<>? AND (? IS NULL OR c.last_active_at>=?) AND (? IS NULL OR c.started_at<?)",
      args: [this.scope.id, this.excludedSessionId, range.from, range.from, range.to, range.to],
    };
  }

  private presentConversation(row: ConversationRow) {
    const memberships = this.db.query<{ topic_id: string; facet_id: string; reason: string; evidence: string }, [string, string]>(`
      SELECT m.topic_id,m.facet_id,m.reason,f.evidence FROM hr_memberships m
      JOIN hr_facets f ON f.scope_id=m.scope_id AND f.conversation_id=m.conversation_id AND f.id=m.facet_id
      WHERE m.scope_id=? AND m.conversation_id=? ORDER BY m.facet_id`).all(this.scope.id, row.id)
      .map(({ topic_id, facet_id, reason, evidence }) => ({ topic_id, facet_id, reason,
        evidence_refs: (JSON.parse(evidence) as { id: string; hash: string }[]).map(ref => ({ entry_id: ref.id, sha256: ref.hash })) }));
    return { ...conversationPresentation(row), memberships };
  }

  private requireTopic(id: string): void {
    const topic = this.db.query<{ id: string }, [string, string, string]>(`
      SELECT t.id FROM hr_topics t WHERE t.scope_id=? AND t.id=? AND EXISTS (
        SELECT 1 FROM hr_memberships m JOIN hr_conversations c ON c.scope_id=m.scope_id AND c.id=m.conversation_id
        WHERE m.scope_id=t.scope_id AND m.topic_id=t.id AND c.session_id<>?)`).get(this.scope.id, id, this.excludedSessionId);
    if (!topic) throw new RecallError("not_found", "Topic is unavailable in this profile.");
  }

  browse(options: BrowseOptions = {}) {
    return this.db.transaction(() => {
      let range = timeRange(options);
      const revision = this.revision();
      const limit = pageLimit(options.limit);
      const binding = digest(JSON.stringify([this.scope.id, this.excludedSessionId, revision, options.days, options.from, options.to, options.topic_id, limit]));
      let offset = 0;
      if (options.cursor) {
        const cursor = browseCursor(options.cursor, binding);
        offset = cursor.offset;
        range = cursor.range;
      }
      const pred = this.predicate(range);
      let level: string;
      let rows: unknown[];
      if (options.topic_id) {
        this.requireTopic(options.topic_id);
        level = "conversations";
        rows = (this.db.query(`SELECT c.* FROM hr_conversations c WHERE ${pred.sql}
          AND EXISTS (SELECT 1 FROM hr_memberships m WHERE m.scope_id=c.scope_id AND m.conversation_id=c.id AND m.topic_id=?)
          ORDER BY c.last_active_at DESC,c.id LIMIT ? OFFSET ?`)
          .all(...pred.args, options.topic_id, limit + 1, offset) as ConversationRow[]).map(row => this.presentConversation(row));
      } else {
        level = "topics";
        const conversations = this.db.query<ConversationRow & { topic_id: string; topic_title: string; topic_description: string; topic_aliases: string }, (string | null)[]>(`
          SELECT DISTINCT c.*,t.id AS topic_id,t.title AS topic_title,t.description AS topic_description,t.aliases AS topic_aliases
          FROM hr_topics t JOIN hr_memberships m ON m.scope_id=t.scope_id AND m.topic_id=t.id
          JOIN hr_conversations c ON c.scope_id=m.scope_id AND c.id=m.conversation_id
          WHERE ${pred.sql} ORDER BY t.id,c.last_active_at DESC,c.id`).all(...pred.args);
        const grouped = new Map<string, { topic: TopicRow; conversations: ConversationRow[] }>();
        for (const row of conversations) {
          let group = grouped.get(row.topic_id);
          if (!group) {
            group = { topic: { id: row.topic_id, title: row.topic_title, description: row.topic_description, aliases: row.topic_aliases }, conversations: [] };
            grouped.set(row.topic_id, group);
          }
          group.conversations.push(row);
        }
        rows = [...grouped.values()].map(({ topic, conversations }) => topicPresentation(topic, conversations)).slice(offset, offset + limit + 1);
      }
      return { scope_id: this.scope.id, level, range, revision, entries: rows.slice(0, limit),
        next_cursor: rows.length > limit ? Buffer.from(JSON.stringify({ b: binding, o: offset + limit, r: range })).toString("base64url") : null };
    })();
  }

  async search(inputQueries: readonly string[], options: TimeFilter & { topic_id?: string; conversation_id?: string; limit?: number; model?: JsonModel; signal?: AbortSignal } = {}) {
    if (!Array.isArray(inputQueries) || inputQueries.length < 1 || inputQueries.length > 8) {
      throw new RecallError("invalid_query", "queries must contain 1 to 8 strings.");
    }
    if (inputQueries.some(query => typeof query !== "string" || !query.trim() || query.length > 2000)) {
      throw new RecallError("invalid_query", "each query must contain 1 to 2000 characters.");
    }
    const range = timeRange(options);
    const pred = this.predicate(range);
    options.signal?.throwIfAborted();
    if (options.topic_id) this.requireTopic(options.topic_id);
    if (options.conversation_id && !this.db.query("SELECT id FROM hr_conversations WHERE scope_id=? AND id=? AND session_id<>?")
      .get(this.scope.id, options.conversation_id, this.excludedSessionId)) throw new RecallError("not_found", "Conversation is unavailable in this profile.");
    let queries = [...inputQueries.map(query => query.trim())];
    let rewriteError: string | null = null;
    const deadline = AbortSignal.timeout(30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    if (options.model) {
      try { queries.push(...(await rewriteQuery(options.model, inputQueries, signal)).queries); }
      catch (error) {
        options.signal?.throwIfAborted();
        rewriteError = deadline.aborted ? "rewrite_timeout" : error instanceof RecallError ? error.code : "rewrite_unavailable";
        queries = [...inputQueries.map(query => query.trim())];
      }
    }
    const terms = searchTerms(queries.join(" ")).slice(0, 128);
    const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    options.signal?.throwIfAborted();
    const topicFilter = options.topic_id ? " AND EXISTS (SELECT 1 FROM hr_memberships m WHERE m.scope_id=c.scope_id AND m.conversation_id=c.id AND m.topic_id=?)" : "";
    const conversationFilter = options.conversation_id ? " AND c.id=?" : "";
    const { rows, conversations } = this.db.transaction(() => {
      const rows = match ? this.db.query(`
        SELECT c.id,COUNT(*) AS hits FROM hr_search f JOIN hr_conversations c ON c.scope_id=f.scope_id AND c.id=f.conversation_id
        WHERE hr_search MATCH ? AND f.scope_id=?${topicFilter}${conversationFilter} AND ${pred.sql}
        GROUP BY c.id ORDER BY hits DESC,c.last_active_at DESC LIMIT 200`)
        .all(match, this.scope.id, ...(options.topic_id ? [options.topic_id] : []), ...(options.conversation_id ? [options.conversation_id] : []),
          ...pred.args) as { id: string; hits: number }[] : [];
      const conversations = rows.map(row => {
        const conversation = this.db.query<ConversationRow, [string, string]>("SELECT * FROM hr_conversations WHERE scope_id=? AND id=?").get(this.scope.id, row.id)!;
        const matched = this.db.query<{ entry_id: string }, [string, string, string]>(`
          SELECT e.entry_id FROM hr_search f JOIN hr_entries e ON e.scope_id=f.scope_id AND e.id=f.row_id
          WHERE hr_search MATCH ? AND f.scope_id=? AND f.conversation_id=? ORDER BY e.timestamp,e.line LIMIT 20`)
          .all(match, this.scope.id, row.id).map(value => value.entry_id);
        return { ...this.presentConversation(conversation), matched_entry_ids: matched, lexical_hits: row.hits };
      });
      return { rows, conversations };
    })();
    return { mode: options.model ? "lexical+rewrite" : "lexical", rewrite_error: rewriteError,
      candidate_limit_reached: rows.length > 50, range, conversations: conversations.slice(0, pageLimit(options.limit)),
      evidence_required: true };
  }

  async readConversation(conversationId: string, options: {
    cursor?: string;
    maxChars?: number;
    entry_id?: string;
    before?: number;
    after?: number;
    signal?: AbortSignal;
  } = {}) {
    const conversation = this.db.query<ConversationRow, [string, string, string]>(
      "SELECT * FROM hr_conversations WHERE scope_id=? AND id=? AND session_id<>?")
      .get(this.scope.id, conversationId, this.excludedSessionId);
    if (!conversation) throw new RecallError("not_found", "Conversation is unavailable or belongs to the active session.");
    await validateSourceFile(conversation.file, (await this.sources(options.signal)).files, options.signal);
    const source = await loadSource(conversation.file, { signal: options.signal });
    if (source.sessionId !== conversation.session_id || source.fingerprint !== conversation.source_hash) {
      throw new RecallError("stale_evidence", "Conversation changed after indexing; rebuild before reading.");
    }
    return { ...this.presentConversation(conversation), source_hash: conversation.source_hash,
      ...readSourceEvidence(this.scope.id, source, options) };
  }

  revision(): number {
    return this.db.query<{ revision: number }, [string]>("SELECT revision FROM hr_scopes WHERE scope_id=?").get(this.scope.id)!.revision;
  }

  status() {
    return this.db.transaction(() => ({
      scope_id: this.scope.id, schema: 5, revision: this.revision(),
      conversations: this.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM hr_conversations WHERE scope_id=? AND session_id<>?").get(this.scope.id, this.excludedSessionId)!.n,
      topics: this.db.query<{ n: number }, [string, string]>(`SELECT COUNT(DISTINCT m.topic_id) AS n FROM hr_memberships m
        JOIN hr_conversations c ON c.scope_id=m.scope_id AND c.id=m.conversation_id WHERE c.scope_id=? AND c.session_id<>?`).get(this.scope.id, this.excludedSessionId)!.n,
      indexed_entries: this.db.query<{ n: number }, [string, string]>(`SELECT COUNT(*) AS n FROM hr_entries e
        JOIN hr_conversations c ON c.scope_id=e.scope_id AND c.id=e.conversation_id WHERE c.scope_id=? AND c.session_id<>?`).get(this.scope.id, this.excludedSessionId)!.n,
      indexing_calls_today: this.db.query<{ calls: number }, [string, string]>("SELECT calls FROM hr_budget WHERE scope_id=? AND day=?")
        .get(this.scope.id, new Date().toISOString().slice(0, 10))?.calls ?? 0,
      jobs: this.db.query<{ file: string; attempts: number; error: string | null; lease_until: number; retry_at: number }, [string]>(
        "SELECT file,attempts,error,lease_until,retry_at FROM hr_jobs WHERE scope_id=? ORDER BY file").all(this.scope.id),
    }))();
  }
}
