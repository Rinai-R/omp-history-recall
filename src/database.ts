import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { RecallError } from "./source";

const SCHEMA = `
  CREATE TABLE hr_scopes (
    scope_id TEXT NOT NULL PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE hr_conversations (
    scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),id TEXT NOT NULL,session_id TEXT NOT NULL,
    file TEXT NOT NULL,directory TEXT NOT NULL,stamp TEXT NOT NULL,source_cwd TEXT NOT NULL,source_hash TEXT NOT NULL,
    title TEXT NOT NULL,summary TEXT NOT NULL,started_at TEXT NOT NULL,last_active_at TEXT NOT NULL,
    entry_count INTEGER NOT NULL,message_count INTEGER NOT NULL,user_turn_count INTEGER NOT NULL,
    branch_count INTEGER NOT NULL,active_windows TEXT NOT NULL,size_bytes INTEGER NOT NULL,model TEXT NOT NULL,
    indexed_at TEXT NOT NULL,PRIMARY KEY(scope_id,id),UNIQUE(scope_id,session_id),UNIQUE(scope_id,file)
  );
  CREATE TABLE hr_facets (
    scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),conversation_id TEXT NOT NULL,id TEXT NOT NULL,
    title TEXT NOT NULL,description TEXT NOT NULL,aliases TEXT NOT NULL,evidence TEXT NOT NULL,
    PRIMARY KEY(scope_id,conversation_id,id),
    FOREIGN KEY(scope_id,conversation_id) REFERENCES hr_conversations(scope_id,id) ON DELETE CASCADE
  );
  CREATE TABLE hr_topics (
    scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),id TEXT NOT NULL,title TEXT NOT NULL,
    description TEXT NOT NULL,aliases TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    review_cursor TEXT NULL,PRIMARY KEY(scope_id,id)
  );
  CREATE TABLE hr_memberships (
    scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),conversation_id TEXT NOT NULL,facet_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,reason TEXT NOT NULL,assigned_at TEXT NOT NULL,
    PRIMARY KEY(scope_id,conversation_id,facet_id),
    FOREIGN KEY(scope_id,conversation_id,facet_id) REFERENCES hr_facets(scope_id,conversation_id,id) ON DELETE CASCADE,
    FOREIGN KEY(scope_id,topic_id) REFERENCES hr_topics(scope_id,id)
  );
  CREATE TABLE hr_topic_events (
    id INTEGER NOT NULL PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),revision INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('create','update','merge','move','retire')),topic_id TEXT NOT NULL,
    conversation_id TEXT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,
    FOREIGN KEY(scope_id,conversation_id) REFERENCES hr_conversations(scope_id,id)
  );
  CREATE TABLE hr_entries (
    scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),id TEXT NOT NULL,conversation_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,parent_id TEXT NULL,timestamp TEXT NOT NULL,role TEXT NOT NULL,line INTEGER NOT NULL,
    hash TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(scope_id,id),UNIQUE(scope_id,conversation_id,entry_id),
    FOREIGN KEY(scope_id,conversation_id) REFERENCES hr_conversations(scope_id,id) ON DELETE CASCADE
  );
  CREATE VIRTUAL TABLE hr_search USING fts5(row_id UNINDEXED,scope_id UNINDEXED,conversation_id UNINDEXED,body);
  CREATE TABLE hr_jobs (
    scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),file TEXT NOT NULL,directory TEXT NOT NULL,stamp TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,error TEXT NULL,retry_at INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,token TEXT NOT NULL DEFAULT '',PRIMARY KEY(scope_id,file)
  );
  CREATE TABLE hr_cache (
    scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),key TEXT NOT NULL,payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,PRIMARY KEY(scope_id,key)
  );
  CREATE TABLE hr_budget (
    scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),day TEXT NOT NULL,calls INTEGER NOT NULL,PRIMARY KEY(scope_id,day)
  );
  CREATE TABLE hr_model_calls (
    id INTEGER NOT NULL PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),timestamp INTEGER NOT NULL,
    purpose TEXT NOT NULL,metric TEXT NOT NULL
  );
  CREATE INDEX hr_conversations_scope_time ON hr_conversations(scope_id,last_active_at,id);
  CREATE INDEX hr_memberships_topic ON hr_memberships(scope_id,topic_id,conversation_id,facet_id);
  CREATE INDEX hr_entries_conversation_time ON hr_entries(scope_id,conversation_id,timestamp,line);
  CREATE INDEX hr_events_scope_revision ON hr_topic_events(scope_id,revision,id);
  CREATE INDEX hr_calls_scope_time ON hr_model_calls(scope_id,timestamp);
  PRAGMA user_version = 5;
`;

export function openHistoryDatabase(file: string): Database {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  try {
    chmodSync(file, 0o600);
    db.run("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      if ((version !== 0 && version !== 5) ||
          (version === 0 && db.query("SELECT 1 FROM sqlite_schema LIMIT 1").get())) {
        throw new RecallError("unsupported_index",
          `Derived history index at ${path.resolve(file)} must be rebuilt as schema 5; original session files are unchanged.`);
      }
      if (version === 0) db.run(SCHEMA);
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
