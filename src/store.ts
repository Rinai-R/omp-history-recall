import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { conversationFacts, indexConversation, rewriteQuery, SEMANTIC_VERSION, type ActiveWindow, type JsonModel, type TopicVocabulary } from "./semantic";
import { canonicalPath, digest, evidencePage, loadSource, RecallError, redactJson, type SessionSource, type SourceEntry } from "./source";
import { timeRange, type TimeFilter, type TimeRange } from "./time";
import type { ModelMetric } from "./omp-model";

type Job = { file: string; stamp: string; attempts: number; token: string };
type ConversationRow = {
  id: string; session_id: string; file: string; source_project: string; unprojected: number;
  source_hash: string; title: string; summary: string; started_at: string; last_active_at: string;
  entry_count: number; message_count: number; user_turn_count: number; branch_count: number;
  active_windows: string; size: number; model: string;
};
type TopicRow = { id: string; title: string; description: string; aliases: string };
export type BrowseOptions = TimeFilter & { topic_id?: string; cursor?: string; limit?: number };

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

function topicPresentation(topic: TopicRow, conversations: ConversationRow[]) {
  const ordered = [...conversations].sort((a, b) => b.last_active_at.localeCompare(a.last_active_at));
  const latest = ordered.slice(0, 3).map(row => `${row.title}: ${row.summary}`).join(" / ");
  const span = conversations.length
    ? `${formatDate(conversations.map(row => row.started_at).sort().at(0)!)} to ${conversations.map(row => row.last_active_at).sort().at(-1)!}`
    : "no indexed activity";
  return { id: topic.id, title: topic.title,
    description: `${topic.description} Timeline: ${span} across ${conversations.length} conversation(s).${latest ? ` Latest: ${latest}` : ""}`,
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
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version !== 0 && version !== 3) {
      this.db.close();
      throw new RecallError("unsupported_index", "This plugin uses a new explicit conversation/topic index; delete the old database.");
    }
    if (version === 3) return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE hr_topics (
          project TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,aliases TEXT NOT NULL,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project,id)
        );
        CREATE TABLE hr_conversations (
          id TEXT PRIMARY KEY,project TEXT NOT NULL,session_id TEXT NOT NULL,file TEXT NOT NULL,directory TEXT NOT NULL,
          stamp TEXT NOT NULL,source_project TEXT NOT NULL,unprojected INTEGER NOT NULL,source_hash TEXT NOT NULL,
          title TEXT NOT NULL,summary TEXT NOT NULL,started_at TEXT NOT NULL,last_active_at TEXT NOT NULL,
          entry_count INTEGER NOT NULL,message_count INTEGER NOT NULL,user_turn_count INTEGER NOT NULL,
          branch_count INTEGER NOT NULL,active_windows TEXT NOT NULL,size INTEGER NOT NULL,model TEXT NOT NULL,
          indexed_at TEXT NOT NULL,UNIQUE(project,session_id),UNIQUE(project,file)
        );
        CREATE TABLE hr_conversation_topics (
          project TEXT NOT NULL,topic_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES hr_conversations(id) ON DELETE CASCADE,
          PRIMARY KEY(conversation_id,topic_id),FOREIGN KEY(project,topic_id) REFERENCES hr_topics(project,id)
        );
        CREATE TABLE hr_entries (
          id TEXT PRIMARY KEY,project TEXT NOT NULL,
          conversation_id TEXT NOT NULL REFERENCES hr_conversations(id) ON DELETE CASCADE,
          entry_id TEXT NOT NULL,parent_id TEXT,timestamp TEXT NOT NULL,role TEXT NOT NULL,line INTEGER NOT NULL,
          hash TEXT NOT NULL,text TEXT NOT NULL,UNIQUE(conversation_id,entry_id)
        );
        CREATE INDEX hr_conversations_project_time ON hr_conversations(project,last_active_at,id);
        CREATE INDEX hr_entries_conversation_time ON hr_entries(conversation_id,timestamp,line);
        CREATE INDEX hr_topic_conversations ON hr_conversation_topics(project,topic_id);
        CREATE VIRTUAL TABLE hr_search USING fts5(row_id UNINDEXED,project UNINDEXED,conversation_id UNINDEXED,body);
        CREATE TABLE hr_jobs (
          project TEXT NOT NULL,file TEXT NOT NULL,directory TEXT NOT NULL,stamp TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,retry_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,token TEXT NOT NULL DEFAULT '',
          PRIMARY KEY(project,file)
        );
        CREATE TABLE hr_chunk_cache (project TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(project,key));
        CREATE TABLE hr_budget (project TEXT NOT NULL,day TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(project,day));
        CREATE TABLE hr_model_calls (id INTEGER PRIMARY KEY,project TEXT NOT NULL,timestamp INTEGER NOT NULL,purpose TEXT NOT NULL,metric TEXT NOT NULL);
        CREATE INDEX hr_calls_project_time ON hr_model_calls(project,timestamp);
        PRAGMA user_version = 3;
      `);
    }).immediate();
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }

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
    const conversations: unknown[] = [];
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
    const selected = options.file ? path.resolve(dir, options.file) : undefined;
    const names = selected ? [path.basename(selected)] : (await fs.readdir(dir)).filter(name => name.endsWith(".jsonl")).sort();
    let queued = 0;
    for (const name of names) {
      options.signal?.throwIfAborted();
      const file = path.join(dir, name);
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      const existing = this.db.query<{ stamp: string }, [string, string]>(
        "SELECT stamp FROM hr_conversations WHERE project=? AND file=?").get(this.project, file);
      if (!options.force && existing?.stamp === stamp) continue;
      this.db.run(`INSERT INTO hr_jobs(project,file,directory,stamp) VALUES (?,?,?,?)
        ON CONFLICT(project,file) DO UPDATE SET stamp=excluded.stamp,attempts=0,error=NULL,retry_at=0,lease_until=0,token=''
        WHERE hr_jobs.stamp<>excluded.stamp OR ?=1`, [this.project, file, dir, stamp, options.force ? 1 : 0]);
      queued++;
    }
    return { discovered: names.length, queued };
  }

  private claim(): Job | null {
    const now = Date.now();
    return this.db.transaction(() => {
      const job = this.db.query<Omit<Job, "token">, [string, number, number]>(
        "SELECT file,stamp,attempts FROM hr_jobs WHERE project=? AND attempts<3 AND retry_at<=? AND lease_until<=? ORDER BY file LIMIT 1")
        .get(this.project, now, now);
      if (!job) return null;
      const token = randomUUID();
      this.db.run("UPDATE hr_jobs SET token=?,lease_until=? WHERE project=? AND file=?",
        [token, now + 120_000, this.project, job.file]);
      return { ...job, token };
    }).immediate();
  }

  async work(model: JsonModel, options: { maxJobs?: number; maxCalls?: number; maxDailyCalls?: number; signal?: AbortSignal } = {}) {
    // Budgets count prepared conversations, not model calls: one conversation may
    // now fan out into several chunk calls during map-reduce indexing.
    let completed = 0, failed = 0, prepared = 0;
    const errors: { file: string; code: string }[] = [];
    const maxJobs = options.maxJobs ?? 1, maxConversations = options.maxCalls ?? 12, maxDailyCalls = options.maxDailyCalls ?? 60;
    for (const value of [maxJobs, maxConversations, maxDailyCalls]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new RecallError("invalid_budget", "Work budgets must be integers between 1 and 10000.");
    }
    for (let index = 0; index < maxJobs && prepared < maxConversations; index++) {
      options.signal?.throwIfAborted();
      const job = this.claim();
      if (!job) break;
      const requestKeys: string[] = [];
      const heartbeat = setInterval(() => {
        try { if (!this.closed) this.db.run("UPDATE hr_jobs SET lease_until=? WHERE project=? AND file=? AND token=?",
          [Date.now() + 120_000, this.project, job.file, job.token]); }
        catch { /* Publication checks lease ownership again. */ }
      }, 30_000);
      heartbeat.unref();
      const budgeted: JsonModel = {
        identity: model.identity,
        contextWindow: model.contextWindow,
        generate: async (...args) => {
          args[2]?.throwIfAborted();
          const key = digest(JSON.stringify(["request", SEMANTIC_VERSION, model.identity, args[0], args[1]]));
          const cached = this.db.query<{ payload: string }, [string, string]>(
            "SELECT payload FROM hr_chunk_cache WHERE project=? AND key=?").get(this.project, key);
          if (cached) return JSON.parse(cached.payload) as string;
          const day = new Date().toISOString().slice(0, 10);
          const reserved = this.db.query<{ calls: number }, [string, string, number]>(`
            INSERT INTO hr_budget(project,day,calls) VALUES (?,?,1)
            ON CONFLICT(project,day) DO UPDATE SET calls=calls+1 WHERE calls<? RETURNING calls`).get(this.project, day, maxDailyCalls);
          if (!reserved) throw new RecallError("daily_budget", "Daily indexing conversation budget reached; work resumes after UTC midnight.");
          let result = await model.generate(...args);
          try { result = redactJson(result); } catch { return result; }
          this.db.run("INSERT OR REPLACE INTO hr_chunk_cache VALUES (?,?,?,?)", [this.project, key, JSON.stringify(result), Date.now()]);
          requestKeys.push(key);
          return result;
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
        const cacheKey = digest(JSON.stringify([model.identity, SEMANTIC_VERSION, source.fingerprint]));
        const cached = this.db.query<{ payload: string }, [string, string]>(
          "SELECT payload FROM hr_chunk_cache WHERE project=? AND key=?").get(this.project, cacheKey);
        const vocabulary = this.topicVocabulary();
        const semantic = cached ? JSON.parse(cached.payload)
          : await indexConversation(budgeted, source, facts, { signal: options.signal, vocabulary });
        if (!cached) {
          prepared++;
          this.db.run("INSERT OR REPLACE INTO hr_chunk_cache VALUES (?,?,?,?)",
            [this.project, cacheKey, JSON.stringify(semantic), Date.now()]);
        }
        const current = await loadSource(job.file, { signal: options.signal });
        if (current.fingerprint !== source.fingerprint) throw new RecallError("source_busy", "Source changed during preparation.");
        this.publish(source, facts, semantic, model.identity, job);
        completed++;
      } catch (error) {
        const code = error instanceof RecallError ? error.code : options.signal?.aborted ? "cancelled" : "index_error";
        const retryable = ["cancelled", "work_budget", "source_busy", "daily_budget"].includes(code);
        if (code === "invalid_model_output") for (const key of requestKeys) this.db.run("DELETE FROM hr_chunk_cache WHERE project=? AND key=?", [this.project, key]);
        this.db.run(`UPDATE hr_jobs SET token='',lease_until=0,attempts=attempts+?,error=?,retry_at=? WHERE project=? AND file=? AND token=?`,
          [retryable ? 0 : 1, code, code === "daily_budget" ? Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000
            : Date.now() + (retryable ? 1000 : 30_000 * (job.attempts + 1)), this.project, job.file, job.token]);
        if (options.signal?.aborted) throw error;
        failed++;
        errors.push({ file: job.file, code });
      } finally { clearInterval(heartbeat); }
    }
    return { completed, failed, calls: prepared, errors };
  }

  private publish(
    source: SessionSource,
    facts: ReturnType<typeof conversationFacts>,
    semantic: { summary: string; topics: { title: string; description: string; aliases: string[] }[] },
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
        // Aliases accumulate monotonically across conversations instead of being overwritten.
        const aliases = [...new Set([...(existing ? JSON.parse(existing.aliases) as string[] : []), ...topic.aliases])].slice(0, 24);
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
        "SELECT id,title,description,aliases FROM hr_topics WHERE project=? ORDER BY updated_at DESC LIMIT 80")
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
    const range = timeRange(options);
    const pred = this.predicate(range);
    const revision = this.revision();
    const binding = digest(JSON.stringify([revision, options.days, options.from, options.to, options.topic_id]));
    let offset = 0;
    if (options.cursor) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString()); } catch {}
      if (options.cursor.length > 512 || !cursor || cursor.b !== binding || !Number.isSafeInteger(cursor.o) || cursor.o < 0) {
        throw new RecallError("stale_cursor", "Directory changed or filters differ; restart without a cursor.");
      }
      if (!cursor.r || typeof cursor.r !== "object") throw new RecallError("stale_cursor", "Cursor is missing its frozen time range.");
      offset = cursor.o;
      range.from = cursor.r.from; range.to = cursor.r.to;
    }
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
      const grouped = this.db.query<{ id: string; title: string; description: string; aliases: string; conversation_id: string }, (string | null)[]>(`
        SELECT t.*,c.id AS conversation_id FROM hr_topics t
        JOIN hr_conversation_topics ct ON ct.project=t.project AND ct.topic_id=t.id
        JOIN hr_conversations c ON c.id=ct.conversation_id
        WHERE ${pred.sql} ORDER BY t.id,c.last_active_at DESC`)
        .all(...pred.args)
        .reduce<Record<string, { topic: TopicRow; conversations: ConversationRow[] }>>((accumulator, row) => {
          const topic = { id: row.id, title: row.title, description: row.description, aliases: row.aliases };
          accumulator[row.id] ??= { topic, conversations: [] };
          accumulator[row.id].conversations.push(
            this.db.query<ConversationRow, [string]>("SELECT * FROM hr_conversations WHERE id=?").get(row.conversation_id)!);
          return accumulator;
        }, {});
      rows = Object.values(grouped).map(({ topic, conversations }) => topicPresentation(topic, conversations)).slice(offset, offset + limit + 1);
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
