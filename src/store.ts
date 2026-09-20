import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { conversationFacts, indexConversation, rewriteQuery, SEMANTIC_VERSION, type ActiveWindow, type ConversationFacts, type ConversationIndex, type JsonModel, type TopicVocabulary } from "./semantic";
import { canonicalPath, digest, evidencePage, loadSource, RecallError, redactJson, type SessionSource, type SourceEntry } from "./source";
import { timeRange, type TimeFilter, type TimeRange } from "./time";
import type { ModelMetric } from "./omp-model";
import { openHistoryDatabase } from "./database";
import { validateConcurrency } from "./concurrency";

type Job = { file: string; stamp: string; attempts: number; token: string };
type ConversationRow = {
  id: string; session_id: string; file: string; source_project: string; unprojected: number;
  source_hash: string; title: string; summary: string; started_at: string; last_active_at: string;
  entry_count: number; message_count: number; user_turn_count: number; branch_count: number;
  active_windows: string; size: number; model: string;
};
type TopicRow = { id: string; title: string; description: string; aliases: string };
type CatalogEntry = {
  file: string; file_name: string; indexed: boolean; conversation_id: string | null;
  session_id: string | null; title: string | null; description: string | null;
  started_at: string; last_active_at: string; size_bytes: number; mtime_ms: number;
};
export type BrowseOptions = TimeFilter & { topic_id?: string; cursor?: string; limit?: number };
export type IndexResult = { completed: number; failed: number; calls: number; errors: { file: string; code: string }[] };

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
    size_bytes: row.size, source_file: row.file, source_project: row.source_project, unprojected: row.unprojected === 1,
  };
}

function topicPresentation(topic: TopicRow, newestFirst: readonly ConversationRow[]) {
  const latest = newestFirst.slice(0, 3).map(row => `${row.title}: ${row.summary}`).join(" / ");
  let earliest = newestFirst[0]?.started_at;
  for (const row of newestFirst) if (!earliest || row.started_at < earliest) earliest = row.started_at;
  const span = earliest ? `${formatDate(earliest)} to ${newestFirst[0].last_active_at}` : "no indexed activity";
  return { id: topic.id, title: topic.title,
    description: `${topic.description} Timeline: ${span} across ${newestFirst.length} conversation(s).${latest ? ` Latest: ${latest}` : ""}`,
    aliases: JSON.parse(topic.aliases) as string[] };
}

export class HistoryStore {
  readonly db: Database;
  readonly project: string;
  readonly excludedSessionId?: string;
  private closed = false;

  constructor(readonly dbPath: string, project: string, excludedSessionId?: string) {
    try { this.project = realpathSync(project); } catch { this.project = path.resolve(project); }
    this.excludedSessionId = excludedSessionId;
    this.db = openHistoryDatabase(dbPath);
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }

  clearSemanticCache(): void {
    this.db.run("DELETE FROM hr_chunk_cache WHERE project=?", [this.project]);
  }

  recordModelCall(purpose: "index" | "search", metric: ModelMetric) {
    this.db.run("INSERT INTO hr_model_calls(project,timestamp,purpose,metric) VALUES (?,?,?,?)",
      [this.project, Date.now(), purpose, JSON.stringify(metric)]);
    this.db.run("DELETE FROM hr_model_calls WHERE project=? AND timestamp<?", [this.project, Date.now() - 30 * 86_400_000]);
  }

  modelCalls(since = 0) {
    return this.db.query<{ timestamp: number; purpose: string; metric: string }, [string, number]>(
      "SELECT timestamp,purpose,metric FROM hr_model_calls WHERE project=? AND timestamp>=? ORDER BY id")
      .all(this.project, since)
      .map(row => ({ timestamp: row.timestamp, purpose: row.purpose, ...JSON.parse(row.metric) as ModelMetric }));
  }

  async catalog(directory: string, options: { excludeFile?: string; signal?: AbortSignal } = {}) {
    const dir = await canonicalPath(directory);
    const exclude = options.excludeFile ? await canonicalPath(options.excludeFile) : undefined;
    const names = (await fs.readdir(dir)).filter(name => name.endsWith(".jsonl")).sort().reverse();
    const conversations: CatalogEntry[] = [];
    for (const name of names) {
      options.signal?.throwIfAborted();
      const file = path.join(dir, name);
      if (file === exclude) continue;
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const row = this.db.query<ConversationRow, [string, string]>(
        "SELECT * FROM hr_conversations WHERE project=? AND file=?").get(this.project, file);
      conversations.push({
        file, file_name: name, indexed: row !== null, conversation_id: row?.id ?? null,
        session_id: row?.session_id ?? null, title: row?.title ?? null,
        description: row ? conversationPresentation(row).description : null,
        started_at: row?.started_at ?? new Date(stat.mtimeMs).toISOString(),
        last_active_at: row?.last_active_at ?? new Date(stat.mtimeMs).toISOString(),
        size_bytes: stat.size, mtime_ms: stat.mtimeMs,
      });
    }
    return { directory: dir, conversations };
  }

  async discover(directory: string, options: { file?: string; force?: boolean; signal?: AbortSignal } = {}) {
    const dir = await canonicalPath(directory);
    let selected = options.file === undefined ? undefined : path.resolve(dir, options.file);
    if (selected) {
      const parent = await canonicalPath(path.dirname(selected));
      if (parent !== dir || !selected.endsWith(".jsonl")) {
        throw new RecallError("invalid_file", "Select a JSONL session file inside the session directory.");
      }
      selected = path.join(parent, path.basename(selected));
    }
    const files = selected ? [selected] : (await fs.readdir(dir)).filter(name => name.endsWith(".jsonl")).sort().map(name => path.join(dir, name));
    let queued = 0;
    for (const file of files) {
      options.signal?.throwIfAborted();
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        if (selected) throw new RecallError("invalid_file", "The selected session must be an existing regular file, not a symbolic link.");
        continue;
      }
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      const existing = this.db.query<{ stamp: string }, [string, string]>(
        "SELECT stamp FROM hr_conversations WHERE project=? AND file=?").get(this.project, file);
      if (!options.force && existing?.stamp === stamp) continue;
      this.db.run(`INSERT INTO hr_jobs(project,file,directory,stamp) VALUES (?,?,?,?)
        ON CONFLICT(project,file) DO UPDATE SET stamp=excluded.stamp,attempts=0,error=NULL,retry_at=0,lease_until=0,token=''
        WHERE hr_jobs.stamp<>excluded.stamp OR ?=1`, [this.project, file, dir, stamp, options.force ? 1 : 0]);
      queued++;
    }
    return { discovered: files.length, queued };
  }

  private claim(file?: string): Job | null {
    const now = Date.now();
    return this.db.transaction(() => {
      const job = this.db.query<Omit<Job, "token">, [string, string | null, string | null, number, number]>(
        `SELECT file,stamp,attempts FROM hr_jobs
         WHERE project=? AND (? IS NULL OR file=?) AND attempts<3 AND retry_at<=? AND lease_until<=?
         ORDER BY file LIMIT 1`)
        .get(this.project, file ?? null, file ?? null, now, now);
      if (!job) return null;
      const token = randomUUID();
      this.db.run("UPDATE hr_jobs SET token=?,lease_until=? WHERE project=? AND file=?",
        [token, now + 120_000, this.project, job.file]);
      return { ...job, token };
    }).immediate();
  }

  async work(model: JsonModel, options: { file?: string; maxJobs?: number; maxCalls?: number; maxDailyCalls?: number; concurrency?: number; signal?: AbortSignal } = {}): Promise<IndexResult> {
    const concurrency = validateConcurrency(options.concurrency);
    const maxJobs = options.maxJobs ?? 1;
    const maxCalls = options.maxCalls ?? 12;
    const maxDailyCalls = options.maxDailyCalls ?? 60;
    for (const value of [maxJobs, maxCalls, maxDailyCalls]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new RecallError("invalid_budget", "Work budgets must be integers between 1 and 10000.");
    }
    const file = options.file === undefined ? undefined : await canonicalPath(options.file);
    const modelBinding = [SEMANTIC_VERSION, model.identity, model.contextWindow, model.maxOutputTokens];
    const requestKey = (system: string, input: unknown) => digest(JSON.stringify(["request", modelBinding, system, input]));
    let completed = 0, failed = 0, calls = 0;
    const errors: { file: string; code: string }[] = [];
    for (let index = 0; index < maxJobs; index++) {
      options.signal?.throwIfAborted();
      const job = this.claim(file);
      if (!job) break;
      const heartbeat = setInterval(() => {
        try { if (!this.closed) this.db.run("UPDATE hr_jobs SET lease_until=? WHERE project=? AND file=? AND token=?",
          [Date.now() + 120_000, this.project, job.file, job.token]); }
        catch { /* Publication checks lease ownership again. */ }
      }, 30_000);
      heartbeat.unref();
      const budgeted: JsonModel = {
        identity: model.identity,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        generate: async (system, input, signal) => {
          signal?.throwIfAborted();
          const key = requestKey(system, input);
          const cached = this.db.query<{ payload: string }, [string, string]>(
            "SELECT payload FROM hr_chunk_cache WHERE project=? AND key=?").get(this.project, key);
          if (cached) {
            return JSON.parse(cached.payload) as string;
          }
          if (calls >= maxCalls) throw new RecallError("work_budget", "Batch indexing model-call budget reached.");
          this.reserveModelCall(maxDailyCalls);
          calls++;
          let result = await model.generate(system, input, signal);
          try { result = redactJson(result); } catch { return result; }
          this.db.run("INSERT OR REPLACE INTO hr_chunk_cache VALUES (?,?,?,?)", [this.project, key, JSON.stringify(result), Date.now()]);
          return result;
        },
        invalidateCachedResponse: (system, input) => {
          this.db.run("DELETE FROM hr_chunk_cache WHERE project=? AND key=?", [this.project, requestKey(system, input)]);
        },
      };
      try {
        const source = await loadSource(job.file, { signal: options.signal });
        if (source.sessionId === this.excludedSessionId) {
          this.db.run("DELETE FROM hr_jobs WHERE project=? AND file=? AND token=?", [this.project, job.file, job.token]);
          continue;
        }
        const duplicate = this.db.query<{ file: string }, [string, string]>(
          "SELECT file FROM hr_conversations WHERE project=? AND session_id=?").get(this.project, source.sessionId);
        if (duplicate && duplicate.file !== source.file) throw new RecallError("duplicate_session", "Two files claim the same session identity.");
        const facts = conversationFacts(source);
        const vocabulary = this.topicVocabulary();
        const cacheKey = digest(JSON.stringify(["conversation", modelBinding, source.fingerprint, vocabulary]));
        const cached = this.db.query<{ payload: string }, [string, string]>(
          "SELECT payload FROM hr_chunk_cache WHERE project=? AND key=?").get(this.project, cacheKey);
        const semantic = cached ? JSON.parse(cached.payload) as ConversationIndex
          : await indexConversation(budgeted, source, facts, { signal: options.signal, vocabulary, concurrency });
        if (!cached) {
          this.db.run("INSERT OR REPLACE INTO hr_chunk_cache VALUES (?,?,?,?)",
            [this.project, cacheKey, JSON.stringify(semantic), Date.now()]);
        }
        const current = await loadSource(job.file, { signal: options.signal });
        if (current.fingerprint !== source.fingerprint) throw new RecallError("source_busy", "Source changed during preparation.");
        this.publish(source, facts, semantic, model.identity, job);
        completed++;
      } catch (error) {
        const code = error instanceof RecallError ? error.code : options.signal?.aborted ? "cancelled" : "index_error";
        this.releaseJob(job, code);
        if (options.signal?.aborted) throw error;
        failed++;
        errors.push({ file: job.file, code });
      } finally { clearInterval(heartbeat); }
    }
    return { completed, failed, calls, errors };
  }

  private reserveModelCall(maxDailyCalls: number): void {
    const day = new Date().toISOString().slice(0, 10);
    const reserved = this.db.query<{ calls: number }, [string, string, number]>(`
      INSERT INTO hr_budget(project,day,calls) VALUES (?,?,1)
      ON CONFLICT(project,day) DO UPDATE SET calls=calls+1 WHERE calls<? RETURNING calls`)
      .get(this.project, day, maxDailyCalls);
    if (!reserved) throw new RecallError("daily_budget", "Daily indexing model-call budget reached; work resumes after UTC midnight.");
  }

  private releaseJob(job: Job, code: string): void {
    const retryable = ["cancelled", "work_budget", "source_busy", "daily_budget"].includes(code);
    const now = Date.now();
    const retryAt = code === "daily_budget"
      ? Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000
      : now + (retryable ? 1000 : 30_000 * (job.attempts + 1));
    this.db.run(`UPDATE hr_jobs SET token='',lease_until=0,attempts=attempts+?,error=?,retry_at=? WHERE project=? AND file=? AND token=?`,
      [retryable ? 0 : 1, code, retryAt, this.project, job.file, job.token]);
  }

  private publish(
    source: SessionSource,
    facts: ConversationFacts,
    semantic: ConversationIndex,
    model: string,
    job: Job,
  ) {
    this.db.transaction(() => {
      const lease = this.db.query<{ token: string }, [string, string]>(
        "SELECT token FROM hr_jobs WHERE project=? AND file=?").get(this.project, source.file);
      if (lease?.token !== job.token) throw new RecallError("lease_lost", "Another worker owns this indexing revision.");
      const id = `c_${digest(`${this.project}\0${source.sessionId}`).slice(0, 24)}`;
      this.db.run("DELETE FROM hr_search WHERE project=? AND conversation_id=?", [this.project, id]);
      this.db.run("DELETE FROM hr_conversations WHERE project=? AND id=?", [this.project, id]);
      const now = new Date().toISOString();
      this.db.run("INSERT INTO hr_conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
        id, this.project, source.sessionId, source.file, path.dirname(source.file), job.stamp,
        source.project, source.project === this.project ? 0 : 1, source.fingerprint, source.title, semantic.summary,
        facts.active_windows[0]?.from ?? source.timestamp, facts.active_windows.at(-1)?.to ?? source.timestamp,
        facts.entry_count, facts.message_count, facts.user_turn_count, facts.branch_count,
        JSON.stringify(facts.active_windows), source.entries.length, model, now,
      ]);
      const insertEntry = this.db.prepare("INSERT INTO hr_entries VALUES (?,?,?,?,?,?,?,?,?,?)");
      const insertSearch = this.db.prepare("INSERT INTO hr_search(row_id,project,conversation_id,body) VALUES (?,?,?,?)");
      for (const entry of source.entries) {
        const rowId = digest(JSON.stringify([this.project, source.sessionId, entry.id])).slice(0, 24);
        insertEntry.run(rowId, this.project, id, entry.id, entry.parentId, entry.timestamp, entry.role || entry.type, entry.line, entry.hash, entry.text);
        if (entry.text.trim()) insertSearch.run(rowId, this.project, id, searchTerms(entry.text).join(" "));
      }
      for (const topic of semantic.topics) {
        const topicId = `t_${digest(topic.title.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()).slice(0, 20)}`;
        const existing = this.db.query<{ aliases: string }, [string, string]>(
          "SELECT aliases FROM hr_topics WHERE project=? AND id=?").get(this.project, topicId);
        // Preserve existing aliases first, then fill the remaining bounded vocabulary.
        const previousAliases = existing ? JSON.parse(existing.aliases) as string[] : [];
        const aliases = [...new Set([...previousAliases, ...topic.aliases])].slice(0, 24);
        this.db.run(`INSERT INTO hr_topics VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(project,id) DO UPDATE SET aliases=excluded.aliases,description=excluded.description,updated_at=excluded.updated_at`,
          [this.project, topicId, topic.title, topic.description, JSON.stringify(aliases), now, now]);
        this.db.run("INSERT INTO hr_conversation_topics VALUES (?,?,?)", [this.project, topicId, id]);
      }
      this.db.run("DELETE FROM hr_jobs WHERE project=? AND file=? AND token=?", [this.project, source.file, job.token]);
      this.db.run("DELETE FROM hr_chunk_cache WHERE project=? AND created_at<?", [this.project, Date.now() - 30 * 86_400_000]);
    }).immediate();
  }

  private topicVocabulary(): TopicVocabulary {
    return {
      topics: this.db.query<{ id: string; title: string; description: string; aliases: string }, [string]>(
        "SELECT id,title,description,aliases FROM hr_topics WHERE project=? ORDER BY title COLLATE NOCASE,id LIMIT 40")
        .all(this.project)
        .map(topic => ({ id: topic.id, title: topic.title, description: topic.description, aliases: JSON.parse(topic.aliases) as string[] })),
    };
  }

  private predicate(range: TimeRange) {
    return {
      sql: "c.project=? AND (? IS NULL OR c.session_id<>?) AND (? IS NULL OR c.last_active_at>=?) AND (? IS NULL OR c.started_at<?)",
      args: [this.project, this.excludedSessionId ?? null, this.excludedSessionId ?? null, range.from, range.from, range.to, range.to],
    };
  }

  browse(options: BrowseOptions = {}) {
    let range = timeRange(options);
    const revision = this.revision();
    const binding = digest(JSON.stringify([revision, options.days, options.from, options.to, options.topic_id]));
    let offset = 0;
    if (options.cursor) {
      const cursor = browseCursor(options.cursor, binding);
      offset = cursor.offset;
      range = cursor.range;
    }
    const pred = this.predicate(range);
    const limit = pageLimit(options.limit);
    let level: string;
    let rows: unknown[];
    if (options.topic_id) {
      level = "conversations";
      rows = (this.db.query(`
        SELECT c.* FROM hr_conversations c JOIN hr_conversation_topics ct ON ct.conversation_id=c.id
        WHERE ${pred.sql} AND ct.topic_id=? ORDER BY c.last_active_at DESC,c.id LIMIT ? OFFSET ?`)
        .all(...pred.args, options.topic_id, limit + 1, offset) as ConversationRow[]).map(conversationPresentation);
    } else {
      level = "topics";
      const conversations = this.db.query<ConversationRow & { topic_id: string; topic_title: string; topic_description: string; topic_aliases: string }, (string | null)[]>(`
        SELECT c.*,t.id AS topic_id,t.title AS topic_title,t.description AS topic_description,t.aliases AS topic_aliases
        FROM hr_topics t JOIN hr_conversation_topics ct ON ct.project=t.project AND ct.topic_id=t.id
        JOIN hr_conversations c ON c.id=ct.conversation_id
        WHERE ${pred.sql} ORDER BY t.id,c.last_active_at DESC,c.id`).all(...pred.args);
      const grouped = new Map<string, { topic: TopicRow; conversations: ConversationRow[] }>();
      for (const row of conversations) {
        let group = grouped.get(row.topic_id);
        if (!group) {
          group = {
            topic: { id: row.topic_id, title: row.topic_title, description: row.topic_description, aliases: row.topic_aliases },
            conversations: [],
          };
          grouped.set(row.topic_id, group);
        }
        group.conversations.push(row);
      }
      rows = [...grouped.values()].map(({ topic, conversations }) => topicPresentation(topic, conversations)).slice(offset, offset + limit + 1);
    }
    return { level, range, revision, entries: rows.slice(0, limit),
      next_cursor: rows.length > limit ? Buffer.from(JSON.stringify({ b: binding, o: offset + limit, r: range })).toString("base64url") : null };
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
    const topicFilter = options.topic_id ? " AND ct.topic_id=?" : "";
    const conversationFilter = options.conversation_id ? " AND c.id=?" : "";
    const rows = this.db.query(`
      SELECT c.id,COUNT(*) AS hits FROM hr_search f JOIN hr_conversations c ON c.id=f.conversation_id
      LEFT JOIN hr_conversation_topics ct ON ct.conversation_id=c.id
      WHERE hr_search MATCH ? AND f.project=?${topicFilter}${conversationFilter} AND ${pred.sql}
      GROUP BY c.id ORDER BY hits DESC,c.last_active_at DESC LIMIT 200`)
      .all(match, this.project,
        ...(options.topic_id ? [options.topic_id] : []),
        ...(options.conversation_id ? [options.conversation_id] : []),
        ...pred.args) as { id: string; hits: number }[];
    const conversations = rows.map(row => {
      const conversation = this.db.query<ConversationRow, [string]>("SELECT * FROM hr_conversations WHERE id=?").get(row.id)!;
      const matched = this.db.query<{ entry_id: string }, [string, string]>(`
        SELECT e.entry_id FROM hr_search f JOIN hr_entries e ON e.id=f.row_id
        WHERE hr_search MATCH ? AND f.conversation_id=? ORDER BY e.timestamp,e.line LIMIT 20`)
        .all(match, row.id).map(value => value.entry_id);
      return { ...conversationPresentation(conversation), matched_entry_ids: matched, lexical_hits: row.hits };
    });
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
    const conversation = this.db.query<ConversationRow, [string, string, string | null, string | null]>(
      "SELECT * FROM hr_conversations WHERE project=? AND id=? AND (? IS NULL OR session_id<>?)")
      .get(this.project, conversationId, this.excludedSessionId ?? null, this.excludedSessionId ?? null);
    if (!conversation) throw new RecallError("not_found", "Conversation is unavailable or belongs to the active session.");
    const source = await loadSource(conversation.file, { signal: options.signal });
    if (source.sessionId !== conversation.session_id || source.fingerprint !== conversation.source_hash) {
      throw new RecallError("stale_evidence", "Conversation changed after indexing; rebuild before reading.");
    }
    const byId = new Map(source.entries.map(entry => [entry.id, entry]));
    let chain: typeof source.entries;
    let focus: { entry_id: string; before: number; after: number; alternate_children: string[] } | undefined;
    if (options.entry_id !== undefined) {
      const before = options.before ?? 3;
      const after = options.after ?? 3;
      for (const value of [before, after]) {
        if (!Number.isSafeInteger(value) || value < 0 || value > 50) throw new RecallError("invalid_context", "before and after must be integers from 0 to 50.");
      }
      const target = byId.get(options.entry_id);
      if (!target) throw new RecallError("not_found", "Entry does not belong to this conversation revision.");
      const ancestors: typeof source.entries = [];
      for (let current: SourceEntry | undefined = target; current; current = current.parentId ? byId.get(current.parentId) : undefined) ancestors.unshift(current);
      const prefix = ancestors.slice(Math.max(0, ancestors.length - before - 1));
      const children = new Map<string, typeof source.entries>();
      for (const entry of source.entries) {
        if (!entry.parentId) continue;
        const list = children.get(entry.parentId) ?? [];
        list.push(entry);
        children.set(entry.parentId, list);
      }
      const descendants: typeof source.entries = [];
      const alternateChildren: string[] = [];
      let current: typeof target | undefined = target;
      while (descendants.length < after && current) {
        const branches = [...(children.get(current.id) ?? [])].sort((left, right) =>
          right.timestamp.localeCompare(left.timestamp) || right.line - left.line);
        if (branches.length === 0) break;
        if (branches.length > 1) alternateChildren.push(...branches.slice(1).map(entry => entry.id));
        current = branches[0];
        descendants.push(current);
      }
      chain = [...prefix, ...descendants];
      focus = { entry_id: target.id, before, after, alternate_children: alternateChildren };
    } else {
      const leaf = source.entries.at(-1)!;
      chain = [];
      for (let current: typeof leaf | undefined = leaf; current; current = current.parentId ? byId.get(current.parentId) : undefined) {
        chain.unshift(current);
      }
    }
    return { ...conversationPresentation(conversation), source_hash: conversation.source_hash,
      context: focus,
      ...evidencePage(source, chain.map(({ id, hash }) => ({ id, hash })), options) };
  }

  revision(): string {
    return digest(JSON.stringify(this.db.query(
      "SELECT id,source_hash,indexed_at FROM hr_conversations WHERE project=? ORDER BY id").all(this.project)));
  }

  status() {
    return {
      project: this.project, schema: 3, revision: this.revision(),
      conversations: this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM hr_conversations WHERE project=?").get(this.project)!.n,
      topics: this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM hr_topics WHERE project=?").get(this.project)!.n,
      indexed_entries: this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM hr_entries WHERE project=?").get(this.project)!.n,
      indexing_calls_today: this.db.query<{ calls: number }, [string, string]>("SELECT calls FROM hr_budget WHERE project=? AND day=?")
        .get(this.project, new Date().toISOString().slice(0, 10))?.calls ?? 0,
      jobs: this.db.query("SELECT file,attempts,error,lease_until,retry_at FROM hr_jobs WHERE project=? ORDER BY file").all(this.project),
    };
  }
}
