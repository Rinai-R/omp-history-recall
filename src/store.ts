import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { digest, lexicalTerms, loadSource, readSourceEvidence, RecallError, type SessionSource } from "./source";
import { timeRange, type TimeFilter, type TimeRange } from "./time";
import { openHistoryDatabase } from "./database";
import {
  enumerateSources, validateSourceFile,
  type RecallScope, type SourceAccess, type SourceFileInfo, type SourceWarning,
} from "./scope";

type ConversationRow = {
  id: string; session_id: string; file: string; source_cwd: string;
  source_hash: string; title: string; started_at: string; last_active_at: string;
  entry_count: number; message_count: number; user_turn_count: number; branch_count: number;
  size_bytes: number;
};
type FileRow = { file: string; stamp: string; error: string | null };
type LiveMeta = {
  session_id: string; file: string; stamp: string;
  indexed_size: number; indexed_lines: number; entry_count: number; updated_at: string;
};

const LIVE_INDEX_DEFAULT_BYTES = 4 * 1024 * 1024;
const LIVE_SCAN_MAX_ENTRIES = 20_000;
const LIVE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function liveIndexBytes(): number {
  const raw = process.env.OMP_HISTORY_RECALL_LIVE_INDEX_BYTES;
  if (raw === undefined) return LIVE_INDEX_DEFAULT_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 65_536 || value > 128 * 1024 * 1024) {
    throw new RecallError("invalid_budget", "OMP_HISTORY_RECALL_LIVE_INDEX_BYTES must be an integer from 65536 to 134217728.");
  }
  return value;
}

export type CatalogEntry = SourceFileInfo & {
  indexed: boolean; conversation_id: string | null; session_id: string | null;
  title: string | null; description: string | null; source_cwd: string | null;
  time_basis: "filesystem" | "indexed"; started_at: string | null; last_active_at: string | null;
};
export type CatalogResult = {
  scope_id: string; conversations: CatalogEntry[]; next_cursor: string | null; warnings: SourceWarning[];
};
export type SyncFailure = { path: string; code: string };
export type SyncResult = {
  ingested: number; skipped: number; failed: number; pending: number;
  warnings: SourceWarning[]; failures: SyncFailure[];
};
export type SearchOptions = TimeFilter & {
  source_cwd?: string; conversation_id?: string; session_id?: string;
  limit?: number; cursor?: string; signal?: AbortSignal;
};
export type CurrentSessionMatch = { entry_id: string; line: number; timestamp: string; kind: string };
export type PresentedConversation = {
  id: string; session_id: string; title: string; description: string;
  started_at: string; last_active_at: string; entry_count: number; message_count: number;
  user_turn_count: number; branch_count: number; size_bytes: number;
  source_file: string; source_cwd: string;
};
export type SearchHit = PresentedConversation & { matched_entry_ids: string[]; lexical_hits: number };
export type SearchResult = {
  mode: "lexical" | "current-session";
  range: TimeRange; pending_files: number; failures: SyncFailure[];
  warnings: SourceWarning[]; evidence_required: true;
  conversations: SearchHit[]; next_cursor: string | null;
  strategy?: "scan" | "index";
  session_id?: string;
  source_file?: string;
  indexed_entries?: number;
  matched_entry_ids?: string[];
  matches?: CurrentSessionMatch[];
};

function pageLimit(value = 10): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new RecallError("invalid_limit", "limit must be between 1 and 50.");
  return value;
}

function decodeOffsetCursor(cursor: string, binding: string): number {
  if (cursor.length > 1024) throw new RecallError("stale_cursor", "Cursor is too long.");
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!value || typeof value !== "object" || !("b" in value) || value.b !== binding
      || !("o" in value) || typeof value.o !== "number" || !Number.isSafeInteger(value.o) || value.o < 0) throw new Error();
    return value.o;
  } catch {
    throw new RecallError("stale_cursor", "Index changed, filters differ, or cursor is invalid; restart without a cursor.");
  }
}

function encodeOffsetCursor(binding: string, offset: number): string {
  return Buffer.from(JSON.stringify({ b: binding, o: offset })).toString("base64url");
}

function present(row: ConversationRow): PresentedConversation {
  return {
    id: row.id, session_id: row.session_id, title: row.title,
    description: `${row.message_count} messages, ${row.user_turn_count} user turns, ${row.branch_count} extra branch(es).`,
    started_at: row.started_at, last_active_at: row.last_active_at,
    entry_count: row.entry_count, message_count: row.message_count,
    user_turn_count: row.user_turn_count, branch_count: row.branch_count,
    size_bytes: row.size_bytes, source_file: row.file, source_cwd: row.source_cwd,
  };
}

function failureCode(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return "cancelled";
  return error instanceof RecallError ? error.code : "index_error";
}

export class HistoryStore {
  readonly db: Database;
  readonly excludedSessionId: string;
  private access: SourceAccess;
  private closed = false;

  constructor(readonly dbPath: string, readonly scope: RecallScope, access: SourceAccess) {
    this.access = { ...access };
    this.excludedSessionId = access.activeSessionId;
    this.db = openHistoryDatabase(dbPath);
    this.db.run("INSERT OR IGNORE INTO hr_scopes(scope_id,revision) VALUES (?,0)", [scope.id]);
    this.pruneLiveIndexes();
  }

  setSourceAccess(access: SourceAccess): void {
    if (access.activeSessionId !== this.excludedSessionId) {
      throw new RecallError("scope_conflict", "Create a new store when the active session changes.");
    }
    this.access = { ...access };
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  private knownFiles(): string[] {
    return this.db.query<{ file: string }, [string]>("SELECT file FROM hr_files WHERE scope_id=?")
      .all(this.scope.id).map(row => row.file);
  }

  private async sources(signal?: AbortSignal) {
    return enumerateSources(this.scope, this.access, this.knownFiles(), signal);
  }

  private currentSessionFile(): string {
    if (!this.access.activeFile) throw new RecallError("not_found", "The current session is not file-backed.");
    return this.access.activeFile;
  }

  /** Drop live indexes whose session ended long ago or whose file disappeared. */
  private pruneLiveIndexes(): void {
    const cutoff = new Date(Date.now() - LIVE_RETENTION_MS).toISOString();
    const rows = this.db.query<LiveMeta, []>("SELECT * FROM hr_live_files").all();
    for (const row of rows) {
      if (row.updated_at >= cutoff && existsSync(row.file)) continue;
      this.db.transaction(() => {
        this.db.run("DELETE FROM hr_live_search WHERE session_id=?", [row.session_id]);
        this.db.run("DELETE FROM hr_live_entries WHERE session_id=?", [row.session_id]);
        this.db.run("DELETE FROM hr_live_files WHERE session_id=?", [row.session_id]);
      })();
    }
  }

  private writeLiveMeta(sessionId: string, source: SessionSource, stamp: string, indexedLines: number, entryCount: number): void {
    this.db.run(`INSERT INTO hr_live_files(session_id,file,stamp,indexed_size,indexed_lines,entry_count,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      file=excluded.file,stamp=excluded.stamp,indexed_size=excluded.indexed_size,
      indexed_lines=excluded.indexed_lines,entry_count=excluded.entry_count,updated_at=excluded.updated_at`, [
      sessionId, source.file, stamp, source.sizeBytes, indexedLines, entryCount, new Date().toISOString(),
    ]);
  }

  /** Ensure the current session's shadow FTS index matches the file, touching only new rows. */
  private ensureLiveIndex(source: SessionSource, stamp: string): { indexed_entries: number; indexed_lines: number } {
    const sessionId = source.sessionId;
    const meta = this.db.query<LiveMeta, [string]>("SELECT * FROM hr_live_files WHERE session_id=?").get(sessionId);
    if (meta && meta.stamp === stamp) {
      return { indexed_entries: meta.entry_count, indexed_lines: meta.indexed_lines };
    }
    const maxLine = source.entries.at(-1)?.line ?? 0;
    const rebuild = !meta || source.sizeBytes < meta.indexed_size
      || source.sizeBytes === meta.indexed_size
      || source.entries.length <= meta.entry_count;
    const insert = this.db.transaction(() => {
      const insertEntry = this.db.prepare(`INSERT INTO hr_live_entries(session_id,row_id,entry_id,line,timestamp,kind,hash,text)
        VALUES (?,?,?,?,?,?,?,?)`);
      const insertSearch = this.db.prepare("INSERT INTO hr_live_search(row_id,session_id,body) VALUES (?,?,?)");
      const entries = rebuild ? source.entries : source.entries.filter(entry => entry.line > meta.indexed_lines);
      if (rebuild) {
        this.db.run("DELETE FROM hr_live_search WHERE session_id=?", [sessionId]);
        this.db.run("DELETE FROM hr_live_entries WHERE session_id=?", [sessionId]);
      }
      for (const entry of entries) {
        const rowId = `l_${digest(JSON.stringify([sessionId, entry.id])).slice(0, 24)}`;
        insertEntry.run(sessionId, rowId, entry.id, entry.line, entry.timestamp,
          entry.role || entry.type, entry.hash, entry.text);
        if (entry.text.trim()) insertSearch.run(rowId, sessionId, lexicalTerms(entry.text).join(" "));
      }
      this.writeLiveMeta(sessionId, source, stamp, Math.max(meta?.indexed_lines ?? 0, maxLine), source.entries.length);
    });
    insert.immediate();
    return { indexed_entries: source.entries.length, indexed_lines: Math.max(meta?.indexed_lines ?? 0, maxLine) };
  }

  private dropLiveIndex(sessionId: string): void {
    if (!this.db.query("SELECT 1 FROM hr_live_files WHERE session_id=?").get(sessionId)) return;
    this.db.transaction(() => {
      this.db.run("DELETE FROM hr_live_search WHERE session_id=?", [sessionId]);
      this.db.run("DELETE FROM hr_live_entries WHERE session_id=?", [sessionId]);
      this.db.run("DELETE FROM hr_live_files WHERE session_id=?", [sessionId]);
    })();
  }

  private scanCurrentMatches(
    source: SessionSource, terms: readonly string[], limit: number, range: TimeRange,
  ): CurrentSessionMatch[] {
    const wanted = new Set(terms);
    const matches: CurrentSessionMatch[] = [];
    for (let index = source.entries.length - 1; index >= 0 && matches.length < limit; index--) {
      const entry = source.entries[index];
      if (!entry.text.trim()) continue;
      if (range.from !== null && entry.timestamp < range.from) continue;
      if (range.to !== null && entry.timestamp >= range.to) continue;
      if (!lexicalTerms(entry.text).some(term => wanted.has(term))) continue;
      matches.push({ entry_id: entry.id, line: entry.line, timestamp: entry.timestamp, kind: entry.role || entry.type });
    }
    return matches;
  }

  private liveMatches(
    sessionId: string, terms: readonly string[], limit: number, range: TimeRange,
  ): CurrentSessionMatch[] {
    const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    return this.db.query<CurrentSessionMatch & { hits: number }, (string | null | number)[]>(`
      SELECT e.entry_id,e.line,e.timestamp,e.kind,COUNT(*) AS hits
      FROM hr_live_search f JOIN hr_live_entries e ON e.session_id=f.session_id AND e.row_id=f.row_id
      WHERE hr_live_search MATCH ? AND f.session_id=?
        AND (? IS NULL OR e.timestamp>=?) AND (? IS NULL OR e.timestamp<?)
      GROUP BY e.row_id ORDER BY hits DESC,e.line DESC LIMIT ?`)
      .all(match, sessionId, range.from, range.from, range.to, range.to, limit)
      .map(({ entry_id, line, timestamp, kind }) => ({ entry_id, line, timestamp, kind }));
  }

  private async searchCurrentSession(
    inputQueries: readonly string[], options: SearchOptions,
  ): Promise<SearchResult> {
    const file = this.currentSessionFile();
    const terms = lexicalTerms(inputQueries.join(" ")).slice(0, 128);
    if (terms.length === 0) throw new RecallError("invalid_query", "queries contain no searchable terms.");
    const range = timeRange(options);
    const limit = pageLimit(options.limit);
    const stat = await fs.stat(file);
    const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    const meta = this.db.query<LiveMeta, [string]>("SELECT * FROM hr_live_files WHERE session_id=?")
      .get(this.excludedSessionId);
    const strategy = stat.size <= liveIndexBytes()
      && (!meta || meta.stamp !== stamp || meta.entry_count <= LIVE_SCAN_MAX_ENTRIES)
      ? "scan" : "index";
    if (strategy === "index" && meta?.stamp === stamp && path.resolve(meta.file) === path.resolve(file)) {
      const matches = this.liveMatches(this.excludedSessionId, terms, limit, range);
      return {
        mode: "current-session", strategy, session_id: this.excludedSessionId, source_file: meta.file,
        indexed_entries: meta.entry_count, matched_entry_ids: matches.map(match => match.entry_id), matches,
        range, pending_files: 0, failures: [], warnings: [], conversations: [], next_cursor: null,
        evidence_required: true,
      };
    }
    const source = await loadSource(file, { signal: options.signal });
    if (source.sessionId !== this.excludedSessionId) {
      throw new RecallError("stale_evidence", "The current session file no longer matches the active session.");
    }
    if (strategy === "scan") this.dropLiveIndex(source.sessionId);
    const indexedEntries = strategy === "scan" ? source.entries.length : this.ensureLiveIndex(source, stamp).indexed_entries;
    const matches = strategy === "scan"
      ? this.scanCurrentMatches(source, terms, limit, range)
      : this.liveMatches(source.sessionId, terms, limit, range);
    return {
      mode: "current-session", strategy, session_id: source.sessionId, source_file: source.file,
      indexed_entries: indexedEntries, matched_entry_ids: matches.map(match => match.entry_id), matches,
      range, pending_files: 0, failures: [], warnings: [], conversations: [], next_cursor: null,
      evidence_required: true,
    };
  }

  async sync(options: { maxFiles?: number; maxBytes?: number; signal?: AbortSignal } = {}): Promise<SyncResult> {
    const maxFiles = options.maxFiles ?? 64;
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 10_000) {
      throw new RecallError("invalid_budget", "maxFiles must be an integer from 1 to 10000.");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_073_741_824) {
      throw new RecallError("invalid_budget", "maxBytes must be an integer from 1 to 1073741824.");
    }
    const { files, warnings } = await this.sources(options.signal);
    const known = new Map(this.db.query<FileRow, [string]>(
      "SELECT file,stamp,error FROM hr_files WHERE scope_id=?").all(this.scope.id)
      .map(row => [row.file, row]));
    const retryable = new Set(["active_session", "duplicate_session", "source_identity_changed"]);
    const candidates = files.filter(file => {
      const stamp = `${file.mtime_ms}:${file.size_bytes}`;
      const row = known.get(file.source_file);
      if (!row) return true;
      // Identity conflicts clear without a file change once the other side moves
      // or disappears; the active-session file becomes eligible after a switch.
      if (row.error && retryable.has(row.error)) return true;
      return row.stamp !== stamp;
    }).sort((left, right) =>
      right.mtime_ms - left.mtime_ms || (left.source_file < right.source_file ? -1 : left.source_file > right.source_file ? 1 : 0));

    let ingested = 0, skipped = 0, failed = 0, bytes = 0, attempted = 0;
    const failures: SyncFailure[] = [];
    for (const file of candidates) {
      options.signal?.throwIfAborted();
      if (attempted >= maxFiles || bytes >= maxBytes) break;
      attempted++;
      const stamp = `${file.mtime_ms}:${file.size_bytes}`;
      try {
        await validateSourceFile(file.source_file, files, options.signal);
        const source = await loadSource(file.source_file, { signal: options.signal });
        if (source.sessionId === this.excludedSessionId) {
          this.recordFile(file, stamp, "active_session");
          skipped++;
          continue;
        }
        await this.checkSourceIdentity(source);
        this.publish(source);
        ingested++;
        bytes += source.sizeBytes;
      } catch (error) {
        const code = failureCode(error, options.signal);
        if (code === "cancelled") throw error;
        this.recordFile(file, stamp, code);
        failed++;
        failures.push({ path: file.source_file, code });
      }
    }
    return {
      ingested, skipped, failed, pending: candidates.length - attempted,
      warnings, failures,
    };
  }

  private recordFile(file: SourceFileInfo, stamp: string, error: string | null): void {
    this.db.run(`INSERT INTO hr_files(scope_id,file,directory,stamp,indexed_at,error) VALUES (?,?,?,?,?,?)
      ON CONFLICT(scope_id,file) DO UPDATE SET stamp=excluded.stamp,error=excluded.error,
        directory=excluded.directory,indexed_at=CASE WHEN excluded.error IS NULL THEN excluded.indexed_at ELSE hr_files.indexed_at END`,
      [this.scope.id, file.source_file, file.directory, stamp, error === null ? new Date().toISOString() : null, error]);
  }

  private async checkSourceIdentity(source: SessionSource): Promise<void> {
    const atPath = this.db.query<{ session_id: string }, [string, string]>(
      "SELECT session_id FROM hr_conversations WHERE scope_id=? AND file=?").get(this.scope.id, source.file);
    if (atPath && atPath.session_id !== source.sessionId) {
      throw new RecallError("source_identity_changed", "This path now claims a different session; the previous index is retained.");
    }
    const duplicate = this.db.query<{ file: string }, [string, string]>(
      "SELECT file FROM hr_conversations WHERE scope_id=? AND session_id=?").get(this.scope.id, source.sessionId);
    if (duplicate && duplicate.file !== source.file) {
      try {
        await fs.lstat(duplicate.file);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      throw new RecallError("duplicate_session", "Two existing files claim the same session identity.");
    }
  }

  private publish(source: SessionSource): void {
    const id = `c_${digest(JSON.stringify([this.scope.id, source.sessionId])).slice(0, 24)}`;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const previous = this.db.query<{ file: string; source_hash: string }, [string, string]>(
        "SELECT file,source_hash FROM hr_conversations WHERE scope_id=? AND id=?").get(this.scope.id, id);
      if (previous && previous.file !== source.file) {
        this.db.run("DELETE FROM hr_files WHERE scope_id=? AND file=?", [this.scope.id, previous.file]);
      }
      const atPath = this.db.query<{ id: string }, [string, string]>(
        "SELECT id FROM hr_conversations WHERE scope_id=? AND file=?").get(this.scope.id, source.file);
      if (atPath && atPath.id !== id) {
        this.db.run("DELETE FROM hr_search WHERE scope_id=? AND conversation_id=?", [this.scope.id, atPath.id]);
        this.db.run("DELETE FROM hr_conversations WHERE scope_id=? AND id=?", [this.scope.id, atPath.id]);
      }
      this.db.run(`INSERT INTO hr_conversations(scope_id,id,session_id,file,directory,stamp,source_cwd,source_hash,
        title,started_at,last_active_at,entry_count,message_count,user_turn_count,branch_count,size_bytes,indexed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_id,id) DO UPDATE SET
        session_id=excluded.session_id,file=excluded.file,directory=excluded.directory,stamp=excluded.stamp,
        source_cwd=excluded.source_cwd,source_hash=excluded.source_hash,title=excluded.title,
        started_at=excluded.started_at,last_active_at=excluded.last_active_at,entry_count=excluded.entry_count,
        message_count=excluded.message_count,user_turn_count=excluded.user_turn_count,
        branch_count=excluded.branch_count,size_bytes=excluded.size_bytes,indexed_at=excluded.indexed_at`, [
        this.scope.id, id, source.sessionId, source.file, path.dirname(source.file), source.stamp, source.cwd,
        source.fingerprint, source.title, source.entries[0]?.timestamp ?? source.timestamp,
        source.entries.at(-1)?.timestamp ?? source.timestamp,
        source.entries.length, source.entries.filter(entry => entry.type === "message").length,
        source.entries.filter(entry => entry.type === "message" && entry.role === "user").length,
        branchCount(source), source.sizeBytes, now,
      ]);
      if (previous?.source_hash !== source.fingerprint) {
        this.db.run("DELETE FROM hr_search WHERE scope_id=? AND conversation_id=?", [this.scope.id, id]);
        this.db.run("DELETE FROM hr_entries WHERE scope_id=? AND conversation_id=?", [this.scope.id, id]);
        const insertEntry = this.db.prepare(`INSERT INTO hr_entries(scope_id,id,conversation_id,entry_id,parent_id,
          timestamp,kind,line,hash,text) VALUES (?,?,?,?,?,?,?,?,?,?)`);
        const insertSearch = this.db.prepare("INSERT INTO hr_search(row_id,scope_id,conversation_id,body) VALUES (?,?,?,?)");
        for (const entry of source.entries) {
          const rowId = `e_${digest(JSON.stringify([this.scope.id, source.sessionId, entry.id])).slice(0, 24)}`;
          insertEntry.run(this.scope.id, rowId, id, entry.id, entry.parentId, entry.timestamp,
            entry.role || entry.type, entry.line, entry.hash, entry.text);
          if (entry.text.trim()) insertSearch.run(rowId, this.scope.id, id, lexicalTerms(entry.text).join(" "));
        }
      }
      this.db.run(`INSERT INTO hr_files(scope_id,file,directory,stamp,indexed_at,error) VALUES (?,?,?,?,?,NULL)
        ON CONFLICT(scope_id,file) DO UPDATE SET stamp=excluded.stamp,directory=excluded.directory,
          indexed_at=excluded.indexed_at,error=NULL`,
        [this.scope.id, source.file, path.dirname(source.file), source.stamp, now]);
      this.db.run("UPDATE hr_scopes SET revision=revision+1 WHERE scope_id=?", [this.scope.id]);
    }).immediate();
  }

  async catalog(options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<CatalogResult> {
    const limit = pageLimit(options.limit);
    const { files, warnings } = await this.sources(options.signal);
    options.signal?.throwIfAborted();
    files.sort((left, right) =>
      right.mtime_ms - left.mtime_ms || (left.source_file < right.source_file ? -1 : left.source_file > right.source_file ? 1 : 0));
    return this.db.transaction(() => {
      const binding = digest(JSON.stringify([this.scope.id, this.access.activeFile, this.excludedSessionId, limit,
        this.revision(), files.map(file => [file.source_file, file.mtime_ms, file.size_bytes])]));
      const offset = options.cursor ? decodeOffsetCursor(options.cursor, binding) : 0;
      const indexed = new Map(this.db.query<ConversationRow, [string]>(
        "SELECT * FROM hr_conversations WHERE scope_id=?").all(this.scope.id).map(row => [row.file, row]));
      const visible = files.filter(file => indexed.get(file.source_file)?.session_id !== this.excludedSessionId);
      if (offset > visible.length) throw new RecallError("stale_cursor", "The catalog cursor is outside this source snapshot.");
      const conversations = visible.slice(offset, offset + limit).map((file): CatalogEntry => {
        const row = indexed.get(file.source_file);
        return {
          ...file, indexed: row !== undefined, conversation_id: row?.id ?? null,
          session_id: row?.session_id ?? null, title: row?.title ?? null,
          description: row ? present(row).description : null, source_cwd: row?.source_cwd ?? null,
          time_basis: row ? "indexed" : "filesystem", started_at: row?.started_at ?? null,
          last_active_at: row?.last_active_at ?? null,
        };
      });
      return {
        scope_id: this.scope.id, conversations, warnings,
        next_cursor: offset + limit < visible.length ? encodeOffsetCursor(binding, offset + limit) : null,
      };
    })();
  }

  async search(inputQueries: readonly string[], options: SearchOptions = {}): Promise<SearchResult> {
    if (!Array.isArray(inputQueries) || inputQueries.length < 1 || inputQueries.length > 8) {
      throw new RecallError("invalid_query", "queries must contain 1 to 8 strings.");
    }
    if (inputQueries.some(query => typeof query !== "string" || !query.trim() || query.length > 2000)) {
      throw new RecallError("invalid_query", "each query must contain 1 to 2000 characters.");
    }
    options.signal?.throwIfAborted();
    if (options.session_id !== undefined && options.session_id === this.excludedSessionId) {
      return this.searchCurrentSession(inputQueries, options);
    }
    const sync = await this.sync({ maxFiles: 16, signal: options.signal });
    const terms = lexicalTerms(inputQueries.join(" ")).slice(0, 128);
    if (terms.length === 0) throw new RecallError("invalid_query", "queries contain no searchable terms.");
    const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const range = timeRange(options);
    const limit = pageLimit(options.limit);
    const binding = digest(JSON.stringify([
      this.scope.id, this.excludedSessionId, terms, range.from, range.to,
      options.source_cwd ?? null, options.conversation_id ?? null, options.session_id ?? null, limit, this.revision(),
    ]));
    const offset = options.cursor ? decodeOffsetCursor(options.cursor, binding) : 0;
    const predicate = {
      sql: `c.scope_id=? AND c.session_id<>? AND (? IS NULL OR c.last_active_at>=?) AND (? IS NULL OR c.started_at<?)
        AND (? IS NULL OR c.source_cwd=?) AND (? IS NULL OR c.id=?) AND (? IS NULL OR c.session_id=?)`,
      args: [this.scope.id, this.excludedSessionId, range.from, range.from, range.to, range.to,
        options.source_cwd ?? null, options.source_cwd ?? null, options.conversation_id ?? null, options.conversation_id ?? null,
        options.session_id ?? null, options.session_id ?? null],
    };
    const { rows, conversations } = this.db.transaction(() => {
      const rows = this.db.query(`
        SELECT c.id,COUNT(*) AS hits FROM hr_search f
        JOIN hr_conversations c ON c.scope_id=f.scope_id AND c.id=f.conversation_id
        WHERE hr_search MATCH ? AND ${predicate.sql}
        GROUP BY c.id ORDER BY hits DESC,c.last_active_at DESC,c.id LIMIT ? OFFSET ?`)
        .all(match, ...predicate.args, limit + 1, offset) as { id: string; hits: number }[];
      return {
        rows,
        conversations: rows.slice(0, limit).map(row => {
          const conversation = this.db.query<ConversationRow, [string, string]>(
            "SELECT * FROM hr_conversations WHERE scope_id=? AND id=?").get(this.scope.id, row.id)!;
          const matched = this.db.query<{ entry_id: string }, [string, string, string]>(`
            SELECT e.entry_id FROM hr_search f JOIN hr_entries e ON e.scope_id=f.scope_id AND e.id=f.row_id
            WHERE hr_search MATCH ? AND f.scope_id=? AND f.conversation_id=? ORDER BY e.timestamp,e.line LIMIT 20`)
            .all(match, this.scope.id, row.id).map(value => value.entry_id);
          return { ...present(conversation), matched_entry_ids: matched, lexical_hits: row.hits };
        }),
      };
    })();
    return {
      mode: "lexical", range, pending_files: sync.pending, failures: sync.failures,
      warnings: sync.warnings, conversations,
      next_cursor: rows.length > limit ? encodeOffsetCursor(binding, offset + limit) : null,
      evidence_required: true,
    };
  }

  async readConversation(conversationId: string | undefined, options: {
    session_id?: string; cursor?: string; maxChars?: number; entry_id?: string;
    before?: number; after?: number; last?: number; signal?: AbortSignal;
  } = {}) {
    if (options.session_id !== undefined && options.session_id === this.excludedSessionId) {
      const source = await loadSource(this.currentSessionFile(), { signal: options.signal });
      if (source.sessionId !== this.excludedSessionId) {
        throw new RecallError("stale_evidence", "The current session file no longer matches the active session.");
      }
      return {
        ...readSourceEvidence(`current_${source.sessionId}`, source, options),
        mode: "current-session", id: null, session_id: source.sessionId, title: source.title,
        source_cwd: source.cwd, source_hash: source.fingerprint, entry_count: source.entries.length,
      };
    }
    let conversation: ConversationRow | null = null;
    if (conversationId !== undefined) {
      conversation = this.db.query<ConversationRow, [string, string, string]>(
        "SELECT * FROM hr_conversations WHERE scope_id=? AND id=? AND session_id<>?")
        .get(this.scope.id, conversationId, this.excludedSessionId);
    } else if (options.session_id !== undefined) {
      conversation = this.db.query<ConversationRow, [string, string, string]>(
        "SELECT * FROM hr_conversations WHERE scope_id=? AND session_id=? AND session_id<>?")
        .get(this.scope.id, options.session_id, this.excludedSessionId);
    } else {
      throw new RecallError("invalid_query", "Provide conversation_id or session_id.");
    }
    if (!conversation) throw new RecallError("not_found", "Conversation is unavailable or belongs to the active session.");
    const { files } = await this.sources(options.signal);
    await validateSourceFile(conversation.file, files, options.signal);
    const source = await loadSource(conversation.file, { signal: options.signal });
    if (source.sessionId !== conversation.session_id || source.fingerprint !== conversation.source_hash) {
      throw new RecallError("stale_evidence", "Conversation changed after indexing; run sync before reading.");
    }
    return {
      ...present(conversation), source_hash: conversation.source_hash,
      ...readSourceEvidence(this.scope.id, source, options),
    };
  }

  revision(): number {
    return this.db.query<{ revision: number }, [string]>("SELECT revision FROM hr_scopes WHERE scope_id=?")
      .get(this.scope.id)!.revision;
  }

  async status(): Promise<{
    scope_id: string; schema: 6; revision: number; conversations: number; indexed_entries: number;
    pending_files: number; failed_files: number; last_indexed_at: string | null;
  }> {
    const { files } = await this.sources();
    const known = new Map(this.db.query<FileRow, [string]>(
      "SELECT file,stamp,error FROM hr_files WHERE scope_id=?").all(this.scope.id).map(row => [row.file, row]));
    const pending = files.filter(file => {
      const row = known.get(file.source_file);
      return !row || row.stamp !== `${file.mtime_ms}:${file.size_bytes}`;
    }).length;
    return {
      scope_id: this.scope.id, schema: 6, revision: this.revision(),
      conversations: this.db.query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM hr_conversations WHERE scope_id=? AND session_id<>?")
        .get(this.scope.id, this.excludedSessionId)!.n,
      indexed_entries: this.db.query<{ n: number }, [string, string]>(`
        SELECT COUNT(*) AS n FROM hr_entries e JOIN hr_conversations c
        ON c.scope_id=e.scope_id AND c.id=e.conversation_id WHERE c.scope_id=? AND c.session_id<>?`)
        .get(this.scope.id, this.excludedSessionId)!.n,
      pending_files: pending,
      failed_files: this.db.query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM hr_files WHERE scope_id=? AND error IS NOT NULL AND error<>'active_session'")
        .get(this.scope.id)!.n,
      last_indexed_at: this.db.query<{ value: string | null }, [string]>(
        "SELECT MAX(indexed_at) AS value FROM hr_conversations WHERE scope_id=?").get(this.scope.id)!.value,
    };
  }
}

function branchCount(source: SessionSource): number {
  const children = new Map<string | null, number>();
  for (const entry of source.entries) children.set(entry.parentId, (children.get(entry.parentId) ?? 0) + 1);
  let branches = 0;
  for (const count of children.values()) if (count > 1) branches += count - 1;
  return branches;
}
