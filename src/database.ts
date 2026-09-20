import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { RecallError } from "./source";

const SCHEMA = `
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
`;

export function openHistoryDatabase(file: string): Database {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  try {
    chmodSync(file, 0o600);
    db.run("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    db.transaction(() => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      if (version !== 0 && version !== 3) {
        throw new RecallError("unsupported_index", "This plugin uses a new explicit conversation/topic index; delete the old database.");
      }
      if (version === 0) db.run(SCHEMA);
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
