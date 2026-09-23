import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RepairProposal, RepairRunner } from "../src/repair";
import type { RecallScope, SourceAccess } from "../src/scope";
import type { JsonModel, TopicDescriptor } from "../src/semantic";
import { digest } from "../src/source";
import { HistoryStore } from "../src/store";
import { keepRepair, repairRunner, RepairDriver } from "./repair-driver";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Card = TopicDescriptor & { id: string };
type Facet = TopicDescriptor & { evidence_entry_ids: string[] };
type AnalysisRequest = {
  stage: "analysis_map" | "analysis_reduce" | "analysis_final";
  entries?: { id: string; text: string }[]; segments?: { summary: string; facets: Facet[] }[];
};
type SelectRequest = { stage: "select_topic"; facet: TopicDescriptor; previous: Card[]; candidates: Card[] };
type Request = AnalysisRequest | SelectRequest;
type Hook = (request: Request, fallback: Record<string, unknown>) => unknown | Promise<unknown>;
type Membership = { topic_id: string; facet_id: string; reason: string; evidence_refs: { entry_id: string; sha256: string }[] };
type Conversation = { id: string; session_id: string; source_cwd: string; memberships: Membership[] };
type Topic = { id: string; title: string; aliases: string[]; member_count: number };

function descriptor(scope: string): TopicDescriptor {
  const title = scope === "storage" ? "WAL failures" : scope === "ui" ? "Interface layout" : scope;
  return { title, description: `Discussion of ${scope}.`, aliases: [title] };
}

function analysis(request: AnalysisRequest): Record<string, unknown> {
  const facets = new Map<string, Facet>();
  const add = (item: Facet) => {
    const previous = facets.get(item.description);
    if (previous) previous.evidence_entry_ids = [...new Set([...previous.evidence_entry_ids, ...item.evidence_entry_ids])].slice(0, 12);
    else facets.set(item.description, { ...item, evidence_entry_ids: [...item.evidence_entry_ids] });
  };
  for (const entry of request.entries ?? []) {
    const scopes = [...entry.text.matchAll(/Discussion scope: ([^.\n]+)\./g)].map(match => match[1]);
    if (!scopes.length) scopes.push(/按钮|颜色|button|spacing/i.test(entry.text) ? "ui" : "storage");
    for (const scope of scopes) add({ ...descriptor(scope), evidence_entry_ids: [entry.id] });
  }
  for (const segment of request.segments ?? []) for (const facet of segment.facets) add(facet);
  return { summary: "Investigated the recorded discussion and its outcomes.", facets: [...facets.values()].slice(0, 5) };
}

function selection(request: SelectRequest, chosen?: string | null, neighbors?: readonly string[]) {
  const cards = [...request.previous, ...request.candidates];
  const topicId = chosen === undefined ? cards.find(card => card.description === request.facet.description)?.id ?? null : chosen;
  const ids = [...new Set([...(topicId ? [topicId] : []), ...(neighbors ?? cards.map(card => card.id))])].slice(0, 3);
  return { topic_id: topicId, candidate_ids: ids, reason: "The selected definition has the same discussion scope." };
}

function response(request: Request): Record<string, unknown> {
  switch (request.stage) {
    case "analysis_map": case "analysis_reduce": case "analysis_final": return analysis(request);
    case "select_topic": return selection(request);
  }
}

function model(hook?: Hook, limits: Partial<Pick<JsonModel, "identity" | "contextWindow" | "maxOutputTokens">> = {}) {
  const requests: Request[] = [];
  let active = 0;
  let peak = 0;
  const fixture: JsonModel = {
    identity: "controlled-semantic-store", ...limits,
    generate: async (_system, input) => {
      const request = input as Request;
      requests.push(request);
      peak = Math.max(peak, ++active);
      try { return JSON.stringify(hook ? await hook(request, response(request)) : response(request)); }
      finally { active--; }
    },
  };
  return { fixture, requests, get peak() { return peak; } };
}

function gatedModel(count: number) {
  const gates = Array.from({ length: count }, () => Promise.withResolvers<unknown>());
  const started = Promise.withResolvers<void>();
  const controlled = model(async (_request, fallback) => {
    const index = controlled.requests.length - 1;
    if (controlled.requests.length === count) started.resolve();
    return index < gates.length ? gates[index].promise : fallback;
  }, { contextWindow: 8192, maxOutputTokens: 1024 });
  return {
    ...controlled, gates, started: started.promise,
    resolve(index: number) { gates[index].resolve(response(controlled.requests[index])); },
    release() { gates.forEach((gate, index) => gate.resolve(controlled.requests[index] ? response(controlled.requests[index]) : {})); },
  };
}

async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recall-semantic-store-")));
  cleanup.push(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const directory = path.join(root, "sessions");
  const customFilesRoot = path.join(root, "custom-files");
  await fs.mkdir(directory);
  await fs.mkdir(customFilesRoot);
  const scope: RecallScope = { id: `scope_${digest(root).slice(0, 24)}`, agentDir: root, sessionsRoot: directory, customFilesRoot };
  const access: SourceAccess = { sessionDir: directory, activeSessionId: "active-session" };
  const store = new HistoryStore(path.join(root, "index.db"), scope, access);
  cleanup.push(async () => { store.close(); });
  return { root, directory, scope, access, store };
}

function connection(store: HistoryStore, scope: RecallScope, access: SourceAccess) {
  const next = new HistoryStore(store.dbPath, scope, access);
  cleanup.push(async () => { next.close(); });
  return next;
}

async function writeSession(directory: string, cwd: string, id = "s1", texts = [
  "WAL fsync failed; writes must not be acknowledged. EIO acknowledgement",
  "A failed sync must not be acknowledged.", "Continue the durability investigation.",
], time = "2026-09-20T01:00:00Z") {
  await fs.mkdir(directory, { recursive: true });
  const records = [
    { type: "session", version: 3, id, cwd, timestamp: time, title: `${id} discussion` },
    ...texts.map((text, index) => ({ type: "message", id: `${id}-${index}`, parentId: index ? `${id}-${index - 1}` : null,
      timestamp: new Date(Date.parse(time) + index * 60_000).toISOString(), message: { role: index % 2 ? "assistant" : "user", content: text } })),
  ];
  const file = path.join(directory, `${id}.jsonl`);
  await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  return file;
}

async function writeLargeSession(directory: string, cwd: string) {
  return writeSession(directory, cwd, "large", Array.from({ length: 18 }, (_, index) =>
    `Investigation segment ${index}. ${"WAL durability details. ".repeat(150)}`));
}

async function index(store: HistoryStore, fixture: JsonModel, file: string, force = false, repair: RepairRunner = keepRepair) {
  await store.discover({ file, force });
  const result = await store.work(fixture, repair, { file, maxJobs: 1, maxCalls: 1000 });
  expect(result).toMatchObject({ completed: 1, failed: 0, errors: [] });
  return result;
}

function conversations(store: HistoryStore) {
  return store.db.query<{ id: string; session_id: string; source_cwd: string }, [string]>(
    "SELECT id,session_id,source_cwd FROM hr_conversations WHERE scope_id=? ORDER BY session_id").all(store.scope.id)
    .map(row => ({ ...row, memberships: store.db.query<Pick<Membership, "topic_id" | "facet_id" | "reason">, [string, string]>(
      "SELECT topic_id,facet_id,reason FROM hr_memberships WHERE scope_id=? AND conversation_id=? ORDER BY facet_id").all(store.scope.id, row.id) }));
}

function conversation(store: HistoryStore, sessionId: string) {
  const row = conversations(store).find(item => item.session_id === sessionId);
  if (!row) throw new Error(`Missing indexed session ${sessionId}`);
  return row;
}

function topicOf(store: HistoryStore, sessionId: string, facet = 0) { return conversation(store, sessionId).memberships[facet].topic_id; }
function topics(store: HistoryStore) { return store.browse({ limit: 50 }).entries as Topic[]; }
function entrySnapshot(store: HistoryStore, id: string) {
  return { entries: store.db.query("SELECT * FROM hr_entries WHERE scope_id=? AND conversation_id=? ORDER BY id").all(store.scope.id, id),
    search: store.db.query("SELECT rowid,* FROM hr_search WHERE scope_id=? AND conversation_id=? ORDER BY row_id").all(store.scope.id, id) };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function proposal(changes: Partial<RepairProposal> = {}): RepairProposal {
  return { drafts: [], updates: [], moves: [], merge: null, reason: "Repair the indexed discussion scope from original evidence.", ...changes };
}

function renameRepair(topicId: string, title: string): RepairRunner {
  return repairRunner(async driver => {
    const card = (await driver.topics()).find(topic => topic.id === topicId)!;
    return driver.commit(proposal({ updates: [{ topicId, descriptor: { title, description: card.description, aliases: card.aliases }, reason: "Clarify the same scope without dropping members." }] }));
  });
}

describe("explicit profile conversation indexing", () => {
  it("catalogs without model work and indexes only the selected file", async () => {
    const { root, directory, store } = await setup();
    const first = await writeSession(directory, root, "a");
    const selected = await writeSession(directory, root, "z");
    const catalog = await store.catalog();
    expect(catalog).toMatchObject({ scope_id: store.scope.id, warnings: [], next_cursor: null });
    expect(catalog.conversations).toHaveLength(2);
    for (const candidate of catalog.conversations) expect(candidate).toMatchObject({ indexed: false, time_basis: "filesystem", started_at: null, last_active_at: null, source_cwd: null });
    expect(store.status().jobs).toHaveLength(0);
    await store.discover();
    const controlled = model();
    expect(await store.work(controlled.fixture, keepRepair, { file: selected, maxJobs: 1 })).toMatchObject({ completed: 1, calls: 1, topic_changes: { created: 1, updated: 0, merged: 0, reassigned: 0 } });
    const refreshed = await store.catalog();
    expect(refreshed.conversations.find(item => item.source_file === selected)).toMatchObject({ indexed: true, time_basis: "indexed", source_cwd: root, started_at: "2026-09-20T01:00:00.000Z" });
    expect(refreshed.conversations.find(item => item.source_file === first)?.indexed).toBeFalse();
    expect(store.status().jobs).toMatchObject([{ file: first }]);
    await store.discover({ file: selected });
    expect(await store.work(controlled.fixture, keepRepair, { file: selected })).toMatchObject({ completed: 0, calls: 0 });
  });

  it("clusters cross-cwd translations together while separating unrelated same-cwd discussions", async () => {
    const { root, directory, store } = await setup();
    const controlled = model();
    await index(store, controlled.fixture, await writeSession(path.join(directory, "one"), "/work/storage", "A"));
    await index(store, controlled.fixture, await writeSession(path.join(directory, "two"), "/work/translated", "B", ["持久化失败，写入不能确认"]));
    await index(store, controlled.fixture, await writeSession(path.join(directory, "three"), "/work/storage", "C", ["调整按钮间距和颜色"]));
    expect(topicOf(store, "A")).toBe(topicOf(store, "B"));
    expect(topicOf(store, "C")).not.toBe(topicOf(store, "A"));
    expect(topics(store)).toHaveLength(2);
    store.setSourceAccess({ sessionDir: path.join(root, "third-cwd"), activeSessionId: "active-session" });
    expect((store.browse({ topic_id: topicOf(store, "A") }).entries as Conversation[]).map(item => item.session_id).sort()).toEqual(["A", "B"]);
    expect((await store.search(["WAL", "持久化失败"])).conversations.map(item => item.session_id).sort()).toEqual(["A", "B"]);
    expect(conversation(store, "B").source_cwd).toBe("/work/translated");
  });

  it("keeps same-title topics distinct and compares relevant cards beyond the fortieth", async () => {
    const { root, directory, store } = await setup();
    const controlled = model((request, fallback) => {
      if (request.stage === "analysis_final" || request.stage === "analysis_map" || request.stage === "analysis_reduce") {
        return { ...fallback, facets: (fallback.facets as Facet[]).map(facet => ({ ...facet, title: "Shared title", aliases: ["Shared title"] })) };
      }
      return fallback;
    });
    for (let i = 0; i < 43; i++) {
      const file = await writeSession(directory, root, `seed-${i}`, [`Discussion scope: scope-${i}.`]);
      await index(store, controlled.fixture, file);
    }
    expect(topics(store)).toHaveLength(43);
    expect(new Set(topics(store).map(topic => topic.title))).toEqual(new Set(["Shared title"]));
    const ordered = store.db.query<{ id: string }, [string]>("SELECT id FROM hr_topics WHERE scope_id=? ORDER BY created_at,id").all(store.scope.id);
    const target = ordered[42].id;
    const targetSession = conversations(store).find(item => item.memberships.some(member => member.topic_id === target))!;
    const targetScope = targetSession.session_id.replace("seed-", "scope-");
    await index(store, controlled.fixture, await writeSession(directory, "/different/cwd", "match-42", [`Discussion scope: ${targetScope}.`]));
    expect(topicOf(store, "match-42")).toBe(target);
  }, 30000);

  it("preserves real evidence and lexical hit counts across multiple memberships and topic-only updates", async () => {
    const { root, directory, store } = await setup();
    const controlled = model();
    const file = await writeSession(directory, root, "mixed", ["Discussion scope: storage. WAL fsync failed.", "Discussion scope: ui. Adjust button spacing."]);
    await index(store, controlled.fixture, file);
    const item = conversation(store, "mixed");
    const original = await store.readConversation(item.id);
    expect(original.memberships).toHaveLength(2);
    for (const membership of original.memberships) {
      for (const ref of membership.evidence_refs) expect(original.fragments.find(fragment => fragment.entry_id === ref.entry_id)?.sha256).toBe(ref.sha256);
    }
    const hits = (await store.search(["WAL"], { conversation_id: item.id })).conversations[0].lexical_hits;
    expect(hits).toBe(1);
    const storageTopic = item.memberships[0].topic_id;
    expect((await store.search(["WAL"], { topic_id: storageTopic })).conversations[0].lexical_hits).toBe(hits);
    const before = entrySnapshot(store, item.id);
    await index(store, controlled.fixture, await writeSession(directory, root, "storage-only", ["Discussion scope: storage. Another sync failure."]));
    await index(store, controlled.fixture, file, true, renameRepair(storageTopic, "Storage persistence"));
    const after = await store.readConversation(item.id);
    expect(after.evidence_id).toBe(original.evidence_id);
    expect(after.fragments).toEqual(original.fragments);
    expect(entrySnapshot(store, item.id)).toEqual(before);
    expect((await store.search(["WAL"], { conversation_id: item.id })).conversations[0].lexical_hits).toBe(hits);
  });

  it("deduplicates conversation rows and counts distinct members when two facets select one topic", async () => {
    const { root, directory, store } = await setup();
    await index(store, model().fixture, await writeSession(directory, root, "seed"));
    const selected = topicOf(store, "seed");
    const controlled = model((request, fallback) => request.stage === "select_topic" ? selection(request, selected) : fallback);
    await index(store, controlled.fixture, await writeSession(directory, root, "mixed", ["Discussion scope: storage. WAL", "Discussion scope: ui. WAL"]));
    expect(conversation(store, "mixed").memberships.map(member => member.topic_id)).toEqual([selected, selected]);
    expect(topics(store)[0].member_count).toBe(2);
    expect(store.browse({ topic_id: selected }).entries).toHaveLength(2);
    expect((await store.search(["WAL"], { topic_id: selected })).conversations.find(item => item.session_id === "mixed")?.lexical_hits).toBe(2);
  });

  it("renames after one complete evidence audit while preserving the established topic identity", async () => {
    const { root, directory, store } = await setup();
    const controlled = model();
    await index(store, controlled.fixture, await writeSession(directory, root));
    const id = topicOf(store, "s1");
    const result = await index(store, controlled.fixture, await writeSession(directory, root, "second"), false,
      renameRepair(id, "Storage persistence"));
    expect(result.topic_changes.updated).toBe(1);
    expect(topicOf(store, "second")).toBe(id);
    expect(topics(store)).toMatchObject([{ id, title: "Storage persistence", aliases: expect.arrayContaining(["WAL failures"]) }]);
  });

  it("rejects unknown selection references without publishing incoming state", async () => {
    const { root, directory, store } = await setup();
    await index(store, model().fixture, await writeSession(directory, root));
    const file = await writeSession(directory, root, "second");
    const before = store.status();
    const broken = model((request, fallback) => request.stage === "select_topic"
      ? { topic_id: "invented", candidate_ids: ["invented"], reason: "No valid reference." } : fallback);
    await store.discover({ file });
    expect(await store.work(broken.fixture, keepRepair, { file, maxCalls: 100 })).toMatchObject({ completed: 0, failed: 1,
      errors: [{ code: "invalid_model_output" }], topic_changes: { created: 0, updated: 0, merged: 0, reassigned: 0 } });
    expect(store.status().revision).toBe(before.revision);
    expect(conversations(store).map(item => item.session_id)).toEqual(["s1"]);
  });

  it("reads same-branch context and filters original lexical hits using indexed time metadata", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root, "forked", ["root durable-write question", "matched fsync answer", "branch A poisoned writer"]);
    await fs.appendFile(file, JSON.stringify({ type: "message", id: "alternate", parentId: "forked-1", timestamp: "2026-09-20T01:04:00Z", message: { role: "user", content: "branch B alternate compaction" } }) + "\n");
    await index(store, model().fixture, file);
    const id = conversation(store, "forked").id;
    expect((await store.search(["fsync"], { conversation_id: id })).conversations[0].matched_entry_ids).toEqual(["forked-1"]);
    const context = await store.readConversation(id, { entry_id: "forked-1", before: 1, after: 2, maxChars: 12000 });
    expect(context.context).toEqual({ entry_id: "forked-1", before: 1, after: 2, alternate_children: ["forked-2"] });
    expect(context.fragments.map(fragment => fragment.entry_id)).toEqual(["forked-0", "forked-1", "alternate"]);
    expect(store.browse({ from: "2026-09-21", to: "2026-09-22" }).entries).toHaveLength(0);
    expect(store.browse({ from: "2026-09-20T00:00:00+08:00", to: "2026-09-21T00:00:00+08:00" }).entries).toHaveLength(1);
  });

  it("excludes the active session by path and identity and fails closed on changed evidence", async () => {
    const { root, directory, scope, access, store } = await setup();
    const file = await writeSession(directory, root);
    await index(store, model().fixture, file);
    const id = conversation(store, "s1").id;
    const resumed = connection(store, scope, { ...access, activeSessionId: "s1", activeFile: file });
    expect((await resumed.catalog()).conversations).toHaveLength(0);
    expect(resumed.browse().entries).toHaveLength(0);
    expect((await resumed.search(["WAL"])).conversations).toHaveLength(0);
    expect(resumed.status()).toMatchObject({ conversations: 0, topics: 0, indexed_entries: 0 });
    await expect(resumed.readConversation(id)).rejects.toMatchObject({ code: "not_found" });
    const copy = path.join(directory, "copied.jsonl");
    await fs.copyFile(file, copy);
    await resumed.discover({ file: copy });
    const copied = await resumed.work(model().fixture, keepRepair, { file: copy });
    expect(copied.completed).toBe(0);
    expect(copied.calls).toBe(0);
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("WAL fsync failed", "WAL corrected"));
    await expect(store.readConversation(id)).rejects.toMatchObject({ code: "stale_evidence" });
  });
});

async function movementSetup() {
  const state = await setup();
  const controlled = model();
  for (const [id, scope] of [["subject", "A"], ["anchor-A", "A"], ["anchor-B", "B"], ["anchor-C", "C"]]) {
    await index(state.store, controlled.fixture, await writeSession(state.directory, state.root, id, [`Discussion scope: ${scope}.`]));
  }
  return { ...state, subject: conversation(state.store, "subject").id,
    targets: { A: topicOf(state.store, "anchor-A"), B: topicOf(state.store, "anchor-B"), C: topicOf(state.store, "anchor-C") } };
}

async function mergeSetup() {
  const state = await setup();
  const separate = model((request, fallback) => request.stage === "select_topic" ? selection(request, null) : fallback);
  for (const id of ["seed-A", "seed-B"]) await index(state.store, separate.fixture,
    await writeSession(state.directory, state.root, id, ["Discussion scope: storage. WAL durability failure."]));
  const pair = [topicOf(state.store, "seed-A"), topicOf(state.store, "seed-B")];
  const survivor = state.store.db.query<{ id: string }, [string]>("SELECT id FROM hr_topics WHERE scope_id=? ORDER BY created_at,id").get(state.scope.id)!.id;
  const plan = proposal({ merge: { leftTopicId: pair[0], rightTopicId: pair[1], descriptor: descriptor("storage"), reason: "Both histories concern failed WAL durability." } });
  const merging = repairRunner(async driver => { await driver.topics(); return driver.commit(plan); });
  return { ...state, pair, survivor, plan, merging };
}

describe("complete-evidence historical repair", () => {
  it("moves a historical member immediately without requiring incoming membership in its destination", async () => {
    const { root, directory, store, subject, targets } = await movementSetup();
    const original = await store.readConversation(subject);
    const stored = entrySnapshot(store, subject);
    const repair = repairRunner(async driver => {
      const member = driver.input.audit.find(item => item.conversation_id === subject)!;
      return driver.commit(proposal({ moves: [{ conversationId: member.conversation_id, sourceHash: member.source_hash,
        facetId: member.facet_id, fromTopicRef: member.topic_id, targetRef: targets.B, reason: "Historical evidence belongs with B." }] }));
    });
    const result = await index(store, model().fixture, await writeSession(directory, root, "incoming", ["Discussion scope: C."]), false, repair);
    expect(result.topic_changes.reassigned).toBe(1);
    expect(topicOf(store, "subject")).toBe(targets.B);
    expect(topicOf(store, "incoming")).toBe(targets.C);
    const moved = await store.readConversation(subject);
    expect(moved.evidence_id).toBe(original.evidence_id);
    expect(moved.fragments).toEqual(original.fragments);
    expect(entrySnapshot(store, subject)).toEqual(stored);
    expect(moved.memberships[0].reason).toBe("Historical evidence belongs with B.");
  });

  it("creates a historical-only split and narrows the remaining definition after covering every final member", async () => {
    const { root, directory, store } = await setup();
    await index(store, model().fixture, await writeSession(directory, root, "A", ["WAL fsync failed; writes must not be acknowledged."]));
    const broad = topicOf(store, "A");
    const misclassified = model((request, fallback) => request.stage === "select_topic" ? selection(request, broad) : fallback);
    await index(store, misclassified.fixture, await writeSession(directory, root, "B", ["调整按钮间距和颜色"]));
    const movedId = conversation(store, "B").id;
    const original = await store.readConversation(movedId);
    const stored = entrySnapshot(store, movedId);
    let repairId = "";
    const checked: string[] = [];
    const repair = repairRunner(async driver => {
      const member = driver.input.audit.find(item => item.conversation_id === movedId)!;
      const completion = await driver.commit(proposal({
        drafts: [{ ref: "repair:0", descriptor: descriptor("ui") }],
        updates: [{ topicId: broad, descriptor: { ...descriptor("storage"), title: "Durable WAL acknowledgement" }, reason: "Only durability discussions remain." }],
        moves: [{ conversationId: movedId, sourceHash: member.source_hash, facetId: member.facet_id, fromTopicRef: broad,
          targetRef: "repair:0", reason: "The original conversation is about interface layout, not durability." }],
      }), member => { checked.push(member.conversation_id); return true; });
      repairId = completion.proposal_id!;
      return completion;
    });
    const result = await index(store, model().fixture, await writeSession(directory, root, "C", ["Discussion scope: storage. Failed sync is not acknowledged."]), false, repair);
    expect(result.topic_changes).toEqual({ created: 1, updated: 1, merged: 0, reassigned: 1 });
    expect(topics(store)).toHaveLength(2);
    expect(topicOf(store, "A")).toBe(broad);
    expect(topicOf(store, "C")).toBe(broad);
    expect(topicOf(store, "B")).not.toBe(broad);
    expect(new Set(checked)).toEqual(new Set(conversations(store).map(item => item.id)));
    expect(entrySnapshot(store, movedId)).toEqual(stored);
    const after = await store.readConversation(movedId);
    expect(after.evidence_id).toBe(original.evidence_id);
    expect(after.fragments).toEqual(original.fragments);
    const events = store.db.query<{ kind: string; payload: string }, [string]>("SELECT kind,payload FROM hr_topic_events WHERE scope_id=?").all(store.scope.id)
      .filter(event => JSON.parse(event.payload).repair_id === repairId);
    expect(new Set(events.map(event => event.kind))).toEqual(new Set(["create", "move", "update"]));
  });

  it("merges in one run after full coverage while preserving original storage and assignment history", async () => {
    const { root, directory, store, pair, survivor, plan } = await mergeSetup();
    const old = conversation(store, "seed-B");
    const original = await store.readConversation(old.id);
    const stored = entrySnapshot(store, old.id);
    const assignments = store.db.query<{ conversation_id: string; facet_id: string; assigned_at: string; reason: string }, [string]>(
      "SELECT conversation_id,facet_id,assigned_at,reason FROM hr_memberships WHERE scope_id=? ORDER BY conversation_id,facet_id").all(store.scope.id);
    store.db.run(`CREATE TEMP TRIGGER protect_old_entries BEFORE DELETE ON hr_entries WHEN old.conversation_id='${old.id}' BEGIN SELECT RAISE(ABORT,'original entries must not be rewritten'); END`);
    const checked: string[] = [];
    const repair = repairRunner(async driver => {
      await driver.topics();
      return driver.commit(plan, member => { checked.push(`${member.conversation_id}:${member.facet_id}`); return true; });
    });
    const result = await index(store, model().fixture, await writeSession(directory, root, "incoming"), false, repair);
    expect(result.topic_changes.merged).toBe(1);
    expect(topics(store)).toMatchObject([{ id: survivor, member_count: 3 }]);
    expect(new Set(conversations(store).flatMap(item => item.memberships.map(member => member.topic_id)))).toEqual(new Set([survivor]));
    expect(store.browse({ topic_id: survivor }).entries).toHaveLength(3);
    expect(entrySnapshot(store, old.id)).toEqual(stored);
    for (const previous of assignments) expect(store.db.query("SELECT conversation_id,facet_id,assigned_at,reason FROM hr_memberships WHERE scope_id=? AND conversation_id=? AND facet_id=?")
      .get(store.scope.id, previous.conversation_id, previous.facet_id)).toEqual(previous);
    const after = await store.readConversation(old.id);
    expect(after.evidence_id).toBe(original.evidence_id);
    expect(after.fragments).toEqual(original.fragments);
    expect(new Set(checked)).toEqual(new Set(conversations(store).flatMap(item => item.memberships.map(member => `${item.id}:${member.facet_id}`))));
    const event = store.db.query<{ payload: string }, [string]>("SELECT payload FROM hr_topic_events WHERE scope_id=? AND kind='merge'").get(store.scope.id)!;
    expect(JSON.parse(event.payload)).toMatchObject({ repair_id: expect.any(String), before: expect.anything(), after: expect.anything() });
    expect(event.payload).toContain(pair.find(id => id !== survivor)!);
    expect(event.payload).toContain(survivor);
  });

  it("covers the final merge set after moves into and out of the pair and replaces old incoming facets", async () => {
    const { root, directory, store, pair, survivor, plan } = await mergeSetup();
    const controlled = model();
    await index(store, controlled.fixture, await writeSession(directory, root, "outside", ["Discussion scope: ui."]));
    const outsideTopic = topicOf(store, "outside");
    const leaving = conversation(store, "seed-B").id;
    const entering = conversation(store, "outside").id;
    const incoming = await writeSession(directory, root, "replaced", ["Discussion scope: ui."]);
    await index(store, controlled.fixture, incoming);
    const incomingId = conversation(store, "replaced").id;
    await writeSession(directory, root, "replaced", ["Discussion scope: storage. Corrected current source."]);
    const checked = new Map<string, string[]>();
    const repair = repairRunner(async driver => {
      const left = driver.input.audit.find(member => member.conversation_id === leaving)!;
      const right = driver.input.audit.find(member => member.conversation_id === entering)!;
      return driver.commit({ ...plan, moves: [
        { conversationId: leaving, sourceHash: left.source_hash, facetId: left.facet_id, fromTopicRef: left.topic_id, targetRef: outsideTopic, reason: "This original member belongs outside the merged scope." },
        { conversationId: entering, sourceHash: right.source_hash, facetId: right.facet_id, fromTopicRef: right.topic_id, targetRef: pair[1], reason: "This original member belongs inside the merged scope." },
      ] }, (member, target) => {
        checked.set(target, [...(checked.get(target) ?? []), member.conversation_id]);
        if (member.conversation_id === incomingId) expect(member.descriptor.description).toBe("Discussion of storage.");
        return true;
      });
    });
    const result = await index(store, controlled.fixture, incoming, true, repair);
    expect(result.topic_changes).toMatchObject({ merged: 1, reassigned: 3 });
    expect(new Set(checked.get(survivor))).toEqual(new Set([conversation(store, "seed-A").id, entering, incomingId]));
    expect(checked.get(outsideTopic)).toEqual([leaving]);
    expect(topicOf(store, "seed-B")).toBe(outsideTopic);
    expect(topicOf(store, "outside")).toBe(survivor);
    expect(topicOf(store, "replaced")).toBe(survivor);
  });

  it("rejects an entire repair and incoming publication when any final member does not fit", async () => {
    const { root, directory, store, plan } = await mergeSetup();
    const rejected = conversation(store, "seed-B").id;
    const revision = store.status().revision;
    const repair = repairRunner(async driver => { await driver.topics(); return driver.commit(plan, member => member.conversation_id !== rejected); });
    const file = await writeSession(directory, root, "incoming");
    await store.discover({ file });
    expect(await store.work(model().fixture, repair, { file, maxCalls: 100 })).toMatchObject({ completed: 0, failed: 1,
      errors: [{ code: "invalid_model_output" }], topic_changes: { created: 0, updated: 0, merged: 0, reassigned: 0 } });
    expect(store.status().revision).toBe(revision);
    expect(topics(store)).toHaveLength(2);
    expect(conversations(store).map(item => item.session_id)).toEqual(["seed-A", "seed-B"]);
  });

  it("rejects fabricated proof references atomically and retains successful semantic caches for retry", async () => {
    const { root, directory, store, plan, merging } = await mergeSetup();
    const file = await writeSession(directory, root, "incoming");
    const revision = store.status().revision;
    const controlled = model();
    const broken = repairRunner(async driver => {
      await driver.topics();
      const staged = await driver.propose(plan);
      const page = await driver.call<{ page_id: string }>("repair_coverage", { proposal_id: staged.proposal_id, target_ref: staged.coverage_targets[0].target_ref });
      await driver.call("repair_check", { proposal_id: staged.proposal_id, page_id: page.page_id,
        fits: [{ conversation_id: "invented", facet_id: "f0", fits: true }] });
      return { proposal_id: staged.proposal_id, reason: "Attempted an invalid member proof." };
    });
    await store.discover({ file });
    expect(await store.work(controlled.fixture, broken, { file, maxCalls: 100 })).toMatchObject({ completed: 0, failed: 1,
      errors: [{ code: "invalid_model_output" }], topic_changes: { created: 0, updated: 0, merged: 0, reassigned: 0 } });
    expect(store.status().revision).toBe(revision);
    expect(conversations(store)).toHaveLength(2);
    const paid = controlled.requests.map(request => JSON.stringify(request));
    await index(store, controlled.fixture, file, true, merging);
    for (const request of paid) expect(controlled.requests.filter(item => JSON.stringify(item) === request)).toHaveLength(1);
    expect(topics(store)).toHaveLength(1);
  });

  it("does not publish an incomplete coverage page even after staging a valid definition", async () => {
    const { root, directory, store, plan } = await mergeSetup();
    const revision = store.status().revision;
    const unfinished = repairRunner(async driver => {
      await driver.topics();
      const staged = await driver.propose(plan);
      await driver.call("repair_coverage", { proposal_id: staged.proposal_id, target_ref: staged.coverage_targets[0].target_ref });
      return { proposal_id: staged.proposal_id, reason: "Stopped without confirming the remaining member proof." };
    });
    const file = await writeSession(directory, root, "incoming");
    await store.discover({ file });
    expect(await store.work(model().fixture, unfinished, { file, maxCalls: 100 })).toMatchObject({ completed: 0, failed: 1,
      errors: [{ code: "invalid_model_output" }], topic_changes: { created: 0, updated: 0, merged: 0, reassigned: 0 } });
    expect(store.status().revision).toBe(revision);
    expect(conversations(store)).toHaveLength(2);
  });

  it("shares the analysis and selection quota with repair admission and publishes nothing on exhaustion", async () => {
    const { root, directory, store, merging } = await mergeSetup();
    const file = await writeSession(directory, root, "incoming");
    const controlled = model();
    const baseline = store.status().indexing_calls_today;
    const revision = store.status().revision;
    let admitted = 0;
    const budgeted: RepairRunner = async request => { request.budget.reserve(); admitted++; return merging(request); };
    await store.discover({ file });
    expect(await store.work(controlled.fixture, budgeted, { file, maxCalls: 2 })).toMatchObject({ completed: 0, failed: 1,
      calls: 2, errors: [{ code: "work_budget" }], topic_changes: { created: 0, updated: 0, merged: 0, reassigned: 0 } });
    expect(admitted).toBe(0);
    expect(store.status().revision).toBe(revision);
    expect(conversations(store)).toHaveLength(2);
    await store.discover({ file, force: true });
    expect(await store.work(controlled.fixture, budgeted, { file, maxCalls: 1 })).toMatchObject({ completed: 1, failed: 0,
      calls: 1, topic_changes: { merged: 1 } });
    expect(admitted).toBe(1);
    expect(store.status().indexing_calls_today).toBe(baseline + controlled.requests.length + admitted);
  });

  it("rejects updates and merges involving an active topic rather than proving a filtered member subset", async () => {
    const { root, directory, store, scope, access, pair, plan } = await mergeSetup();
    const sameTopic = model((request, fallback) => request.stage === "select_topic" ? selection(request, pair[0]) : fallback);
    await index(store, sameTopic.fixture, await writeSession(directory, root, "inactive-A", ["Discussion scope: storage. Inactive member of the active topic."]));
    const active = connection(store, scope, { ...access, activeSessionId: "seed-A" });
    const file = await writeSession(directory, root, "incoming");
    const revision = store.status().revision;
    for (const change of [plan, proposal({ updates: [{ topicId: pair[0], descriptor: { ...descriptor("storage"), title: "Replacement" }, reason: "Attempt to redefine an active topic." }] })]) {
      const repair = repairRunner(async driver => {
        expect((await driver.topics()).find(topic => topic.id === pair[0])?.repairable).toBeFalse();
        return driver.commit(change);
      });
      await active.discover({ file, force: true });
      expect(await active.work(model().fixture, repair, { file, maxCalls: 100 })).toMatchObject({ completed: 0, failed: 1,
        errors: [{ code: "invalid_model_output" }], topic_changes: { created: 0, updated: 0, merged: 0, reassigned: 0 } });
      expect(store.status().revision).toBe(revision);
      expect(conversations(store)).toHaveLength(3);
    }
  });
});

describe("bounded work, cache recovery and publication isolation", () => {
  it("resumes serial analysis across batch limits without repeating paid chunks", async () => {
    const { root, directory, store } = await setup();
    const file = await writeLargeSession(directory, root);
    const controlled = model(undefined, { contextWindow: 8192, maxOutputTokens: 1024 });
    await store.discover({ file });
    expect(await store.work(controlled.fixture, keepRepair, { concurrency: 1, maxCalls: 1 })).toMatchObject({ completed: 0, failed: 1, calls: 1, errors: [{ code: "work_budget" }] });
    const paid = controlled.requests.map(request => JSON.stringify(request));
    await store.discover({ file, force: true });
    expect(await store.work(controlled.fixture, keepRepair, { concurrency: 1, maxCalls: 100 })).toMatchObject({ completed: 1, failed: 0, calls: controlled.requests.length - 1 });
    for (const request of paid) expect(controlled.requests.filter(item => JSON.stringify(item) === request)).toHaveLength(1);
    expect(store.status().indexing_calls_today).toBe(controlled.requests.length);
  });

  it("counts failed provider calls against reported usage", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    let calls = 0;
    const unavailable: JsonModel = { identity: "unavailable", generate: async () => { calls++; throw new Error("Provider unavailable"); } };
    await store.discover({ file });
    expect(await store.work(unavailable, keepRepair)).toMatchObject({ completed: 0, failed: 1, calls: 1, errors: [{ code: "index_error" }] });
    expect(calls).toBe(1);
    expect(store.status().indexing_calls_today).toBe(1);
  });

  it("evicts an invalid serial evidence reference without discarding a validated earlier chunk", async () => {
    const { root, directory, store } = await setup();
    const file = await writeLargeSession(directory, root);
    const controlled = model((_request, fallback) => controlled.requests.length === 2
      ? { ...fallback, facets: [{ ...descriptor("storage"), evidence_entry_ids: ["not-an-entry"] }] } : fallback,
    { contextWindow: 8192, maxOutputTokens: 1024 });
    await store.discover({ file });
    expect(await store.work(controlled.fixture, keepRepair, { concurrency: 1, maxCalls: 100 })).toMatchObject({ completed: 0, failed: 1, calls: 2, errors: [{ code: "invalid_model_output" }] });
    const [valid, invalid] = controlled.requests.map(request => JSON.stringify(request));
    await index(store, controlled.fixture, file, true);
    expect(controlled.requests.filter(request => JSON.stringify(request) === valid)).toHaveLength(1);
    expect(controlled.requests.filter(request => JSON.stringify(request) === invalid)).toHaveLength(2);
  });

  it("retains late good siblings and evicts every malformed sibling after an out-of-order failure", async () => {
    const { root, directory, store } = await setup();
    const file = await writeLargeSession(directory, root);
    const gated = gatedModel(3);
    await store.discover({ file });
    const work = store.work(gated.fixture, keepRepair, { concurrency: 3, maxCalls: 100 });
    cleanup.push(async () => { gated.release(); await work; });
    let settled = false;
    void work.then(() => { settled = true; });
    await gated.started;
    gated.gates[1].resolve({ summary: "Invalid evidence", facets: [{ ...descriptor("storage"), evidence_entry_ids: ["invented"] }] });
    await tick();
    expect(settled).toBeFalse();
    gated.resolve(0);
    await tick();
    expect(settled).toBeFalse();
    gated.gates[2].resolve({ summary: "Invalid facet collection", facets: "not an array" });
    expect(await work).toMatchObject({ completed: 0, failed: 1, calls: 3, errors: [{ code: "invalid_model_output" }] });
    const [valid, invalidFirst, invalidLast] = gated.requests.map(request => JSON.stringify(request));
    await store.discover({ file, force: true });
    expect(await store.work(gated.fixture, keepRepair, { concurrency: 2, maxCalls: 100 })).toMatchObject({ completed: 1, failed: 0 });
    expect(gated.requests.filter(request => JSON.stringify(request) === valid)).toHaveLength(1);
    expect(gated.requests.filter(request => JSON.stringify(request) === invalidFirst)).toHaveLength(2);
    expect(gated.requests.filter(request => JSON.stringify(request) === invalidLast)).toHaveLength(2);
    expect(store.status().indexing_calls_today).toBe(gated.requests.length);
  });

  it("reserves batch and daily quotas before overlapping calls and drains every admitted request", async () => {
    const { root, directory, store } = await setup();
    const file = await writeLargeSession(directory, root);
    const batch = gatedModel(2);
    await store.discover({ file });
    const batchWork = store.work(batch.fixture, keepRepair, { concurrency: 5, maxCalls: 2 });
    cleanup.push(async () => { batch.release(); await batchWork; });
    let batchSettled = false;
    void batchWork.then(() => { batchSettled = true; });
    await batch.started;
    await tick();
    expect(batch.requests).toHaveLength(2);
    expect(store.status().indexing_calls_today).toBe(2);
    expect(batchSettled).toBeFalse();
    batch.release();
    expect(await batchWork).toMatchObject({ completed: 0, failed: 1, calls: 2, errors: [{ code: "work_budget" }] });

    const daily = gatedModel(2);
    await store.discover({ file, force: true });
    const dailyWork = store.work(daily.fixture, keepRepair, { concurrency: 5, maxCalls: 2 });
    cleanup.push(async () => { daily.release(); await dailyWork; });
    let dailySettled = false;
    void dailyWork.then(() => { dailySettled = true; });
    await daily.started;
    await tick();
    expect(daily.requests).toHaveLength(2);
    expect(store.status().indexing_calls_today).toBe(4);
    expect(dailySettled).toBeFalse();
    daily.release();
    expect(await dailyWork).toMatchObject({ completed: 0, failed: 1, calls: 2, errors: [{ code: "work_budget" }] });
    const admitted = [...batch.requests, ...daily.requests].map(request => JSON.stringify(request));
    await store.discover({ file, force: true });
    expect(await store.work(daily.fixture, keepRepair, { concurrency: 32, maxCalls: 100 })).toMatchObject({ completed: 1, failed: 0 });
    const all = [...batch.requests, ...daily.requests].map(request => JSON.stringify(request));
    for (const request of admitted) expect(all.filter(item => item === request)).toHaveLength(1);
    expect(store.status().indexing_calls_today).toBe(all.length);
  });

  it("keeps the claimed lease after provider failure until all in-flight siblings settle", async () => {
    const { root, directory, scope, access, store } = await setup();
    const file = await writeLargeSession(directory, root);
    const competitor = connection(store, scope, access);
    const gated = gatedModel(3);
    await store.discover({ file });
    const work = store.work(gated.fixture, keepRepair, { file, concurrency: 3, maxCalls: 100 });
    cleanup.push(async () => { gated.release(); await work; });
    let settled = false;
    void work.then(() => { settled = true; });
    await gated.started;
    const lease = store.db.query<{ token: string; lease_until: number; error: string | null }, [string, string]>(
      "SELECT token,lease_until,error FROM hr_jobs WHERE scope_id=? AND file=?");
    const owned = lease.get(scope.id, file)!;
    expect(owned.lease_until).toBeGreaterThan(Date.now());
    gated.gates[0].reject(new Error("Provider unavailable"));
    await tick();
    expect(settled).toBeFalse();
    expect(lease.get(scope.id, file)).toEqual(owned);
    await competitor.discover({ file, force: true });
    expect(await competitor.work(model().fixture, keepRepair, { file })).toMatchObject({ completed: 0, calls: 0 });
    gated.resolve(2);
    await tick();
    expect(settled).toBeFalse();
    expect(lease.get(scope.id, file)).toEqual(owned);
    gated.resolve(1);
    expect(await work).toMatchObject({ completed: 0, failed: 1, calls: 3, errors: [{ code: "index_error" }] });
    expect(lease.get(scope.id, file)).toMatchObject({ token: "", lease_until: 0, error: "index_error" });
    const [failed, second, third] = gated.requests.map(request => JSON.stringify(request));
    await store.discover({ file, force: true });
    expect(await competitor.work(gated.fixture, keepRepair, { file, concurrency: 3, maxCalls: 100 })).toMatchObject({ completed: 1, failed: 0 });
    expect(gated.requests.filter(request => JSON.stringify(request) === failed)).toHaveLength(2);
    expect(gated.requests.filter(request => JSON.stringify(request) === second)).toHaveLength(1);
    expect(gated.requests.filter(request => JSON.stringify(request) === third)).toHaveLength(1);
  });

  it("rejects a captured revision conflict without publishing and reuses analysis on the next explicit attempt", async () => {
    const { root, directory, scope, access, store } = await setup();
    await index(store, model().fixture, await writeSession(directory, root, "seed"));
    const competitor = connection(store, scope, access);
    const blocked = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let pause = true;
    const controlled = model(async (request, fallback) => {
      if (request.stage === "select_topic" && pause) { entered.resolve(); await blocked.promise; }
      return fallback;
    });
    const first = await writeSession(directory, root, "paused");
    await store.discover({ file: first });
    const work = store.work(controlled.fixture, keepRepair, { file: first, maxCalls: 100 });
    cleanup.push(async () => { blocked.resolve(); await work; });
    await entered.promise;
    await index(competitor, model().fixture, await writeSession(directory, "/other/cwd", "other", ["Discussion scope: ui."]));
    const revision = competitor.status().revision;
    blocked.resolve();
    expect(await work).toMatchObject({ completed: 0, failed: 1, errors: [{ code: "topic_state_changed" }], topic_changes: { created: 0, updated: 0, merged: 0, reassigned: 0 } });
    expect(store.status().revision).toBe(revision);
    expect(conversations(store).map(item => item.session_id)).toEqual(["other", "seed"]);
    expect(store.db.query<{ attempts: number; retry_at: number }, [string, string]>("SELECT attempts,retry_at FROM hr_jobs WHERE scope_id=? AND file=?").get(scope.id, first))
      .toMatchObject({ attempts: 0 });
    pause = false;
    await index(store, controlled.fixture, first, true);
    expect(controlled.requests.filter(request => request.stage.startsWith("analysis_"))).toHaveLength(1);
    expect(topicOf(store, "paused")).toBe(topicOf(store, "seed"));
  });

  it("binds analysis caches to model limits and source, not topic catalog revisions", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    const first = model(undefined, { contextWindow: 32768, maxOutputTokens: 1024 });
    await index(store, first.fixture, file);
    await index(store, first.fixture, await writeSession(directory, root, "unrelated", ["Discussion scope: ui."]));
    await index(store, first.fixture, file, true);
    expect(first.requests.filter(request => request.stage.startsWith("analysis_"))).toHaveLength(2);
    const smaller = model(undefined, { contextWindow: 16384, maxOutputTokens: 1024 });
    await index(store, smaller.fixture, file, true);
    expect(smaller.requests.filter(request => request.stage.startsWith("analysis_"))).toHaveLength(1);
    const outputChanged = model(undefined, { contextWindow: 16384, maxOutputTokens: 2048 });
    await index(store, outputChanged.fixture, file, true);
    expect(outputChanged.requests.filter(request => request.stage.startsWith("analysis_"))).toHaveLength(1);
    const before = outputChanged.requests.length;
    await index(store, outputChanged.fixture, file, true);
    expect(outputChanged.requests.slice(before).filter(request => request.stage.startsWith("analysis_"))).toHaveLength(0);
  });

  it("rejects a poisoned complete-analysis cache and evicts precisely that entry", async () => {
    const { root, directory, store } = await setup();
    const controlled = model();
    const file = await writeSession(directory, root);
    await index(store, controlled.fixture, file);
    const rows = store.db.query<{ key: string; payload: string }, [string]>("SELECT key,payload FROM hr_cache WHERE scope_id=? ORDER BY key").all(store.scope.id);
    const complete = rows.find(row => {
      const parsed: unknown = JSON.parse(row.payload);
      return !!parsed && typeof parsed === "object" && "facets" in parsed && Array.isArray(parsed.facets)
        && parsed.facets.some((facet: unknown) => !!facet && typeof facet === "object" && "id" in facet && facet.id === "f0");
    });
    expect(complete).toBeDefined();
    if (!complete) throw new Error("No complete analysis cache was persisted");
    const poisoned = JSON.parse(complete.payload) as { facets: { evidence_entry_ids: string[] }[] };
    poisoned.facets[0].evidence_entry_ids = ["invented-entry"];
    store.db.query("UPDATE hr_cache SET payload=? WHERE scope_id=? AND key=?").run(JSON.stringify(poisoned), store.scope.id, complete.key);
    const revision = store.status().revision;
    await store.discover({ file, force: true });
    expect(await store.work(controlled.fixture, keepRepair, { file })).toMatchObject({ completed: 0, failed: 1, calls: 0, errors: [{ code: "invalid_model_output" }] });
    expect(store.status().revision).toBe(revision);
    expect(store.db.query("SELECT key,payload FROM hr_cache WHERE scope_id=? ORDER BY key").all(store.scope.id)).toEqual(rows.filter(row => row.key !== complete.key));
    await index(store, controlled.fixture, file, true);
    expect(controlled.requests.filter(request => request.stage.startsWith("analysis_"))).toHaveLength(1);
  });
});

describe("authorized sources, identity and snapshots", () => {
  it("isolates same-session identities, search, cache and quotas for two profiles sharing one database", async () => {
    const first = await setup();
    const second = await setup();
    const other = connection(first.store, second.scope, second.access);
    const one = await writeSession(first.directory, "/same/cwd", "same-id", ["WAL firstprofileonly"]);
    const two = await writeSession(second.directory, "/same/cwd", "same-id", ["WAL secondprofileonly"]);
    const controlled = model();
    await first.store.discover({ file: one });
    await other.discover({ file: two });
    expect(await first.store.work(controlled.fixture, keepRepair, { file: one })).toMatchObject({ completed: 1, calls: 1 });
    expect(await other.work(controlled.fixture, keepRepair, { file: two })).toMatchObject({ completed: 1, calls: 1 });
    expect(conversation(first.store, "same-id").id).not.toBe(conversation(other, "same-id").id);
    expect(topicOf(first.store, "same-id")).not.toBe(topicOf(other, "same-id"));
    expect(first.store.status()).toMatchObject({ scope_id: first.scope.id, conversations: 1, indexing_calls_today: 1 });
    expect(other.status()).toMatchObject({ scope_id: second.scope.id, conversations: 1, indexing_calls_today: 1 });
    expect((await first.store.catalog()).conversations.map(item => item.source_file)).toEqual([one]);
    expect((await other.catalog()).conversations.map(item => item.source_file)).toEqual([two]);
    expect((await first.store.search(["secondprofileonly"])).conversations).toHaveLength(0);
    await expect(first.store.readConversation(conversation(other, "same-id").id)).rejects.toMatchObject({ code: "not_found" });
    await expect(first.store.discover({ file: two })).rejects.toMatchObject({ code: "invalid_file" });
    const otherCache = other.db.query("SELECT * FROM hr_cache WHERE scope_id=? ORDER BY key").all(second.scope.id);
    first.store.clearSemanticCache();
    expect(other.db.query("SELECT * FROM hr_cache WHERE scope_id=? ORDER BY key").all(second.scope.id)).toEqual(otherCache);
    expect(first.store.status().indexing_calls_today).toBe(1);
  });

  it("enumerates managed buckets, flat current files, exact registry entries and remembered files without widening authorization", async () => {
    const { root, directory, scope, store } = await setup();
    const flat = await writeSession(directory, root, "flat");
    const bucket = await writeSession(path.join(directory, "bucket"), "/bucket/cwd", "bucket");
    const currentDirectory = path.join(root, "current");
    const current = await writeSession(currentDirectory, "/current/cwd", "current");
    const active = await writeSession(currentDirectory, "/current/cwd", "active");
    const exact = await writeSession(path.join(root, "custom"), "/custom/cwd", "exact");
    const sibling = await writeSession(path.join(root, "custom"), root, "not-registered");
    const nested = await writeSession(path.join(directory, "bucket", "artifacts"), root, "nested");
    const outside = await writeSession(path.join(root, "other-profile"), root, "other-profile");
    await fs.symlink(path.dirname(outside), path.join(directory, "linked-bucket"));
    await fs.symlink(outside, path.join(directory, "linked-file.jsonl"));
    await fs.writeFile(path.join(scope.customFilesRoot, "exact"), exact);
    await fs.writeFile(path.join(scope.customFilesRoot, "bad"), "relative.jsonl");
    const missing = path.join(root, "missing.jsonl");
    await fs.writeFile(path.join(scope.customFilesRoot, "missing"), missing);
    store.setSourceAccess({ sessionDir: currentDirectory, activeFile: active, activeSessionId: "active-session" });
    const catalog = await store.catalog({ limit: 50 });
    expect(new Set(catalog.conversations.map(item => item.source_file))).toEqual(new Set([flat, bucket, current, exact]));
    expect(catalog.warnings).toEqual(expect.arrayContaining([
      { path: path.join(scope.customFilesRoot, "bad"), code: "invalid_registry_entry" }, { path: missing, code: "source_missing" },
    ]));
    expect(catalog.conversations.find(item => item.source_file === exact)?.source_kind).toBe("registered");
    for (const file of [sibling, nested, outside]) await expect(store.discover({ file })).rejects.toMatchObject({ code: "invalid_file" });
    const controlled = model();
    await index(store, controlled.fixture, exact);
    await fs.unlink(path.join(scope.customFilesRoot, "exact"));
    expect((await store.catalog({ limit: 50 })).conversations.find(item => item.source_file === exact)?.source_kind).toBe("remembered");
    expect(JSON.stringify(controlled.requests)).not.toContain("not-registered");
    expect(JSON.stringify(controlled.requests)).not.toContain("other-profile");
    // Clearing optional current access never grants the process working directory.
    store.setSourceAccess({ sessionDir: "", activeSessionId: "active-session" });
    expect(new Set((await store.catalog({ limit: 50 })).conversations.map(item => item.source_file))).toEqual(new Set([flat, bucket, exact]));
  });

  it("reports unreadable authorized sources while preserving readable catalog entries", async () => {
    const { root, directory, scope, store } = await setup();
    const readable = await writeSession(directory, root, "readable");
    const locked = await writeSession(path.join(root, "restricted"), root, "locked");
    await fs.writeFile(path.join(scope.customFilesRoot, "locked"), locked);
    await fs.chmod(locked, 0);
    cleanup.push(async () => { await fs.chmod(locked, 0o600); });
    const catalog = await store.catalog();
    expect(catalog.conversations.map(item => item.source_file)).toEqual([readable]);
    expect(catalog.warnings).toContainEqual({ path: locked, code: "source_unreadable" });
    await expect(store.discover({ file: locked })).rejects.toMatchObject({ code: "invalid_file" });
  });

  it("rejects relative, unauthorized and replaced symlink files before a model can read them", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    const outside = await writeSession(root, root, "outside");
    await expect(store.discover({ file: path.basename(file) })).rejects.toMatchObject({ code: "invalid_file" });
    await expect(store.discover({ file: outside })).rejects.toMatchObject({ code: "invalid_file" });
    await store.discover({ file });
    await fs.unlink(file);
    await fs.symlink(outside, file);
    const controlled = model();
    expect(await store.work(controlled.fixture, keepRepair, { file })).toMatchObject({ completed: 0, failed: 1, calls: 0, errors: [{ code: "invalid_file" }] });
    expect(controlled.requests).toHaveLength(0);
    expect(store.status().conversations).toBe(0);
  });

  it("preserves identity on authorized relocation but rejects live duplicates and path identity replacement", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    const controlled = model();
    await index(store, controlled.fixture, file);
    const original = await store.readConversation(conversation(store, "s1").id);
    const moved = path.join(directory, "moved.jsonl");
    await fs.copyFile(file, moved);
    await store.discover({ file: moved });
    expect(await store.work(controlled.fixture, keepRepair, { file: moved })).toMatchObject({ completed: 0, failed: 1, calls: 0, errors: [{ code: "duplicate_session" }] });
    expect(conversation(store, "s1").id).toBe(original.id);
    await fs.unlink(file);
    await index(store, controlled.fixture, moved, true);
    const relocated = await store.readConversation(original.id);
    expect(relocated.source_file).toBe(moved);
    expect(relocated.evidence_id).toBe(original.evidence_id);
    expect(relocated.fragments).toEqual(original.fragments);
    const revision = store.status().revision;
    const text = await fs.readFile(moved, "utf8");
    await fs.writeFile(moved, text.replace('"id":"s1"', '"id":"different-session"'));
    await store.discover({ file: moved, force: true });
    expect(await store.work(controlled.fixture, keepRepair, { file: moved })).toMatchObject({ completed: 0, failed: 1, calls: 0, errors: [{ code: "source_identity_changed" }] });
    expect(store.status().revision).toBe(revision);
    expect(conversation(store, "s1").id).toBe(original.id);
    await expect(store.readConversation(original.id)).rejects.toMatchObject({ code: "stale_evidence" });
  });

  it("publishes the version actually read, not the earlier discovery stamp", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    await store.discover({ file });
    await fs.appendFile(file, JSON.stringify({ type: "message", id: "late", parentId: "s1-2", timestamp: "2026-09-20T02:00:00Z", message: { role: "user", content: "WAL late correction before indexing" } }) + "\n");
    expect(await store.work(model().fixture, keepRepair, { file })).toMatchObject({ completed: 1 });
    expect((await store.readConversation(conversation(store, "s1").id)).fragments.map(fragment => fragment.entry_id)).toContain("late");
    expect(await store.discover({ file })).toMatchObject({ queued: 0 });
  });

  it("pages more than fifty sources with stable ordering and rejects changed snapshot bindings", async () => {
    const { root, directory, scope, access, store } = await setup();
    const files: string[] = [];
    for (let i = 0; i < 57; i++) {
      const file = await writeSession(directory, root, `session-${String(i).padStart(2, "0")}`);
      await fs.utimes(file, 1_000_000 + i % 3, 1_000_000 + i % 3);
      files.push(file);
    }
    const first = await store.catalog({ limit: 50 });
    expect(first.conversations).toHaveLength(50);
    expect(first.next_cursor).not.toBeNull();
    const second = await store.catalog({ cursor: first.next_cursor!, limit: 50 });
    expect(second.conversations).toHaveLength(7);
    expect(second.next_cursor).toBeNull();
    const all = [...first.conversations, ...second.conversations];
    expect(new Set(all.map(item => item.source_file))).toEqual(new Set(files));
    expect(all).toEqual([...all].sort((left, right) => right.mtime_ms - left.mtime_ms || left.source_file.localeCompare(right.source_file)));
    await expect(store.catalog({ cursor: first.next_cursor!, limit: 49 })).rejects.toMatchObject({ code: "stale_cursor" });
    store.setSourceAccess({ ...access, activeFile: files[0] });
    await expect(store.catalog({ cursor: first.next_cursor!, limit: 50 })).rejects.toMatchObject({ code: "stale_cursor" });
    store.setSourceAccess(access);
    const resumed = connection(store, scope, { ...access, activeSessionId: "other-active" });
    await expect(resumed.catalog({ cursor: first.next_cursor!, limit: 50 })).rejects.toMatchObject({ code: "stale_cursor" });
    const controller = new AbortController();
    controller.abort(new Error("cancel catalog"));
    await expect(store.catalog({ signal: controller.signal })).rejects.toThrow("cancel catalog");
    await fs.appendFile(files[0], "\n");
    await expect(store.catalog({ cursor: first.next_cursor!, limit: 50 })).rejects.toMatchObject({ code: "stale_cursor" });
    const refreshed = await store.catalog({ limit: 50 });
    await index(store, model().fixture, files[0]);
    await expect(store.catalog({ cursor: refreshed.next_cursor!, limit: 50 })).rejects.toMatchObject({ code: "stale_cursor" });
  });

  it("invalidates browse cursors for topic-only changes but not original evidence cursors", async () => {
    const { root, directory, store } = await setup();
    const controlled = model();
    const first = await writeSession(directory, root, "first", ["WAL ".repeat(500)]);
    await index(store, controlled.fixture, first);
    await index(store, controlled.fixture, await writeSession(directory, root, "second"));
    const id = conversation(store, "first").id;
    const topic = topicOf(store, "first");
    const browse = store.browse({ topic_id: topic, limit: 1 });
    const evidence = await store.readConversation(id, { maxChars: 1000 });
    expect(browse.next_cursor).not.toBeNull();
    expect(evidence.next_cursor).not.toBeNull();
    const continuation = await store.readConversation(id, { cursor: evidence.next_cursor!, maxChars: 1000 });
    const originalEntries = entrySnapshot(store, id);
    await index(store, controlled.fixture, first, true, renameRepair(topic, "Storage persistence"));
    expect(topicOf(store, "first")).toBe(topic);
    expect(entrySnapshot(store, id)).toEqual(originalEntries);
    let cursorError: unknown;
    try { store.browse({ topic_id: topic, limit: 1, cursor: browse.next_cursor! }); } catch (error) { cursorError = error; }
    expect(cursorError).toMatchObject({ code: "stale_cursor" });
    const continued = await store.readConversation(id, { cursor: evidence.next_cursor!, maxChars: 1000 });
    expect(continued.evidence_id).toBe(continuation.evidence_id);
    expect(continued.fragments).toEqual(continuation.fragments);
    expect(continued.next_cursor).toBe(continuation.next_cursor);
  });

  it("rejects changed or missing original sources and invalid ancestry instead of returning stale fragments", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    await index(store, model().fixture, file);
    const id = conversation(store, "s1").id;
    await fs.unlink(file);
    await expect(store.readConversation(id)).rejects.toMatchObject({ code: "invalid_file" });
    expect((await store.catalog()).warnings).toContainEqual({ path: file, code: "source_missing" });
    const bad = await writeSession(directory, root, "bad-parent");
    await fs.writeFile(bad, (await fs.readFile(bad, "utf8")).replace('"parentId":"bad-parent-0"', '"parentId":"missing-parent"'));
    await store.discover({ file: bad });
    const controlled = model();
    const result = await store.work(controlled.fixture, keepRepair, { file: bad });
    expect(result).toMatchObject({ completed: 0, failed: 1, calls: 0, errors: [{ code: "invalid_ancestry" }] });
    expect(controlled.requests).toHaveLength(0);
    expect(conversations(store).map(item => item.session_id)).toEqual(["s1"]);
  });

  it("rejects invalid concurrency before claiming work and changing active identity on a live store", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    await store.discover({ file });
    await expect(store.work(model().fixture, keepRepair, { file: path.join(root, "missing.jsonl"), concurrency: 0 })).rejects.toMatchObject({ code: "invalid_concurrency" });
    let identityError: unknown;
    try { store.setSourceAccess({ activeSessionId: "different" }); } catch (error) { identityError = error; }
    expect(identityError).toMatchObject({ code: "scope_conflict" });
    expect(await store.work(model().fixture, keepRepair, { file })).toMatchObject({ completed: 1, failed: 0 });
  });

  it("rejects schemas 3 and 4 and nonempty unversioned databases without modifying their contents", async () => {
    const { root, scope, access } = await setup();
    for (const version of [0, 3, 4]) {
      const file = path.join(root, `unsupported-${version}.db`);
      const original = new Database(file);
      original.run(`CREATE TABLE original(value TEXT); INSERT INTO original VALUES ('must survive'); PRAGMA user_version=${version}`);
      original.close();
      let error: unknown;
      try { const unexpected = new HistoryStore(file, scope, access); unexpected.close(); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: "unsupported_index" });
      const preserved = new Database(file, { readonly: true });
      try {
        expect(preserved.query("SELECT * FROM original").all()).toEqual([{ value: "must survive" }]);
        expect(preserved.query("PRAGMA user_version").get()).toEqual({ user_version: version });
        expect(preserved.query("SELECT name FROM sqlite_schema WHERE name LIKE 'hr_%'").all()).toEqual([]);
      } finally { preserved.close(); }
    }
  });
});

describe("bounded selection and complete repair paging", () => {
  it("preserves facet associations across out-of-order bounded selection calls", async () => {
    const { root, directory, store } = await setup();
    for (const scope of ["A", "B", "C"]) await index(store, model().fixture,
      await writeSession(directory, root, `seed-${scope}`, [`Discussion scope: ${scope}.`]));
    const requests: SelectRequest[] = [];
    const entered = Promise.withResolvers<void>();
    const gates = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()];
    const controlled = model(async (request, fallback) => {
      if (request.stage !== "select_topic") return fallback;
      const slot = requests.push(request) - 1;
      if (slot === 1) entered.resolve();
      return slot < 2 ? gates[slot].promise : fallback;
    }, { identity: "out-of-order-selection" });
    const file = await writeSession(directory, root, "incoming", ["Discussion scope: A.", "Discussion scope: B.", "Discussion scope: C."]);
    await store.discover({ file });
    const work = store.work(controlled.fixture, keepRepair, { file, concurrency: 2, maxCalls: 100 });
    cleanup.push(async () => { gates.forEach((gate, slot) => gate.resolve(requests[slot] ? response(requests[slot]) : {})); await work; });
    await Promise.race([entered.promise, work.then(() => { throw new Error("Work ended before concurrent selection calls"); })]);
    expect(requests).toHaveLength(2);
    gates[1].resolve(response(requests[1]));
    await tick();
    gates[0].resolve(response(requests[0]));
    expect(await work).toMatchObject({ completed: 1, failed: 0 });
    expect(controlled.peak).toBe(2);
    expect(conversation(store, "incoming").memberships.map(member => member.topic_id)).toEqual([topicOf(store, "seed-A"), topicOf(store, "seed-B"), topicOf(store, "seed-C")]);
  });

  it("keeps a 130-member merge invisible until all singleton evidence pages and EOF have been confirmed", async () => {
    const { root, directory, store, plan } = await mergeSetup();
    const controlled = model();
    for (let i = 0; i < 127; i++) await index(store, controlled.fixture,
      await writeSession(directory, root, `extra-${i}`, ["Discussion scope: storage. WAL durability."]));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const checked: string[] = [];
    const repair = repairRunner(async driver => {
      await driver.topics();
      return driver.commit(plan, async member => {
        checked.push(`${member.conversation_id}:${member.facet_id}`);
        if (checked.length === 65) { entered.resolve(); await release.promise; }
        return true;
      });
    });
    const file = await writeSession(directory, root, "incoming");
    await store.discover({ file });
    const revision = store.status().revision;
    const work = store.work(controlled.fixture, repair, { file, concurrency: 2, maxCalls: 100 });
    cleanup.push(async () => { release.resolve(); await work; });
    await Promise.race([entered.promise, work.then(() => { throw new Error("Work ended before the second coverage block"); })]);
    expect(checked).toHaveLength(65);
    expect(store.status().revision).toBe(revision);
    expect(topics(store)).toHaveLength(2);
    expect(conversations(store)).toHaveLength(129);
    release.resolve();
    expect(await work).toMatchObject({ completed: 1, failed: 0, topic_changes: { merged: 1 } });
    const expected = conversations(store).flatMap(item => item.memberships.map(member => `${item.id}:${member.facet_id}`));
    expect(checked).toHaveLength(130);
    expect(new Set(checked)).toEqual(new Set(expected));
    expect(topics(store)).toMatchObject([{ member_count: 130 }]);
  }, 60000);
});

describe("deferred history and atomic repair source guards", () => {
  it("refreshes simultaneously stale A and B without a dependency deadlock and reports deferred evidence", async () => {
    const { root, directory, store } = await setup();
    const controlled = model();
    const first = await writeSession(directory, root, "A", ["Discussion scope: storage. Original A."]);
    const second = await writeSession(directory, root, "B", ["Discussion scope: storage. Original B."]);
    await index(store, controlled.fixture, first);
    await index(store, controlled.fixture, second);
    const ids = [conversation(store, "A").id, conversation(store, "B").id];
    await writeSession(directory, root, "A", ["Discussion scope: storage. Corrected A."]);
    await writeSession(directory, root, "B", ["Discussion scope: storage. Corrected B."]);
    await store.discover();
    const result = await store.work(controlled.fixture, keepRepair, { maxJobs: 2, maxCalls: 100 });
    expect(result).toMatchObject({ completed: 2, failed: 0, errors: [] });
    expect(result.repair_deferred).toHaveLength(1);
    expect(result.repair_deferred[0].code).toBe("stale_evidence");
    expect(ids).toContain(result.repair_deferred[0].conversation_id);
    expect(store.status().jobs).toHaveLength(0);
    for (const id of ["A", "B"]) {
      const original = await store.readConversation(conversation(store, id).id);
      expect(original.fragments.map(fragment => fragment.text).join("\n")).toContain(`Corrected ${id}.`);
    }
    expect(topicOf(store, "A")).toBe(topicOf(store, "B"));
  });

  it("reports unusable history even when no child can run and leaves that topic's audit cursor untouched", async () => {
    const { root, directory, store } = await setup();
    const controlled = model();
    await index(store, controlled.fixture, await writeSession(directory, root, "old"));
    const oldId = conversation(store, "old").id;
    const topic = topicOf(store, "old");
    const cursors = store.db.query("SELECT id,review_cursor FROM hr_topics WHERE scope_id=? ORDER BY id").all(store.scope.id);
    await writeSession(directory, root, "old", ["Discussion scope: storage. Changed, but not explicitly reindexed."]);
    let invocations = 0;
    const repair: RepairRunner = async request => { invocations++; return keepRepair(request); };
    const result = await index(store, controlled.fixture, await writeSession(directory, root, "incoming"), false, repair);
    expect(result.repair_deferred).toEqual([{ conversation_id: oldId, code: "stale_evidence" }]);
    expect(invocations).toBe(0);
    expect(topicOf(store, "incoming")).toBe(topic);
    expect(store.db.query("SELECT id,review_cursor FROM hr_topics WHERE scope_id=? ORDER BY id").all(store.scope.id)).toEqual(cursors);
    await expect(store.readConversation(oldId)).rejects.toMatchObject({ code: "stale_evidence" });
  });

  it("fails closed when used original evidence changes after receipts rather than downgrading it to deferred", async () => {
    const { root, directory, store } = await setup();
    const old = await writeSession(directory, root, "old");
    const controlled = model();
    await index(store, controlled.fixture, old);
    const oldId = conversation(store, "old").id;
    const stored = entrySnapshot(store, oldId);
    const revision = store.status().revision;
    const file = await writeSession(directory, root, "incoming");
    const repair = repairRunner(async driver => {
      expect(driver.input.audit.some(member => member.conversation_id === oldId)).toBeTrue();
      await fs.appendFile(old, JSON.stringify({ type: "message", id: "changed-after-proof", parentId: "old-2",
        timestamp: "2026-09-20T03:00:00Z", message: { role: "user", content: "A correction after repair read the original source." } }) + "\n");
      return { proposal_id: null, reason: "Audit was complete before the original file changed." };
    });
    await store.discover({ file });
    expect(await store.work(controlled.fixture, repair, { file, maxCalls: 100 })).toMatchObject({ completed: 0, failed: 1,
      errors: [{ code: "stale_evidence" }], repair_deferred: [], topic_changes: { created: 0, updated: 0, merged: 0, reassigned: 0 } });
    expect(store.status().revision).toBe(revision);
    expect(conversations(store).map(item => item.session_id)).toEqual(["old"]);
    expect(entrySnapshot(store, oldId)).toEqual(stored);
  });

  it("treats a source confirmed healthy by prepare as used even before its first evidence fragment", async () => {
    const { root, directory, store } = await setup();
    await index(store, model().fixture, await writeSession(directory, root, "old"));
    const revision = store.status().revision;
    const repair: RepairRunner = async ({ protocol, signal }) => {
      const driver = new RepairDriver(protocol, signal);
      expect(driver.input.audit).toHaveLength(1);
      await writeSession(directory, root, "old", ["Discussion scope: storage. Changed after prepare."]);
      await driver.audit();
      return { proposal_id: null, reason: "Attempted to read the source captured by prepare." };
    };
    const file = await writeSession(directory, root, "incoming");
    await store.discover({ file });
    expect(await store.work(model().fixture, repair, { file, maxCalls: 100 })).toMatchObject({ completed: 0, failed: 1,
      errors: [{ code: "stale_evidence" }], repair_deferred: [] });
    expect(store.status().revision).toBe(revision);
    expect(conversations(store).map(item => item.session_id)).toEqual(["old"]);
  });

  it("rejects a revision committed while repair is reading and reuses analysis on explicit retry", async () => {
    const { root, directory, store, scope, access } = await setup();
    const controlled = model();
    await index(store, controlled.fixture, await writeSession(directory, root, "seed"));
    const competitor = connection(store, scope, access);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const repair = repairRunner(async () => {
      entered.resolve();
      await release.promise;
      return { proposal_id: null, reason: "Completed the original-evidence audit before the concurrent publication." };
    });
    const file = await writeSession(directory, root, "incoming");
    await store.discover({ file });
    const work = store.work(controlled.fixture, repair, { file, maxCalls: 100 });
    cleanup.push(async () => { release.resolve(); await work; });
    await Promise.race([entered.promise, work.then(() => { throw new Error("Work ended before repair reached its source audit"); })]);
    await index(competitor, model().fixture, await writeSession(directory, root, "other", ["Discussion scope: ui."]));
    const revision = store.status().revision;
    release.resolve();
    expect(await work).toMatchObject({ completed: 0, failed: 1, errors: [{ code: "topic_state_changed" }],
      topic_changes: { created: 0, updated: 0, merged: 0, reassigned: 0 } });
    expect(store.status().revision).toBe(revision);
    expect(conversations(store).map(item => item.session_id)).toEqual(["other", "seed"]);
    const analysisCalls = controlled.requests.filter(request => request.stage.startsWith("analysis_")).length;
    await index(store, controlled.fixture, file, true);
    expect(controlled.requests.filter(request => request.stage.startsWith("analysis_"))).toHaveLength(analysisCalls);
  });
});

describe("cancelled and changing source work", () => {
  it("drains admitted calls on cancellation without publishing or losing the job prematurely", async () => {
    const { root, directory, scope, store } = await setup();
    const file = await writeLargeSession(directory, root);
    const gated = gatedModel(3);
    const controller = new AbortController();
    await store.discover({ file });
    const work = store.work(gated.fixture, keepRepair, { file, signal: controller.signal, concurrency: 3, maxCalls: 100 });
    const outcome = work.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    cleanup.push(async () => { gated.release(); await outcome; });
    await gated.started;
    const owned = store.db.query<{ token: string; lease_until: number }, [string, string]>("SELECT token,lease_until FROM hr_jobs WHERE scope_id=? AND file=?").get(scope.id, file)!;
    controller.abort(new Error("cancel indexing"));
    gated.resolve(1);
    await tick();
    expect(store.db.query("SELECT token,lease_until FROM hr_jobs WHERE scope_id=? AND file=?").get(scope.id, file)).toEqual(owned);
    expect(store.status().conversations).toBe(0);
    gated.resolve(0);
    gated.resolve(2);
    const cancelled = await outcome;
    expect(cancelled.value).toBeUndefined();
    expect(cancelled.error).toBe(controller.signal.reason);
    expect(store.status()).toMatchObject({ conversations: 0, topics: 0, indexing_calls_today: 3 });
    expect(store.db.query("SELECT token,lease_until,attempts,error FROM hr_jobs WHERE scope_id=? AND file=?").get(scope.id, file))
      .toEqual({ token: "", lease_until: 0, attempts: 0, error: "cancelled" });
  });

  it("rejects a source changed during semantic work and indexes the new evidence only on explicit retry", async () => {
    const { root, directory, store } = await setup();
    const file = await writeSession(directory, root);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let pause = true;
    const controlled = model(async (request, fallback) => {
      if (pause && request.stage === "analysis_final") { entered.resolve(); await release.promise; }
      return fallback;
    });
    await store.discover({ file });
    const work = store.work(controlled.fixture, keepRepair, { file });
    cleanup.push(async () => { release.resolve(); await work; });
    await entered.promise;
    await writeSession(directory, root, "s1", ["Discussion scope: ui. Corrected button spacing requirement."]);
    release.resolve();
    expect(await work).toMatchObject({ completed: 0, failed: 1, errors: [{ code: "source_busy" }], topic_changes: { created: 0, updated: 0, merged: 0, reassigned: 0 } });
    expect(store.status()).toMatchObject({ conversations: 0, topics: 0, revision: 0 });
    pause = false;
    await index(store, controlled.fixture, file, true);
    expect(topics(store)[0].title).toBe("Interface layout");
    const original = await store.readConversation(conversation(store, "s1").id);
    expect(original.fragments.map(fragment => fragment.entry_id)).toEqual(["s1-0"]);
    expect(original.fragments[0].text).toContain("Corrected button spacing requirement");
    expect(controlled.requests.filter(request => request.stage === "analysis_final")).toHaveLength(2);
  });
});
