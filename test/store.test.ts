import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { HistoryStore } from "../src/store";
import type { JsonModel } from "../src/semantic";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recall-conversation-"));
  cleanup.push(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const directory = path.join(root, "sessions");
  await fs.mkdir(directory);
  const store = new HistoryStore(path.join(root, "index.db"), root);
  cleanup.push(async () => { store.close(); });
  return { root, directory, store };
}

async function writeSession(directory: string, project: string, id = "s1", time = "2026-09-20T01:00:00Z") {
  const records = [
    { type: "session", version: 3, id, cwd: project, timestamp: time, title: `${id} storage work` },
    { type: "message", id: `${id}-u`, parentId: null, timestamp: time, message: { role: "user", content: "WAL sync failure and EIO acknowledgement" } },
    { type: "message", id: `${id}-a`, parentId: `${id}-u`, timestamp: time, message: { role: "assistant", content: "A failed sync must not be acknowledged." } },
    { type: "message", id: `${id}-u2`, parentId: `${id}-a`, timestamp: "2026-09-20T03:00:00Z", message: { role: "user", content: "Continue the durability investigation." } },
  ];
  const file = path.join(directory, `${id}.jsonl`);
  await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  return file;
}

function model(calls = { count: 0 }): JsonModel {
  return { identity: "fixture", generate: async () => {
    calls.count++;
    return JSON.stringify({
      summary: "Investigated WAL durability and corrected write acknowledgement behavior.",
      topics: [{ title: "Storage durability", description: "WAL persistence, sync failures and acknowledgement semantics.", aliases: ["持久化", "WAL"] }],
    });
  } };
}

describe("explicit conversation index", () => {
  it("catalogs without queueing, then indexes only the requested file", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    await writeSession(directory, root, "s2");
    const catalog = await store.catalog(directory);
    expect(catalog.conversations).toHaveLength(2);
    expect(catalog.conversations.every((conversation: any) => conversation.indexed === false)).toBeTrue();
    expect(store.status().jobs).toHaveLength(0);
    await store.discover(directory, { file });
    expect(store.status().jobs).toHaveLength(1);
    const calls = { count: 0 };
    expect(await store.work(model(calls), { maxJobs: 1 })).toMatchObject({ completed: 1, failed: 0, calls: 1 });
    expect(calls.count).toBe(1);
    expect(store.status()).toMatchObject({ conversations: 1, topics: 1, indexed_entries: 3 });
    const refreshed = await store.catalog(directory);
    const canonicalFile = await fs.realpath(file);
    expect((refreshed.conversations.find((conversation: any) => conversation.file === canonicalFile) as any).indexed).toBeTrue();
  });

  it("renders topic timeline as description text rather than list metadata", async () => {
    const { root, directory, store } = await setup();
    await writeSession(directory, root);
    await store.discover(directory, { force: true });
    await store.work(model());
    const topics = store.browse().entries as any[];
    expect(topics).toHaveLength(1);
    expect(topics[0].description).toContain("Timeline:");
    expect(topics[0].description).toContain("across 1 conversation(s)");
    expect(topics[0].description).toContain("WAL persistence");
    expect(Object.keys(topics[0])).not.toContain("timeline");
    expect(Object.keys(topics[0])).not.toContain("active_windows");
  });

  it("browses topic conversations and reads the original active branch", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    await store.discover(directory, { file });
    await store.work(model());
    const topic = (store.browse().entries as any[])[0];
    const conversation = (store.browse({ topic_id: topic.id }).entries as any[])[0];
    expect(conversation.description).toContain("Active:");
    expect(conversation.description).toContain("(2 entries)");
    expect(conversation.description).toContain("(1 entries)");
    const original = await store.readConversation(conversation.id);
    expect(original.fragments.map((fragment: any) => fragment.entry_id)).toEqual(["s1-u", "s1-a", "s1-u2"]);
    expect(JSON.stringify(original.fragments)).toContain("failed sync");
  });

  it("searches original text and filters by code-processed time metadata", async () => {
    const { root, directory, store } = await setup();
    await writeSession(directory, root);
    await store.discover(directory, { force: true });
    await store.work(model());
    const result = await store.search(["EIO acknowledgement", "写入确认"]);
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].matched_entry_ids).toContain("s1-u");
    expect(store.browse({ from: "2026-09-21T00:00:00Z", to: "2026-09-22T00:00:00Z" }).entries).toHaveLength(0);
    expect(store.browse({ from: "2026-09-20T00:00:00+08:00", to: "2026-09-21T00:00:00+08:00" }).entries).toHaveLength(1);
  });

  it("searches one conversation and returns same-branch context around a matched entry", async () => {
    const { root, directory, store } = await setup();
    const records = [
      { type: "session", version: 3, id: "forked", cwd: root, timestamp: "2026-09-20T01:00:00Z", title: "Forked storage" },
      { type: "message", id: "root", parentId: null, timestamp: "2026-09-20T01:00:00Z", message: { role: "user", content: "root durable-write question" } },
      { type: "message", id: "match", parentId: "root", timestamp: "2026-09-20T01:01:00Z", message: { role: "assistant", content: "matched fsync answer" } },
      { type: "message", id: "branch-a", parentId: "match", timestamp: "2026-09-20T01:02:00Z", message: { role: "user", content: "branch A poisoned writer" } },
      { type: "message", id: "branch-a2", parentId: "branch-a", timestamp: "2026-09-20T01:03:00Z", message: { role: "user", content: "branch A continuation" } },
      { type: "message", id: "branch-b", parentId: "match", timestamp: "2026-09-20T01:04:00Z", message: { role: "user", content: "branch B alternate compaction" } },
    ];
    await fs.writeFile(path.join(directory, "forked.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    await store.discover(directory, { file: path.join(directory, "forked.jsonl") });
    await store.work(model());
    const conversationId = store.db.query<{ id: string }, []>("SELECT id FROM hr_conversations").get()!.id;
    const scoped = await store.search(["fsync", "sync failure"], { conversation_id: conversationId });
    expect(scoped.conversations).toHaveLength(1);
    expect(scoped.conversations[0].matched_entry_ids).toEqual(["match"]);
    const context = await store.readConversation(conversationId, { entry_id: "match", before: 1, after: 2, maxChars: 12000 });
    expect(context.context).toEqual({ entry_id: "match", before: 1, after: 2, alternate_children: ["branch-a"] });
    expect(context.fragments.map((fragment: any) => fragment.entry_id)).toEqual(["root", "match", "branch-b"]);
    expect(JSON.stringify(context.fragments)).not.toContain("branch A");
  });

  it("integrates no-project sessions into the current unified project directory", async () => {
    const { root, directory, store } = await setup();
    await writeSession(directory, "/another/project", "foreign");
    await store.discover(directory, { force: true });
    await store.work(model());
    const conversation = (store.browse().entries as any[]).length;
    expect(conversation).toBe(1);
    const row = store.db.query<{ source_project: string; unprojected: number }, []>("SELECT source_project,unprojected FROM hr_conversations").get()!;
    expect(row.source_project).toBe("/another/project");
    expect(row.unprojected).toBe(1);
  });

  it("excludes the resumed active session and detects stale evidence", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    await store.discover(directory, { file });
    await store.work(model());
    const conversationId = store.db.query<{ id: string }, []>("SELECT id FROM hr_conversations").get()!.id;
    const resumed = new HistoryStore(store.dbPath, root, "s1");
    cleanup.push(async () => { resumed.close(); });
    expect(resumed.browse().entries).toHaveLength(0);
    expect((await resumed.search(["WAL"])).conversations).toHaveLength(0);
    await expect(resumed.readConversation(conversationId)).rejects.toMatchObject({ code: "not_found" });
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("WAL sync failure", "WAL corrected"));
    await expect(store.readConversation(conversationId)).rejects.toMatchObject({ code: "stale_evidence" });
  });

  it("does not invoke the model again for unchanged files", async () => {
    const { root, directory, store } = await setup();
    await writeSession(directory, root);
    await store.discover(directory, { force: true });
    const calls = { count: 0 };
    await store.work(model(calls));
    await store.discover(directory, { file: path.join(directory, "s1.jsonl") });
    expect(await store.work(model(calls))).toMatchObject({ completed: 0, calls: 0 });
    expect(calls.count).toBe(1);
  });

  it("rejects existing prototype databases instead of pretending compatibility", async () => {
    const { root } = await setup();
    const file = path.join(root, "legacy.db");
    const legacy = new Database(file);
    legacy.exec("CREATE TABLE old(id TEXT); PRAGMA user_version=2;");
    legacy.close();
    expect(() => new HistoryStore(file, root)).toThrow("delete the old database");
  });
});
