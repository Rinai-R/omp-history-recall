import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { HistoryStore } from "../src/store";
import type { RecallScope, SourceAccess } from "../src/scope";
import { openHistoryDatabase } from "../src/database";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(activeSessionId = "active") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recall-fts-")));
  cleanup.push(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const sessionsRoot = path.join(root, "agent", "sessions");
  await fs.mkdir(sessionsRoot, { recursive: true });
  const scope: RecallScope = {
    id: "scope_fixture", agentDir: path.join(root, "agent"),
    sessionsRoot, customFilesRoot: path.join(root, "agent", "custom-session-files"),
  };
  const access: SourceAccess = { sessionDir: sessionsRoot, activeSessionId };
  const store = new HistoryStore(path.join(root, "index.db"), scope, access);
  cleanup.push(async () => { store.close(); });
  return { root, sessionsRoot, scope, access, store };
}

function record(type: string, id: string, parentId: string | null, extra: Record<string, unknown>) {
  return { type, id, parentId, timestamp: "2026-09-20T01:00:00Z", ...extra };
}

async function writeSession(directory: string, name: string, sessionId: string, cwd: string, records: unknown[]) {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.jsonl`);
  const header = { type: "session", version: 3, id: sessionId, cwd, timestamp: "2026-09-20T00:00:00Z", title: name };
  await fs.writeFile(file, [header, ...records].map(record => JSON.stringify(record)).join("\n") + "\n");
  return file;
}

function conversation(sessionId = "s1") {
  return [
    record("message", `${sessionId}-u`, null, { message: { role: "user", content: "WAL sync failed; writes must not be acknowledged" } }),
    record("message", `${sessionId}-a`, `${sessionId}-u`, { message: { role: "assistant", content: "A failed fsync must not be acknowledged." } }),
  ];
}

describe("FTS session index", () => {
  it("ingests incrementally and searches original text without a model", async () => {
    const { root, sessionsRoot, store } = await setup();
    await writeSession(path.join(sessionsRoot, "bucket-a"), "a", "a", root, conversation("a"));
    const first = await store.sync();
    expect(first).toMatchObject({ ingested: 1, failed: 0, pending: 0 });
    const hit = await store.search(["fsync"]);
    expect(hit.conversations).toHaveLength(1);
    expect(hit.conversations[0].matched_entry_ids).toEqual(["a-a"]);
    expect(hit.pending_files).toBe(0);

    expect(await store.sync()).toMatchObject({ ingested: 0, pending: 0 });
    expect((await store.status()).conversations).toBe(1);
  });

  it("matches two-character Han queries through bigram tokens", async () => {
    const { root, sessionsRoot, store } = await setup();
    const records = [
      record("message", "u", null, { message: { role: "user", content: "写入确认失败，请检查持久化" } }),
    ];
    await writeSession(path.join(sessionsRoot, "bucket-han"), "han", "han", root, records);
    await store.sync();
    for (const query of ["写入", "写入确认", "持久化"]) {
      const result = await store.search([query]);
      expect(result.conversations).toHaveLength(1);
      expect(result.conversations[0].matched_entry_ids).toEqual(["u"]);
    }
    expect(await store.search(["按钮"])).toMatchObject({ conversations: [] });
  });

  it("indexes compaction, branch summaries and custom messages, but not system prompts", async () => {
    const { root, sessionsRoot, store } = await setup();
    const records = [
      record("message", "u", null, { message: { role: "user", content: "start review" } }),
      record("compaction", "c", "u", { summary: "迁移方案已否决，保留本地索引", firstKeptEntryId: "u" }),
      record("branch_summary", "b", "c", { summary: "abandoned sketch mentioned banana", fromId: "u" }),
      record("custom_message", "m", "b", { customType: "note", content: "custom marker zebra" }),
      record("session_init", "init", "m", { systemPrompt: "SYSTEM_ONLY_TOKEN", message: "init" }),
    ];
    await writeSession(path.join(sessionsRoot, "bucket-mixed"), "mixed", "mixed", root, records);
    await store.sync();
    for (const query of ["迁移方案", "banana", "zebra"]) {
      expect((await store.search([query])).conversations).toHaveLength(1);
    }
    expect((await store.search(["SYSTEM_ONLY_TOKEN"])).conversations).toHaveLength(0);
  });

  it("reindexes only changed files and replaces their FTS rows", async () => {
    const { root, sessionsRoot, store } = await setup();
    const file = await writeSession(path.join(sessionsRoot, "bucket-a"), "a", "a", root, conversation("a"));
    await store.sync();
    const before = store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM hr_search").get()!.n;

    await fs.appendFile(file, JSON.stringify(record("message", "a-extra", "a-a", {
      message: { role: "user", content: "additional recovery note" },
    })) + "\n");
    expect(await store.sync()).toMatchObject({ ingested: 1, pending: 0 });
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM hr_search").get()!.n).toBe(before + 1);
    expect((await store.search(["recovery"])).conversations).toHaveLength(1);
  });

  it("bounds each pass and resumes the remaining files", async () => {
    const { root, sessionsRoot, store } = await setup();
    for (let index = 0; index < 70; index++) {
      await writeSession(path.join(sessionsRoot, "bulk"), `s${index}`, `s${index}`, root, conversation(`s${index}`));
    }
    expect(await store.sync({ maxFiles: 64 })).toMatchObject({ ingested: 64, pending: 6 });
    expect(await store.sync({ maxFiles: 64 })).toMatchObject({ ingested: 6, pending: 0 });
    expect((await store.status()).conversations).toBe(70);
  });

  it("excludes the active session by identity even when the path differs", async () => {
    const { root, sessionsRoot, store } = await setup("active-session");
    await writeSession(path.join(sessionsRoot, "bucket-a"), "active", "active-session", root, conversation("active"));
    expect(await store.sync()).toMatchObject({ ingested: 0, skipped: 1 });
    expect((await store.status()).conversations).toBe(0);
    expect((await store.search(["fsync"])).conversations).toHaveLength(0);
  });

  it("keeps sessions from different cwds searchable in one profile", async () => {
    const { root, sessionsRoot, store } = await setup();
    await writeSession(path.join(sessionsRoot, "bucket-a"), "a", "a", path.join(root, "project-a"), conversation("a"));
    await writeSession(path.join(sessionsRoot, "bucket-b"), "b", "b", path.join(root, "project-b"), [
      record("message", "b-u", null, { message: { role: "user", content: "持久化写入确认" } }),
    ]);
    await store.sync();
    expect((await store.search(["fsync"])).conversations.map(hit => hit.session_id)).toEqual(["a"]);
    expect((await store.search(["持久化"])).conversations.map(hit => hit.session_id)).toEqual(["b"]);
    const scoped = await store.search(["持久化"], { source_cwd: path.join(root, "project-a") });
    expect(scoped.conversations).toHaveLength(0);
  });

  it("reads original evidence and fails closed when the source changes", async () => {
    const { root, sessionsRoot, store } = await setup();
    const file = await writeSession(path.join(sessionsRoot, "bucket-a"), "a", "a", root, conversation("a"));
    await store.sync();
    const conversationId = store.db.query<{ id: string }, []>("SELECT id FROM hr_conversations").get()!.id;
    const page = await store.readConversation(conversationId);
    expect(page.fragments.map(fragment => fragment.entry_id)).toEqual(["a-u", "a-a"]);
    expect(page.fragments[0].text).toContain("WAL sync failed");

    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("WAL sync failed", "WAL corrected"));
    await expect(store.readConversation(conversationId)).rejects.toMatchObject({ code: "stale_evidence" });
  });

  it("rejects duplicate live session identities instead of overwriting evidence", async () => {
    const { root, sessionsRoot, store } = await setup();
    await writeSession(path.join(sessionsRoot, "bucket-a"), "one", "shared", root, conversation("shared"));
    await writeSession(path.join(sessionsRoot, "bucket-b"), "two", "shared", root, conversation("shared"));
    const result = await store.sync();
    expect(result.ingested).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures[0]?.code).toBe("duplicate_session");
  });

  it("paginates the catalog and rejects cursors from another snapshot", async () => {
    const { root, sessionsRoot, store } = await setup();
    for (let index = 0; index < 55; index++) {
      await writeSession(path.join(sessionsRoot, "bulk"), `s${String(index).padStart(2, "0")}`, `s${index}`, root, conversation(`s${index}`));
    }
    await store.sync({ maxFiles: 100 });
    const first = await store.catalog({ limit: 50 });
    expect(first.conversations).toHaveLength(50);
    expect(first.next_cursor).not.toBeNull();
    const second = await store.catalog({ limit: 50, cursor: first.next_cursor! });
    expect(second.conversations).toHaveLength(5);
    const ids = new Set([...first.conversations, ...second.conversations].map(entry => entry.source_file));
    expect(ids.size).toBe(55);

    await writeSession(path.join(sessionsRoot, "bulk"), "late", "late", root, conversation("late"));
    await expect(store.catalog({ limit: 50, cursor: first.next_cursor! })).rejects.toMatchObject({ code: "stale_cursor" });
  });

  it("paginates search results deterministically and rejects stale cursors", async () => {
    const { root, sessionsRoot, store } = await setup();
    for (let index = 0; index < 60; index++) {
      const id = `s${String(index).padStart(2, "0")}`;
      await writeSession(path.join(sessionsRoot, "bulk"), id, id, root, conversation(id));
    }
    await store.sync({ maxFiles: 100 });
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.search(["WAL"], { limit: 25, cursor });
      expect(page.conversations.length).toBeLessThanOrEqual(25);
      for (const hit of page.conversations) {
        expect(seen.has(hit.id)).toBeFalse();
        seen.add(hit.id);
      }
      cursor = page.next_cursor ?? undefined;
      pages++;
    } while (cursor && pages < 5);
    expect(seen.size).toBe(60);
    expect(pages).toBe(3);

    const first = await store.search(["WAL"], { limit: 25 });
    await writeSession(path.join(sessionsRoot, "bulk"), "late", "late", root, conversation("late"));
    await expect(store.search(["WAL"], { limit: 25, cursor: first.next_cursor! }))
      .rejects.toMatchObject({ code: "stale_cursor" });
  });

  it("rejects incompatible derived databases with a rebuild instruction", async () => {
    const { root } = await setup();
    const file = path.join(root, "old.db");
    const legacy = new Database(file);
    legacy.run("CREATE TABLE old(id TEXT); PRAGMA user_version=5;");
    legacy.close();
    let error: unknown;
    try { openHistoryDatabase(file); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "unsupported_index" });
    expect(String((error as Error).message)).toContain("rebuilt as schema 6");
  });
});
