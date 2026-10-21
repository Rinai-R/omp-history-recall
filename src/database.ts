import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { RecallError } from "./source";

const SCHEMA = `
  CREATE TABLE hr_scopes (
    scope_id TEXT NOT NULL PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE hr_files (
    scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),file TEXT NOT NULL,directory TEXT NOT NULL,
    stamp TEXT NOT NULL,indexed_at TEXT NULL,error TEXT NULL,PRIMARY KEY(scope_id,file)
  );
  CREATE TABLE hr_conversations (
    scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),id TEXT NOT NULL,session_id TEXT NOT NULL,
    file TEXT NOT NULL,directory TEXT NOT NULL,stamp TEXT NOT NULL,source_cwd TEXT NOT NULL,
    source_hash TEXT NOT NULL,title TEXT NOT NULL,started_at TEXT NOT NULL,last_active_at TEXT NOT NULL,
    entry_count INTEGER NOT NULL,message_count INTEGER NOT NULL,user_turn_count INTEGER NOT NULL,
    branch_count INTEGER NOT NULL,size_bytes INTEGER NOT NULL,indexed_at TEXT NOT NULL,
    PRIMARY KEY(scope_id,id),UNIQUE(scope_id,session_id),UNIQUE(scope_id,file)
  );
  CREATE TABLE hr_entries (
    scope_id TEXT NOT NULL REFERENCES hr_scopes(scope_id),id TEXT NOT NULL,conversation_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,parent_id TEXT NULL,timestamp TEXT NOT NULL,kind TEXT NOT NULL,
    line INTEGER NOT NULL,hash TEXT NOT NULL,text TEXT NOT NULL,
    PRIMARY KEY(scope_id,id),UNIQUE(scope_id,conversation_id,entry_id),
    FOREIGN KEY(scope_id,conversation_id) REFERENCES hr_conversations(scope_id,id) ON DELETE CASCADE
  );
  CREATE VIRTUAL TABLE hr_search USING fts5(row_id UNINDEXED,scope_id UNINDEXED,conversation_id UNINDEXED,body);
  CREATE INDEX hr_conversations_scope_time ON hr_conversations(scope_id,last_active_at,id);
  CREATE INDEX hr_entries_conversation_time ON hr_entries(scope_id,conversation_id,timestamp,line);
  PRAGMA user_version = 6;
`;

export function openHistoryDatabase(file: string): Database {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  try {
    chmodSync(file, 0o600);
    db.run("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      const populated = db.query("SELECT 1 FROM sqlite_schema LIMIT 1").get() !== null;
      if ((version !== 0 && version !== 6) || (version === 0 && populated)) {
        throw new RecallError("unsupported_index",
          `Derived history index at ${path.resolve(file)} must be rebuilt as schema 6; original session files are unchanged.`);
      }
      if (version === 0) db.run(SCHEMA);
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
