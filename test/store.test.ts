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

async function writeLargeSession(directory: string, project: string) {
  const file = await writeSession(directory, project);
  const entries = Array.from({ length: 12 }, (_, index) => ({
    type: "message", id: `long-${index}`, parentId: index === 0 ? "s1-u2" : `long-${index - 1}`,
    timestamp: "2026-09-20T03:01:00Z",
    message: { role: "user", content: `Investigation segment ${index}. ${"WAL durability details. ".repeat(150)}` },
  }));
  await fs.appendFile(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
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

function gatedModel(count: number) {
  const responses = Array.from({ length: count }, () => Promise.withResolvers<string>());
  const started = Promise.withResolvers<void>();
  const requests: string[] = [];
  const fixture = model();
  const chunked: JsonModel = {
    ...fixture, contextWindow: 8192, maxOutputTokens: 1024,
    generate: async (system, input, signal) => {
      const index = requests.push(JSON.stringify([system, input])) - 1;
      if (requests.length === count) started.resolve();
      return index < responses.length ? responses[index].promise : fixture.generate(system, input, signal);
    },
  };
  return { chunked, requests, responses, started: started.promise };
}

describe("explicit conversation index", () => {
  it("catalogs without queueing, then indexes only the requested file", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    await writeSession(directory, root, "s2");
    const catalog = await store.catalog(directory);
    expect(catalog.conversations).toHaveLength(2);
    expect(catalog.conversations.every(conversation => conversation.indexed === false)).toBeTrue();
    expect(store.status().jobs).toHaveLength(0);
    await store.discover(directory, { file });
    expect(store.status().jobs).toHaveLength(1);
    const calls = { count: 0 };
    expect(await store.work(model(calls), { file, maxJobs: 1 })).toMatchObject({ completed: 1, failed: 0, calls: 1 });
    expect(calls.count).toBe(1);
    expect(store.status()).toMatchObject({ conversations: 1, topics: 1, indexed_entries: 3 });
    const refreshed = await store.catalog(directory);
    const canonicalFile = await fs.realpath(file);
    expect(refreshed.conversations.find(conversation => conversation.file === canonicalFile)?.indexed).toBeTrue();
  });


  it("browses topic conversations and reads the original active branch", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    await store.discover(directory, { file });
    await store.work(model());
    const topic = (store.browse().entries as { id: string }[])[0];
    const conversation = (store.browse({ topic_id: topic.id }).entries as { id: string }[])[0];
    const original = await store.readConversation(conversation.id);
    expect(original.fragments.map(fragment => fragment.entry_id)).toEqual(["s1-u", "s1-a", "s1-u2"]);
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
    expect(context.fragments.map(fragment => fragment.entry_id)).toEqual(["root", "match", "branch-b"]);
    expect(JSON.stringify(context.fragments)).not.toContain("branch A");
  });

  it("integrates no-project sessions into the current unified project directory", async () => {
    const { directory, store } = await setup();
    await writeSession(directory, "/another/project", "foreign");
    await store.discover(directory, { force: true });
    await store.work(model());
    const conversation = store.browse().entries.length;
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

  it("claims the requested file even when another file sorts first in the queue", async () => {
    const { root, directory, store } = await setup();
    const earlier = await fs.realpath(await writeSession(directory, root, "a"));
    const selected = await fs.realpath(await writeSession(directory, root, "z"));
    await store.discover(directory);
    expect(await store.work(model(), { file: selected, maxJobs: 1 })).toMatchObject({ completed: 1, calls: 1 });
    const catalog = await store.catalog(directory);
    expect(catalog.conversations.find(conversation => conversation.file === selected)?.indexed).toBeTrue();
    expect(catalog.conversations.find(conversation => conversation.file === earlier)?.indexed).toBeFalse();
    expect(store.status().jobs).toMatchObject([{ file: earlier }]);
  });

  it("rejects an outside path instead of indexing a same-basename session", async () => {
    const { root, directory, store } = await setup();
    await writeSession(directory, root);
    const outside = await writeSession(root, root);
    await expect(store.discover(directory, { file: outside })).rejects.toMatchObject({ code: "invalid_file" });
    expect(store.status().jobs).toHaveLength(0);
    expect(await store.work(model())).toMatchObject({ completed: 0, calls: 0 });
  });

  it("rejects invalid concurrency before canonicalizing a path or claiming queued work", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    await store.discover(directory, { file });
    const fixture = model();
    await expect(store.work(fixture, { file: path.join(root, "missing.jsonl"), concurrency: 0 }))
      .rejects.toMatchObject({ code: "invalid_concurrency" });
    expect(await store.work(fixture, { file })).toMatchObject({ completed: 1, failed: 0, calls: 1 });
  });

  it("resumes serial chunk indexing across batch and daily budget exhaustion", async () => {
    const { root, directory, store } = await setup();
    const file = await writeLargeSession(directory, root);
    const requests: string[] = [];
    const fixture = model();
    const chunked: JsonModel = {
      ...fixture, contextWindow: 8192, maxOutputTokens: 1024,
      generate: async (system, input, signal) => {
        requests.push(JSON.stringify(input));
        return fixture.generate(system, input, signal);
      },
    };
    await store.discover(directory, { file });
    expect(await store.work(chunked, { concurrency: 1, maxCalls: 1, maxDailyCalls: 2 })).toMatchObject({
      completed: 0, failed: 1, calls: 1, errors: [{ code: "work_budget" }],
    });
    expect(requests).toHaveLength(1);
    await store.discover(directory, { file, force: true });
    expect(await store.work(chunked, { concurrency: 1, maxCalls: 100, maxDailyCalls: 2 })).toMatchObject({
      completed: 0, failed: 1, calls: 1, errors: [{ code: "daily_budget" }],
    });
    expect(requests).toHaveLength(2);
    expect(store.status().indexing_calls_today).toBe(2);
    const [first, second] = requests;
    await store.discover(directory, { file, force: true });
    const resumed = await store.work(chunked, { concurrency: 1, maxCalls: 100, maxDailyCalls: 100 });
    expect(resumed).toMatchObject({ completed: 1, failed: 0, calls: requests.length - 2 });
    expect(requests.filter(input => input === first)).toHaveLength(1);
    expect(requests.filter(input => input === second)).toHaveLength(1);
    expect(store.status().indexing_calls_today).toBe(requests.length);
  });

  it("counts failed provider calls against both reported and daily usage", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    let calls = 0;
    const unavailable: JsonModel = { identity: "fixture", generate: async () => {
      calls++;
      throw new Error("Provider unavailable");
    } };
    await store.discover(directory, { file });
    expect(await store.work(unavailable, { maxDailyCalls: 1 })).toMatchObject({
      completed: 0, failed: 1, calls: 1, errors: [{ code: "index_error" }],
    });
    await store.discover(directory, { file, force: true });
    expect(await store.work(unavailable, { maxDailyCalls: 1 })).toMatchObject({
      completed: 0, failed: 1, calls: 0, errors: [{ code: "daily_budget" }],
    });
    expect(calls).toBe(1);
    expect(store.status().indexing_calls_today).toBe(1);
  });

  it("retries invalid serial output without throwing away earlier validated chunks", async () => {
    const { root, directory, store } = await setup();
    const file = await writeLargeSession(directory, root);
    const requests: string[] = [];
    const fixture = model();
    const chunked: JsonModel = {
      ...fixture, contextWindow: 8192, maxOutputTokens: 1024,
      generate: async (system, input, signal) => {
        requests.push(JSON.stringify(input));
        if (requests.length === 2) return JSON.stringify({ summary: "", topics: [] });
        return fixture.generate(system, input, signal);
      },
    };
    await store.discover(directory, { file });
    expect(await store.work(chunked, { concurrency: 1, maxCalls: 100, maxDailyCalls: 100 })).toMatchObject({
      completed: 0, failed: 1, calls: 2, errors: [{ code: "invalid_model_output" }],
    });
    const [valid, invalid] = requests;
    await store.discover(directory, { file, force: true });
    const resumed = await store.work(chunked, { concurrency: 1, maxCalls: 100, maxDailyCalls: 100 });
    expect(resumed).toMatchObject({ completed: 1, failed: 0, calls: requests.length - 2 });
    expect(requests.filter(input => input === valid)).toHaveLength(1);
    expect(requests.filter(input => input === invalid)).toHaveLength(2);
  });

  it("retains good siblings that finish after an out-of-order invalid chunk", async () => {
    const { root, directory, store } = await setup();
    const file = await writeLargeSession(directory, root);
    const valid = await model().generate("", null);
    const gated = gatedModel(3);
    await store.discover(directory, { file });
    const work = store.work(gated.chunked, { concurrency: 3, maxCalls: 100, maxDailyCalls: 100 });
    cleanup.push(async () => {
      for (const response of gated.responses) response.resolve(valid);
      await work;
    });
    let settled = false;
    void work.then(() => { settled = true; });
    await gated.started;
    gated.responses[1].resolve(JSON.stringify({ summary: "", topics: [] }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBeFalse();
    gated.responses[2].resolve(valid);
    gated.responses[0].resolve(valid);
    expect(await work).toMatchObject({ completed: 0, failed: 1, calls: 3, errors: [{ code: "invalid_model_output" }] });
    const [first, invalid, third] = gated.requests;

    await store.discover(directory, { file, force: true });
    expect(await store.work(gated.chunked, { concurrency: 1, maxCalls: 100, maxDailyCalls: 100 }))
      .toMatchObject({ completed: 1, failed: 0, calls: gated.requests.length - 3 });
    expect(gated.requests.filter(request => request === first)).toHaveLength(1);
    expect(gated.requests.filter(request => request === third)).toHaveLength(1);
    expect(gated.requests.filter(request => request === invalid)).toHaveLength(2);
    expect(store.status().indexing_calls_today).toBe(gated.requests.length);
  });

  it("evicts every malformed concurrent sibling while reusing the completed valid chunk", async () => {
    const { root, directory, store } = await setup();
    const file = await writeLargeSession(directory, root);
    const valid = await model().generate("", null);
    const gated = gatedModel(3);
    await store.discover(directory, { file });
    const work = store.work(gated.chunked, { concurrency: 3, maxCalls: 100, maxDailyCalls: 100 });
    cleanup.push(async () => {
      for (const response of gated.responses) response.resolve(valid);
      await work;
    });
    await gated.started;
    gated.responses[1].resolve(JSON.stringify({ summary: "", topics: [] }));
    gated.responses[0].resolve(valid);
    await new Promise<void>(resolve => setImmediate(resolve));
    gated.responses[2].resolve(JSON.stringify({ summary: "An invalid topic collection.", topics: "not an array" }));
    expect(await work).toMatchObject({ completed: 0, failed: 1, calls: 3, errors: [{ code: "invalid_model_output" }] });
    const [completed, invalidFirst, invalidLast] = gated.requests;

    await store.discover(directory, { file, force: true });
    expect(await store.work(gated.chunked, { concurrency: 2, maxCalls: 100, maxDailyCalls: 100 }))
      .toMatchObject({ completed: 1, failed: 0, calls: gated.requests.length - 3 });
    expect(gated.requests.filter(request => request === completed)).toHaveLength(1);
    expect(gated.requests.filter(request => request === invalidFirst)).toHaveLength(2);
    expect(gated.requests.filter(request => request === invalidLast)).toHaveLength(2);
  });

  it("reserves batch and daily quotas before overlapping provider calls and drains admitted calls", async () => {
    const { root, directory, store } = await setup();
    const file = await writeLargeSession(directory, root);
    const valid = await model().generate("", null);
    const batch = gatedModel(2);
    await store.discover(directory, { file });
    const batchWork = store.work(batch.chunked, { concurrency: 5, maxCalls: 2, maxDailyCalls: 100 });
    cleanup.push(async () => {
      for (const response of batch.responses) response.resolve(valid);
      await batchWork;
    });
    let batchSettled = false;
    void batchWork.then(() => { batchSettled = true; });
    await batch.started;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(batch.requests).toHaveLength(2);
    expect(store.status().indexing_calls_today).toBe(2);
    expect(batchSettled).toBeFalse();
    for (const response of batch.responses) response.resolve(valid);
    expect(await batchWork).toMatchObject({ completed: 0, failed: 1, calls: 2, errors: [{ code: "work_budget" }] });

    const daily = gatedModel(2);
    await store.discover(directory, { file, force: true });
    const dailyWork = store.work(daily.chunked, { concurrency: 5, maxCalls: 100, maxDailyCalls: 4 });
    cleanup.push(async () => {
      for (const response of daily.responses) response.resolve(valid);
      await dailyWork;
    });
    let dailySettled = false;
    void dailyWork.then(() => { dailySettled = true; });
    await daily.started;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(daily.requests).toHaveLength(2);
    expect(store.status().indexing_calls_today).toBe(4);
    expect(dailySettled).toBeFalse();
    for (const response of daily.responses) response.resolve(valid);
    expect(await dailyWork).toMatchObject({ completed: 0, failed: 1, calls: 2, errors: [{ code: "daily_budget" }] });

    const reservedRequests = [...batch.requests, ...daily.requests];
    await store.discover(directory, { file, force: true });
    expect(await store.work(daily.chunked, { concurrency: 32, maxCalls: 100, maxDailyCalls: 100 }))
      .toMatchObject({ completed: 1, failed: 0, calls: daily.requests.length - 2 });
    const allRequests = [...batch.requests, ...daily.requests];
    for (const reserved of reservedRequests) {
      expect(allRequests.filter(request => request === reserved)).toHaveLength(1);
    }
    expect(store.status().indexing_calls_today).toBe(allRequests.length);
  });

  it("keeps the job lease after provider failure until every in-flight request settles", async () => {
    const { root, directory, store } = await setup();
    const file = await writeLargeSession(directory, root);
    const competitor = new HistoryStore(store.dbPath, root);
    cleanup.push(async () => { competitor.close(); });
    const valid = await model().generate("", null);
    const gated = gatedModel(3);
    await store.discover(directory, { file });
    const work = store.work(gated.chunked, { concurrency: 3, maxCalls: 100, maxDailyCalls: 100 });
    cleanup.push(async () => {
      for (const response of gated.responses) response.resolve(valid);
      await work;
    });
    let settled = false;
    void work.then(() => { settled = true; });
    await gated.started;
    const lease = store.db.query<{ token: string; lease_until: number; error: string | null }, []>(
      "SELECT token,lease_until,error FROM hr_jobs");
    const owned = lease.get()!;
    expect(owned.lease_until).toBeGreaterThan(Date.now());
    gated.responses[0].reject(new Error("Provider unavailable"));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBeFalse();
    expect(lease.get()).toEqual(owned);
    expect(await competitor.work(model(), { file })).toMatchObject({ completed: 0, failed: 0, calls: 0 });
    gated.responses[2].resolve(valid);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBeFalse();
    expect(lease.get()).toEqual(owned);
    gated.responses[1].resolve(valid);
    expect(await work).toMatchObject({ completed: 0, failed: 1, calls: 3, errors: [{ code: "index_error" }] });
    expect(lease.get()).toMatchObject({ token: "", lease_until: 0, error: "index_error" });
    const [failed, second, third] = gated.requests;

    await store.discover(directory, { file, force: true });
    expect(await competitor.work(gated.chunked, { file, concurrency: 3, maxCalls: 100, maxDailyCalls: 100 }))
      .toMatchObject({ completed: 1, failed: 0, calls: gated.requests.length - 3 });
    expect(gated.requests.filter(request => request === failed)).toHaveLength(2);
    expect(gated.requests.filter(request => request === second)).toHaveLength(1);
    expect(gated.requests.filter(request => request === third)).toHaveLength(1);
    expect(store.status().indexing_calls_today).toBe(gated.requests.length);
  });

  it("reuses final results only while model limits and topic vocabulary are unchanged", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    const calls = { count: 0 };
    let fixture: JsonModel = { ...model(calls), contextWindow: 32768, maxOutputTokens: 1024 };
    await store.discover(directory, { file });
    await store.work(fixture, { concurrency: 1 });
    // The first publication adds a topic, so warm the cache with that vocabulary.
    await store.discover(directory, { file, force: true });
    await store.work(fixture, { concurrency: 3 });
    await store.discover(directory, { file, force: true });
    expect(await store.work(fixture, { concurrency: 32, maxDailyCalls: 2 })).toMatchObject({ completed: 1, calls: 0 });
    expect(calls.count).toBe(2);
    fixture = { ...fixture, contextWindow: 16384 };
    await store.discover(directory, { file, force: true });
    expect(await store.work(fixture)).toMatchObject({ completed: 1, calls: 1 });
    fixture = { ...fixture, maxOutputTokens: 2048 };
    await store.discover(directory, { file, force: true });
    expect(await store.work(fixture)).toMatchObject({ completed: 1, calls: 1 });
    const other = await writeSession(directory, root, "other");
    await store.discover(directory, { file: other });
    await store.work({ ...fixture, generate: async () => JSON.stringify({
      summary: "Investigated incident handling.",
      topics: [{ title: "Incident response", description: "Operational incident handling.", aliases: [] }],
    }) }, { file: other });
    await store.discover(directory, { file, force: true });
    expect(await store.work(fixture, { file })).toMatchObject({ completed: 1, calls: 1 });
    expect(calls.count).toBe(5);
  });

  it("rejects existing prototype databases instead of pretending compatibility", async () => {
    const { root } = await setup();
    const file = path.join(root, "legacy.db");
    const legacy = new Database(file);
    legacy.run("CREATE TABLE old(id TEXT); PRAGMA user_version=2;");
    legacy.close();
    let error: unknown;
    try { new HistoryStore(file, root); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "unsupported_index" });
  });
});
