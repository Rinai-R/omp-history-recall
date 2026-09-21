import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { openHistoryDatabase } from "../src/database";
import { RepairProtocol, type RepairProposal, type ValidatedRepair } from "../src/repair";
import type { RecallScope } from "../src/scope";
import type { TopicDescriptor } from "../src/semantic";
import { digest, loadSource, readSourceEvidence, RecallError, type SessionSource } from "../src/source";
import { TopicRegistry } from "../src/topic-registry";
import type { IncomingConversation, MemberFacet, TopicSelection } from "../src/topics";
import { RepairDriver } from "./repair-driver";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const recordedAt = "2026-01-01T00:00:00.000Z";
const repairedAt = "2026-02-01T00:00:00.000Z";
const profile = (title = "Storage durability", aliases: string[] = []): TopicDescriptor => ({
  title, description: "WAL synchronization failures and write acknowledgements.", aliases,
});
const emptyProposal = (): RepairProposal => ({ drafts: [], updates: [], moves: [], merge: null, reason: "Keep established assignments." });
type RecordFixture = { source: SessionSource; incoming: IncomingConversation; selection: TopicSelection };

async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recall-registry-")));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "sessions");
  await fs.mkdir(directory);
  const scope: RecallScope = { id: `scope_${digest(root).slice(0, 24)}`, agentDir: root, sessionsRoot: directory, customFilesRoot: path.join(root, "custom") };
  const db = openHistoryDatabase(path.join(root, "index.db"));
  cleanup.push(async () => { db.close(); });
  db.run("INSERT INTO hr_scopes(scope_id,revision) VALUES (?,0)", [scope.id]);
  const registry = new TopicRegistry(db, scope.id, "active-session");
  const files = new Map<string, string>();

  function topic(id: string, descriptor = profile(), createdAt = recordedAt) {
    db.run("INSERT INTO hr_topics(scope_id,id,title,description,aliases,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      [scope.id, id, descriptor.title, descriptor.description, JSON.stringify(descriptor.aliases), createdAt, recordedAt]);
  }

  function persist(record: RecordFixture) {
    const { source, incoming } = record;
    db.run(`INSERT INTO hr_conversations(scope_id,id,session_id,file,directory,stamp,source_cwd,source_hash,title,summary,
      started_at,last_active_at,entry_count,message_count,user_turn_count,branch_count,active_windows,size_bytes,model,indexed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_id,id) DO UPDATE SET
      source_hash=excluded.source_hash,stamp=excluded.stamp,entry_count=excluded.entry_count,size_bytes=excluded.size_bytes`,
    [scope.id, incoming.id, source.sessionId, source.file, directory, source.stamp, source.cwd, source.fingerprint,
      source.title, incoming.analysis.summary, recordedAt, recordedAt, source.entries.length, source.entries.length, 1, 0,
      "[]", source.sizeBytes, "registry-source-fixture", recordedAt]);
    db.run("DELETE FROM hr_search WHERE scope_id=? AND conversation_id=?", [scope.id, incoming.id]);
    db.run("DELETE FROM hr_entries WHERE scope_id=? AND conversation_id=?", [scope.id, incoming.id]);
    for (const entry of source.entries) {
      const id = digest(`${incoming.id}\0${entry.id}`);
      db.run(`INSERT INTO hr_entries(scope_id,id,conversation_id,entry_id,parent_id,timestamp,role,line,hash,text)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [scope.id, id, incoming.id, entry.id, entry.parentId, entry.timestamp, entry.role, entry.line, entry.hash, entry.text]);
      db.run("INSERT INTO hr_search(row_id,scope_id,conversation_id,body) VALUES (?,?,?,?)", [id, scope.id, incoming.id, entry.text]);
    }
  }

  async function record(sessionId: string, topicRefs: string[], options: { texts?: string[]; descriptors?: TopicDescriptor[]; persist?: boolean } = {}): Promise<RecordFixture> {
    const texts = options.texts ?? topicRefs.map((_, index) => `WAL fsync failed in case ${sessionId}-${index}; writes must not be acknowledged.`);
    if (texts.length !== topicRefs.length) throw new Error("Each fixture facet requires one real source entry");
    const file = path.join(directory, `${sessionId}.jsonl`);
    await fs.writeFile(file, [
      { type: "session", version: 3, id: sessionId, cwd: root, timestamp: recordedAt },
      ...texts.map((text, index) => ({ type: "message", id: `${sessionId}-e${index}`, parentId: index ? `${sessionId}-e${index - 1}` : null,
        timestamp: recordedAt, message: { role: "user", content: text } })),
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    const source = await loadSource(file);
    const incoming: IncomingConversation = {
      id: `c_${sessionId}`, sourceHash: source.fingerprint,
      analysis: { summary: "Recorded durability investigation.", facets: texts.map((_, index) => ({
        id: `f${index}`, ...(options.descriptors?.[index] ?? profile()), evidence_entry_ids: [source.entries[index].id],
      })) },
      evidenceById: new Map(source.entries.map(entry => [entry.id, { id: entry.id, hash: entry.hash }])),
    };
    const selection: TopicSelection = { assignments: topicRefs.map((topicRef, index) => ({
      facetId: `f${index}`, topicRef, candidateIds: [topicRef], reason: "Recorded initial scope.",
    })), newTopics: [], neighborIds: [] };
    const result = { source, incoming, selection };
    files.set(incoming.id, file);
    if (options.persist !== false) {
      persist(result);
      for (const facet of incoming.analysis.facets) {
        db.run("INSERT INTO hr_facets(scope_id,conversation_id,id,title,description,aliases,evidence) VALUES (?,?,?,?,?,?,?)",
          [scope.id, incoming.id, facet.id, facet.title, facet.description, JSON.stringify(facet.aliases), JSON.stringify(facet.evidence_entry_ids.map(id => incoming.evidenceById.get(id)!))]);
        db.run("INSERT INTO hr_memberships(scope_id,conversation_id,facet_id,topic_id,reason,assigned_at) VALUES (?,?,?,?,?,?)",
          [scope.id, incoming.id, facet.id, topicRefs[Number(facet.id.slice(1))], "Original evidence assignment.", recordedAt]);
      }
    }
    return result;
  }

  function members(record: RecordFixture, refs: string[], proposal: RepairProposal | null = null, limit = 64) {
    const collected: MemberFacet[] = [];
    let cursor: string | undefined;
    do {
      const page = registry.memberPage(refs, record.incoming, record.selection, proposal, registry.snapshot().revision, { cursor, limit });
      expect(page.members.length).toBeLessThanOrEqual(limit);
      collected.push(...page.members);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return collected;
  }

  function assignment(conversationId: string) {
    return db.query<{ facet_id: string; topic_id: string; reason: string; assigned_at: string }, [string, string]>(
      "SELECT facet_id,topic_id,reason,assigned_at FROM hr_memberships WHERE scope_id=? AND conversation_id=? ORDER BY facet_id").all(scope.id, conversationId);
  }

  function evidenceState(conversationId: string) {
    return {
      entries: db.query("SELECT * FROM hr_entries WHERE scope_id=? AND conversation_id=? ORDER BY entry_id").all(scope.id, conversationId),
      search: db.query("SELECT rowid,* FROM hr_search WHERE scope_id=? AND conversation_id=? ORDER BY row_id").all(scope.id, conversationId),
      facets: db.query("SELECT id,evidence FROM hr_facets WHERE scope_id=? AND conversation_id=? ORDER BY id").all(scope.id, conversationId),
    };
  }

  async function protocol(record: RecordFixture) {
    const instance = new RepairProtocol(scope, registry, record.incoming, record.source, record.selection, registry.snapshot(), async (id, signal) => {
      const file = files.get(id);
      if (!file) throw new RecallError("source_missing", "No fixture source for that conversation");
      return loadSource(file, { signal });
    }, { inputBytes: 200_000, concurrency: 3 });
    await instance.prepare();
    return instance;
  }

  async function prove(record: RecordFixture, proposal: RepairProposal) {
    const instance = await protocol(record);
    const driver = new RepairDriver(instance);
    await driver.audit();
    await driver.topics();
    for (const topicRef of new Set(proposal.moves.map(item => item.fromTopicRef))) await driver.members(topicRef);
    const covered: { conversationId: string; facetId: string; targetRef: string }[] = [];
    const completion = await driver.commit(proposal, (member, targetRef) => {
      covered.push({ conversationId: member.conversation_id, facetId: member.facet_id, targetRef });
      return true;
    });
    return { repair: instance.finalize(completion), covered };
  }

  function apply(record: RecordFixture, repair: ValidatedRepair, replaceSource = false) {
    const expectedRevision = registry.snapshot().revision;
    return db.transaction(() => {
      registry.captureIncoming(record.incoming, expectedRevision);
      if (replaceSource) persist(record);
      const changes = registry.apply({ expectedRevision, selection: record.selection, repair }, record.incoming, repairedAt);
      db.run("UPDATE hr_scopes SET revision=revision+1 WHERE scope_id=?", [scope.id]);
      return changes;
    })();
  }

  return { root, scope, db, registry, topic, record, persist, members, assignment, evidenceState, protocol, prove, apply };
}

function move(record: RecordFixture, fromTopicRef: string, targetRef: string, facetId = "f0") {
  return { conversationId: record.incoming.id, sourceHash: record.incoming.sourceHash, facetId, fromTopicRef, targetRef, reason: "Source evidence supports the corrected scope." };
}

describe("registry prospective repair views", () => {
  it("replaces every old incoming facet with its new source version before membership paging", async () => {
    const fixture = await setup();
    fixture.topic("t_a"); fixture.topic("t_b");
    const historical = await fixture.record("history", ["t_a"]);
    const target = await fixture.record("target", ["t_b"]);
    const previous = await fixture.record("incoming", ["t_a", "t_a"]);
    const incoming = await fixture.record("incoming", ["t_b"], { persist: false, texts: ["A corrected synchronization failure, not the old two-facet analysis."] });
    expect(incoming.incoming.sourceHash).not.toBe(previous.incoming.sourceHash);
    expect(fixture.members(incoming, ["t_a"]).map(member => member.conversationId)).toEqual([historical.incoming.id]);
    expect(fixture.members(incoming, ["t_b"])).toMatchObject([{ conversationId: incoming.incoming.id, sourceHash: incoming.incoming.sourceHash,
      facetId: "f0", evidence: [{ id: incoming.source.entries[0].id, hash: incoming.source.entries[0].hash }] }, { conversationId: target.incoming.id }]);
    expect(fixture.assignment(incoming.incoming.id).map(member => member.topic_id)).toEqual(["t_a", "t_a"]);
    const historyEvidence = fixture.evidenceState(historical.incoming.id);
    const { repair } = await fixture.prove(incoming, emptyProposal());
    fixture.apply(incoming, repair, true);
    expect(fixture.assignment(incoming.incoming.id).map(member => [member.facet_id, member.topic_id])).toEqual([["f0", "t_b"]]);
    expect(fixture.members(incoming, ["t_a"]).map(member => member.conversationId)).toEqual([historical.incoming.id]);
    expect(fixture.evidenceState(historical.incoming.id)).toEqual(historyEvidence);
  });

  it("moves members both out of and into a merge pair in the final prospective set", async () => {
    const fixture = await setup();
    fixture.topic("t_left"); fixture.topic("t_right", profile(), repairedAt); fixture.topic("t_other");
    const left = await fixture.record("left", ["t_left"]);
    const leaving = await fixture.record("leaving", ["t_right"]);
    const entering = await fixture.record("entering", ["t_other"]);
    await fixture.record("incoming", ["t_right", "t_other"]);
    const incoming = await fixture.record("incoming", ["t_right"], { persist: false, texts: ["The current incoming evidence supersedes both old facets."] });
    const proposal: RepairProposal = { ...emptyProposal(), moves: [move(leaving, "t_right", "t_other"), move(entering, "t_other", "t_right")],
      merge: { leftTopicId: "t_right", rightTopicId: "t_left", descriptor: profile(), reason: "The same durability scope." } };
    expect(fixture.members(incoming, ["t_left"], proposal).map(member => [member.conversationId, member.topicId])).toEqual(
      [entering, incoming, left].map(record => [record.incoming.id, "t_left"]));
    expect(fixture.members(incoming, ["t_other"], proposal).map(member => member.conversationId)).toEqual([leaving.incoming.id]);
    const { repair, covered } = await fixture.prove(incoming, proposal);
    expect(covered).toEqual([
      { conversationId: entering.incoming.id, facetId: "f0", targetRef: "t_left" },
      { conversationId: incoming.incoming.id, facetId: "f0", targetRef: "t_left" },
      { conversationId: left.incoming.id, facetId: "f0", targetRef: "t_left" },
      { conversationId: leaving.incoming.id, facetId: "f0", targetRef: "t_other" },
    ]);
    expect(repair.receipts.find(receipt => receipt.conversationId === incoming.incoming.id)).toMatchObject({
      sourceHash: incoming.incoming.sourceHash, facetId: "f0", entryId: incoming.source.entries[0].id, entryHash: incoming.source.entries[0].hash,
    });
    fixture.registry.assertRepairPlan(incoming.selection, incoming.incoming, repair, 0);
    const evidenceBefore = [left, leaving, entering].map(record => fixture.evidenceState(record.incoming.id));
    const changes = fixture.apply(incoming, repair, true);
    expect(changes).toMatchObject({ merged: 1, reassigned: 2 });
    expect(fixture.registry.snapshot().cards.map(card => card.id).sort()).toEqual(["t_left", "t_other"]);
    expect(fixture.assignment(incoming.incoming.id)).toMatchObject([{ facet_id: "f0", topic_id: "t_left", assigned_at: recordedAt }]);
    expect(fixture.assignment(left.incoming.id)).toEqual([{ facet_id: "f0", topic_id: "t_left", reason: "Original evidence assignment.", assigned_at: recordedAt }]);
    expect(fixture.assignment(leaving.incoming.id)).toEqual([{ facet_id: "f0", topic_id: "t_other", reason: proposal.moves[0].reason, assigned_at: repairedAt }]);
    expect(fixture.assignment(entering.incoming.id)).toEqual([{ facet_id: "f0", topic_id: "t_left", reason: proposal.moves[1].reason, assigned_at: repairedAt }]);
    expect([left, leaving, entering].map(record => fixture.evidenceState(record.incoming.id))).toEqual(evidenceBefore);
  });

  it("rejects a cursor reused for another target, proposal, incoming version, or revision", async () => {
    const fixture = await setup();
    fixture.topic("t_a"); fixture.topic("t_b");
    await fixture.record("a", ["t_a"]); await fixture.record("b", ["t_a"]);
    const incoming = await fixture.record("incoming", ["t_a"]);
    const { revision } = fixture.registry.snapshot();
    const first = fixture.registry.memberPage(["t_a"], incoming.incoming, incoming.selection, null, revision, { limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const read = (refs: string[], proposal: RepairProposal | null, record = incoming) => fixture.registry.memberPage(refs, record.incoming, record.selection, proposal, revision, { cursor: first.nextCursor!, limit: 1 });
    expect(() => read(["t_b"], null)).toThrow(RecallError);
    expect(() => read(["t_a"], { ...emptyProposal(), updates: [{ topicId: "t_a", descriptor: profile("Corrected durability"), reason: "Narrow to the observed failures." }] })).toThrow(RecallError);
    const replacement = await fixture.record("incoming", ["t_a"], { persist: false, texts: ["Changed original source."] });
    expect(() => read(["t_a"], null, replacement)).toThrow(RecallError);
    fixture.db.run("UPDATE hr_scopes SET revision=revision+1 WHERE scope_id=?", [fixture.scope.id]);
    expect(() => read(["t_a"], null)).toThrow(RecallError);
  });
});

describe("registry repair reference and cardinality boundaries", () => {
  it("rejects a ninth effective historical move rather than dropping it", async () => {
    const fixture = await setup();
    fixture.topic("t_a"); fixture.topic("t_b");
    const history = await Promise.all(Array.from({ length: 9 }, (_, index) => fixture.record(`old-${index}`, ["t_a"])));
    const incoming = await fixture.record("incoming", ["t_b"]);
    const proposal = { ...emptyProposal(), moves: history.map(record => move(record, "t_a", "t_b")) };
    expect(() => fixture.registry.normalizeRepairProposal(incoming.selection, incoming.incoming, proposal, 0)).toThrow(RecallError);
    expect(fixture.members(incoming, ["t_a"]).map(member => member.conversationId)).toEqual(history.map(record => record.incoming.id));
  });

  it("rejects a sixth repair draft, duplicate facet move, and unreferenced repair draft", async () => {
    const fixture = await setup();
    fixture.topic("t_a"); fixture.topic("t_b");
    const historical = await fixture.record("history", ["t_a"]);
    const incoming = await fixture.record("incoming", ["t_b"]);
    const normalize = (proposal: RepairProposal) => fixture.registry.normalizeRepairProposal(incoming.selection, incoming.incoming, proposal, 0);
    expect(() => normalize({ ...emptyProposal(), drafts: Array.from({ length: 6 }, (_, index) => ({ ref: `repair:${index}`, descriptor: profile() })) })).toThrow(RecallError);
    expect(() => normalize({ ...emptyProposal(), moves: [move(historical, "t_a", "t_b"), move(historical, "t_a", "t_b")] })).toThrow(RecallError);
    expect(() => normalize({ ...emptyProposal(), drafts: [{ ref: "repair:0", descriptor: profile() }] })).toThrow(RecallError);
  });

  it.each(["source", "origin", "facet", "target"])("rejects a forged move %s against persisted history", async defect => {
    const fixture = await setup();
    fixture.topic("t_a"); fixture.topic("t_b");
    const historical = await fixture.record("history", ["t_a"]);
    const incoming = await fixture.record("incoming", ["t_b"]);
    const forged = move(historical, "t_a", "t_b");
    if (defect === "source") forged.sourceHash = "0".repeat(64);
    if (defect === "origin") forged.fromTopicRef = "t_b";
    if (defect === "facet") forged.facetId = "f99";
    if (defect === "target") forged.targetRef = "t_foreign";
    expect(() => fixture.registry.normalizeRepairProposal(incoming.selection, incoming.incoming, { ...emptyProposal(), moves: [forged] }, 0)).toThrow(RecallError);
  });

  it("keeps active membership visible as a repair restriction while hiding its content", async () => {
    const fixture = await setup();
    fixture.topic("t_a"); fixture.topic("t_b");
    const active = await fixture.record("active-session", ["t_a"]);
    const healthy = await fixture.record("history", ["t_a"]);
    const incoming = await fixture.record("incoming", ["t_b"]);
    expect(fixture.registry.repairCards(0).find(card => card.id === "t_a")).toMatchObject({ memberCount: 1, hasActiveMembers: true });
    expect(fixture.members(incoming, ["t_a"]).map(member => member.conversationId)).toEqual([healthy.incoming.id]);
    const proposals: RepairProposal[] = [
      { ...emptyProposal(), moves: [move(active, "t_a", "t_b")] },
      { ...emptyProposal(), updates: [{ topicId: "t_a", descriptor: profile("Narrowed durability"), reason: "Proposed revised scope." }] },
      { ...emptyProposal(), merge: { leftTopicId: "t_a", rightTopicId: "t_b", descriptor: profile(), reason: "Proposed same scope." } },
    ];
    for (const proposal of proposals) expect(() => fixture.registry.normalizeRepairProposal(incoming.selection, incoming.incoming, proposal, 0)).toThrow(RecallError);
  });
});

describe("registry audit and descriptor normalization", () => {
  it("uses round-robin keyset audit cursors and wraps without treating incoming as history", async () => {
    const fixture = await setup();
    fixture.topic("t_a"); fixture.topic("t_b");
    for (let index = 0; index < 6; index++) {
      await fixture.record(`a${index}`, ["t_a"]);
      await fixture.record(`b${index}`, ["t_b"]);
    }
    const incoming = await fixture.record("incoming", ["t_a"]);
    incoming.selection.neighborIds = ["t_b"];
    fixture.db.run("UPDATE hr_topics SET review_cursor=? WHERE scope_id=? AND id=?", ["c_a4\0f0", fixture.scope.id, "t_a"]);
    fixture.db.run("UPDATE hr_topics SET review_cursor=? WHERE scope_id=? AND id=?", ["c_b3\0f0", fixture.scope.id, "t_b"]);
    const audit = fixture.registry.audit(incoming.selection, incoming.incoming, 0);
    expect(audit.members.map(member => member.conversationId)).toEqual(["c_a5", "c_b4", "c_a0", "c_b5", "c_a1", "c_b0", "c_a2", "c_b1"]);
    expect(fixture.db.query("SELECT id,review_cursor FROM hr_topics ORDER BY id").all()).toEqual([
      { id: "t_a", review_cursor: "c_a4\0f0" }, { id: "t_b", review_cursor: "c_b3\0f0" },
    ]);
  });

  it("normalizes old names and aliases before defining merge coverage", async () => {
    const fixture = await setup();
    fixture.topic("t_left", profile("WAL failures", ["Persistence", "WRITE  DURABILITY"]));
    fixture.topic("t_right", profile("Storage guarantees", ["Ｐｅｒｓｉｓｔｅｎｃｅ", "Crash safety"]), repairedAt);
    await fixture.record("left", ["t_left"]);
    const incoming = await fixture.record("incoming", ["t_right"]);
    const proposal: RepairProposal = { ...emptyProposal(), merge: { leftTopicId: "t_right", rightTopicId: "t_left",
      descriptor: profile("Storage durability", [" persistence ", "write durability", "Crash safety", " Sync failures "]), reason: "Equivalent complete discussion scope." } };
    const { repair } = await fixture.prove(incoming, proposal);
    const normalized = repair.proposal;
    const expected = profile("Storage durability", ["WAL failures", "Storage guarantees", "Persistence", "WRITE  DURABILITY", "Crash safety", "Sync failures"]);
    expect(normalized.merge?.descriptor).toEqual(expected);
    expect(fixture.registry.repairCoverageTargets(incoming.selection, incoming.incoming, normalized, 0)).toMatchObject([
      { targetRef: "t_left", descriptor: expected, allMembers: true },
    ]);
    expect(fixture.registry.normalizeRepairProposal(incoming.selection, incoming.incoming, normalized, 0)).toEqual(normalized);
    fixture.registry.assertRepairPlan(incoming.selection, incoming.incoming, repair, 0);
    fixture.apply(incoming, repair);
    expect(fixture.registry.snapshot().cards).toEqual([{ id: "t_left", ...expected, createdAt: recordedAt }]);
  });

  it("caps retained aliases at 24 before deciding an unchanged update is a no-op", async () => {
    const fixture = await setup();
    const original = profile("Storage durability", ["Storage durability", ...Array.from({ length: 23 }, (_, index) => `Historical label ${index}`)]);
    fixture.topic("t_a", original);
    await fixture.record("history", ["t_a"]);
    const incoming = await fixture.record("incoming", ["t_a"]);
    const proposal: RepairProposal = { ...emptyProposal(), updates: [{ topicId: "t_a", descriptor: profile("Storage durability", ["New label"]), reason: "Retain the same scope." }] };
    const normalized = fixture.registry.normalizeRepairProposal(incoming.selection, incoming.incoming, proposal, 0);
    expect(normalized.updates).toEqual([]);
    expect(fixture.registry.repairCoverageTargets(incoming.selection, incoming.incoming, normalized, 0)).toEqual([]);
    expect(fixture.registry.snapshot().cards[0].aliases).toEqual(original.aliases);
  });
});

describe("registry evidence-bound coverage verification", () => {
  const corruptions: { name: string; corrupt: (repair: ValidatedRepair) => void }[] = [
    { name: "proposal binding", corrupt: repair => { repair.proposalId = "0".repeat(64); } },
    { name: "final descriptor", corrupt: repair => { repair.proposal.updates[0].descriptor.aliases.push("Unverified scope"); } },
    { name: "guard source version", corrupt: repair => { repair.sourceGuards[0].sourceHash = "0".repeat(64); } },
    { name: "guard session", corrupt: repair => { repair.sourceGuards[0].sessionId = "foreign-session"; } },
    { name: "guard path", corrupt: repair => { repair.sourceGuards[0].file += ".foreign"; } },
    { name: "missing guard", corrupt: repair => { repair.sourceGuards = []; } },
    { name: "receipt entry", corrupt: repair => { repair.receipts[0].entryId = "unread-entry"; } },
    { name: "receipt hash", corrupt: repair => { repair.receipts[0].entryHash = "0".repeat(64); } },
    { name: "receipt length", corrupt: repair => { repair.receipts[0].totalChars++; } },
    { name: "missing receipt", corrupt: repair => { repair.receipts.pop(); } },
    { name: "duplicate receipt", corrupt: repair => { repair.receipts.push({ ...repair.receipts[0] }); } },
    { name: "missing target", corrupt: repair => { repair.coverage = []; } },
    { name: "duplicate target", corrupt: repair => { repair.coverage.push({ ...repair.coverage[0] }); } },
    { name: "coverage count", corrupt: repair => { repair.coverage[0].memberCount--; } },
    { name: "coverage digest", corrupt: repair => { repair.coverage[0].digest = "0".repeat(64); } },
    { name: "audit cursor", corrupt: repair => { repair.cursorUpdates[0].afterFacetKey = "c_unread\0f0"; } },
  ];

  it.each(corruptions)("refuses tampered $name after obtaining actual source receipts", async ({ corrupt }) => {
    const fixture = await setup();
    fixture.topic("t_a");
    await fixture.record("history", ["t_a"]);
    const incoming = await fixture.record("incoming", ["t_a"]);
    const { repair, covered } = await fixture.prove(incoming, { ...emptyProposal(),
      updates: [{ topicId: "t_a", descriptor: profile("Synchronization failures"), reason: "All final members describe these failures." }] });
    expect(covered.map(member => member.conversationId)).toEqual(["c_history", "c_incoming"]);
    fixture.registry.assertRepairPlan(incoming.selection, incoming.incoming, repair, 0);
    const forged = structuredClone(repair);
    corrupt(forged);
    expect(() => fixture.registry.assertRepairPlan(incoming.selection, incoming.incoming, forged, 0)).toThrow(RecallError);
  });

  it("verifies every member beyond two 64-row keyset pages, not a sampled prefix", async () => {
    const fixture = await setup();
    fixture.topic("t_a");
    const history: RecordFixture[] = [];
    for (let index = 0; index < 130; index++) history.push(await fixture.record(`member-${String(index).padStart(3, "0")}`, ["t_a"]));
    const incoming = await fixture.record("incoming", ["t_a"]);
    const expectedIds = [incoming, ...history].map(record => record.incoming.id).sort();
    expect(fixture.members(incoming, ["t_a"], null, 64).map(member => member.conversationId)).toEqual(expectedIds);
    const { repair, covered } = await fixture.prove(incoming, { ...emptyProposal(),
      updates: [{ topicId: "t_a", descriptor: profile("Durability synchronization failures"), reason: "Every recorded case fits the final scope." }] });
    expect(covered.map(member => member.conversationId)).toEqual(expectedIds);
    expect(repair.coverage).toMatchObject([{ targetRef: "t_a", memberCount: 131 }]);
    fixture.registry.assertRepairPlan(incoming.selection, incoming.incoming, repair, 0);
    const missingTail = structuredClone(repair);
    missingTail.receipts = missingTail.receipts.filter(receipt => receipt.conversationId !== history[129].incoming.id);
    expect(() => fixture.registry.assertRepairPlan(incoming.selection, incoming.incoming, missingTail, 0)).toThrow(RecallError);
    const evidenceBefore = history.map(record => fixture.evidenceState(record.incoming.id));
    expect(fixture.apply(incoming, repair)).toEqual({ created: 0, updated: 1, merged: 0, reassigned: 0 });
    expect(fixture.members(incoming, ["t_a"]).map(member => member.conversationId)).toEqual(expectedIds);
    expect(history.map(record => fixture.evidenceState(record.incoming.id))).toEqual(evidenceBefore);
  });
});

describe("registry effective no-op normalization", () => {
  it("uses the same empty proof for unchanged moves and definitions regardless of explanation", async () => {
    const fixture = await setup();
    fixture.topic("t_a", profile("Storage durability", ["Storage durability"]));
    const historical = await fixture.record("history", ["t_a"]);
    const incoming = await fixture.record("incoming", ["t_a"]);
    const proposal: RepairProposal = { ...emptyProposal(), reason: "This wording must not make a semantic change.",
      moves: [move(historical, "t_a", "t_a"), move(incoming, "t_a", "t_a")],
      updates: [{ topicId: "t_a", descriptor: profile("Storage durability"), reason: "The existing definition is still exact." }] };
    const before = fixture.assignment(historical.incoming.id);
    const noop = await fixture.prove(incoming, proposal);
    const empty = await fixture.prove(incoming, emptyProposal());
    expect(noop.repair.proposal).toEqual(empty.repair.proposal);
    expect(noop.repair.proposalId).toBe(empty.repair.proposalId);
    expect(noop.repair.coverage).toEqual([]);
    fixture.registry.assertRepairPlan(incoming.selection, incoming.incoming, noop.repair, 0);
    const evidenceBefore = fixture.evidenceState(historical.incoming.id);
    expect(fixture.apply(incoming, noop.repair)).toEqual({ created: 0, updated: 0, merged: 0, reassigned: 0 });
    expect(fixture.evidenceState(historical.incoming.id)).toEqual(evidenceBefore);
    expect(fixture.db.query("SELECT kind FROM hr_topic_events WHERE scope_id=?").all(fixture.scope.id)).toEqual([]);
    expect(fixture.db.query("SELECT review_cursor FROM hr_topics WHERE scope_id=? AND id=?").get(fixture.scope.id, "t_a"))
      .toEqual({ review_cursor: noop.repair.cursorUpdates[0].afterFacetKey });
    expect(fixture.assignment(historical.incoming.id)).toEqual(before);
  });

  it("preserves assignment time when an incoming repair restores the persisted topic after a different initial selection", async () => {
    const fixture = await setup();
    fixture.topic("t_a"); fixture.topic("t_b");
    await fixture.record("history", ["t_b"]);
    const previous = await fixture.record("incoming", ["t_a"]);
    const before = fixture.assignment(previous.incoming.id)[0];
    const incoming = await fixture.record("incoming", ["t_b"], { persist: false,
      texts: ["The refreshed source still concerns the original failed synchronization guarantee."] });
    const { repair, covered } = await fixture.prove(incoming, { ...emptyProposal(), moves: [move(incoming, "t_b", "t_a")] });
    expect(covered).toEqual([{ conversationId: incoming.incoming.id, facetId: "f0", targetRef: "t_a" }]);
    expect(fixture.apply(incoming, repair, true)).toEqual({ created: 0, updated: 0, merged: 0, reassigned: 0 });
    expect(fixture.assignment(incoming.incoming.id)).toMatchObject([
      { facet_id: "f0", topic_id: before.topic_id, assigned_at: before.assigned_at },
    ]);
  });

  it("lets merge alone explain a source-to-survivor move without changing assignment history", async () => {
    const fixture = await setup();
    fixture.topic("t_left"); fixture.topic("t_right", profile(), repairedAt);
    const survivor = await fixture.record("left", ["t_left"]);
    const source = await fixture.record("right", ["t_right"]);
    const incoming = await fixture.record("incoming", ["t_left"]);
    const proposal: RepairProposal = { ...emptyProposal(), merge: { leftTopicId: "t_left", rightTopicId: "t_right", descriptor: profile(), reason: "Both are the same scope." } };
    const plain = await fixture.prove(incoming, proposal);
    const redundant = await fixture.prove(incoming, { ...proposal, moves: [move(source, "t_right", "t_left"), move(survivor, "t_left", "t_left")] });
    expect(redundant.repair.proposal.moves).toEqual([]);
    expect(redundant.repair.proposalId).toBe(plain.repair.proposalId);
    expect(redundant.repair.coverage).toEqual(plain.repair.coverage);
    fixture.registry.assertRepairPlan(incoming.selection, incoming.incoming, redundant.repair, 0);
    const evidenceBefore = fixture.evidenceState(source.incoming.id);
    expect(fixture.apply(incoming, redundant.repair)).toMatchObject({ merged: 1, reassigned: 0 });
    expect(fixture.assignment(source.incoming.id)).toEqual([{ facet_id: "f0", topic_id: "t_left", reason: "Original evidence assignment.", assigned_at: recordedAt }]);
    expect(fixture.evidenceState(source.incoming.id)).toEqual(evidenceBefore);
    expect(fixture.db.query("SELECT kind FROM hr_topic_events WHERE scope_id=? AND kind='move'").all(fixture.scope.id)).toEqual([]);
  });
});

describe("registry incoming and definition cardinality limits", () => {
  it("rejects a sixth incoming move independently of the historical move allowance", async () => {
    const fixture = await setup();
    fixture.topic("t_a"); fixture.topic("t_b");
    await fixture.record("history", ["t_b"]);
    const incoming = await fixture.record("incoming", Array.from({ length: 6 }, () => "t_a"));
    const proposal: RepairProposal = { ...emptyProposal(), moves: incoming.incoming.analysis.facets.map(facet => move(incoming, "t_a", "t_b", facet.id)) };
    expect(() => fixture.registry.normalizeRepairProposal(incoming.selection, incoming.incoming, proposal, 0)).toThrow(RecallError);
  });

  it("rejects a sixth descriptor update instead of silently validating only a prefix", async () => {
    const fixture = await setup();
    const ids = Array.from({ length: 6 }, (_, index) => `t_${index}`);
    for (const id of ids) {
      fixture.topic(id);
      await fixture.record(`history-${id}`, [id]);
    }
    const incoming = await fixture.record("incoming", [ids[0]]);
    const proposal: RepairProposal = { ...emptyProposal(), updates: ids.map(topicId => ({ topicId,
      descriptor: profile("Revised synchronization failures"), reason: "A proposed scope correction." })) };
    expect(() => fixture.registry.normalizeRepairProposal(incoming.selection, incoming.incoming, proposal, 0)).toThrow(RecallError);
  });
});

describe("registry historical-only repair drafts", () => {
  it("covers a historical-only split and every remaining member of the narrowed original topic", async () => {
    const fixture = await setup();
    fixture.topic("t_mixed", { title: "Product changes", description: "Storage synchronization and interface layout.", aliases: [] });
    const durability = await fixture.record("durability", ["t_mixed"]);
    const uiDescriptor = { title: "Interface layout", description: "Button spacing and color changes.", aliases: [] };
    const ui = await fixture.record("ui", ["t_mixed"], { texts: ["调整按钮间距和颜色。".repeat(180)], descriptors: [uiDescriptor] });
    const incoming = await fixture.record("incoming", ["t_mixed"]);
    const proposal: RepairProposal = { ...emptyProposal(), drafts: [{ ref: "repair:0", descriptor: uiDescriptor }],
      updates: [{ topicId: "t_mixed", descriptor: profile(), reason: "All remaining evidence concerns synchronization failures." }],
      moves: [move(ui, "t_mixed", "repair:0")] };
    const { repair, covered } = await fixture.prove(incoming, proposal);
    expect(covered).toEqual([
      { conversationId: ui.incoming.id, facetId: "f0", targetRef: "repair:0" },
      { conversationId: durability.incoming.id, facetId: "f0", targetRef: "t_mixed" },
      { conversationId: incoming.incoming.id, facetId: "f0", targetRef: "t_mixed" },
    ]);
    expect(repair.coverage.map(proof => [proof.targetRef, proof.memberCount])).toEqual([["repair:0", 1], ["t_mixed", 2]]);
    fixture.registry.assertRepairPlan(incoming.selection, incoming.incoming, repair, 0);
    const evidenceBefore = fixture.evidenceState(ui.incoming.id);
    const originalBytes = await fs.readFile(ui.source.file);
    const sourcePage = readSourceEvidence(fixture.scope.id, ui.source, { maxChars: 1000 });
    expect(sourcePage.next_cursor).not.toBeNull();
    const memberPage = fixture.registry.memberPage(["t_mixed"], incoming.incoming, incoming.selection, null, 0, { limit: 1 });
    expect(fixture.apply(incoming, repair)).toEqual({ created: 1, updated: 1, merged: 0, reassigned: 1 });
    const uiTopicId = fixture.assignment(ui.incoming.id)[0].topic_id;
    expect(uiTopicId).toMatch(/^t_/);
    expect(uiTopicId).not.toBe("t_mixed");
    expect(fixture.assignment(incoming.incoming.id)[0].topic_id).toBe("t_mixed");
    expect(fixture.registry.snapshot().cards.map(card => card.id).sort()).toEqual(["t_mixed", uiTopicId].sort());
    expect(fixture.evidenceState(ui.incoming.id)).toEqual(evidenceBefore);
    expect(await fs.readFile(ui.source.file)).toEqual(originalBytes);
    const continuation = readSourceEvidence(fixture.scope.id, await loadSource(ui.source.file), { cursor: sourcePage.next_cursor!, maxChars: 1000 });
    expect(continuation.evidence_id).toBe(sourcePage.evidence_id);
    expect(continuation.fragments[0].offset).toBe(1000);
    expect(() => fixture.registry.memberPage(["t_mixed"], incoming.incoming, incoming.selection, null, 1,
      { cursor: memberPage.nextCursor!, limit: 1 })).toThrow(expect.objectContaining({ code: "invalid_cursor" }));
    const events = fixture.db.query<{ kind: string; payload: string }, [string]>(
      "SELECT kind,payload FROM hr_topic_events WHERE scope_id=? ORDER BY kind").all(fixture.scope.id);
    expect(events.map(event => event.kind)).toEqual(["create", "move", "update"]);
    for (const event of events) expect(JSON.parse(event.payload)).toMatchObject({ repair_id: repair.proposalId });
  });
});

describe("registry atomic repair publication", () => {
  it("rolls back incoming metadata and entries alongside a rejected repair, then accepts the intact proof", async () => {
    const fixture = await setup();
    fixture.topic("t_a");
    const history = await fixture.record("history", ["t_a"]);
    const previous = await fixture.record("incoming", ["t_a"]);
    const incoming = await fixture.record("incoming", ["t_a"], { persist: false, texts: ["A newer source documents the same failed synchronization guarantee."] });
    const before = { cards: fixture.registry.snapshot(), incoming: fixture.evidenceState(previous.incoming.id),
      history: fixture.evidenceState(history.incoming.id), assignments: fixture.assignment(previous.incoming.id) };
    const { repair } = await fixture.prove(incoming, { ...emptyProposal(), updates: [{ topicId: "t_a",
      descriptor: profile("Synchronization guarantees"), reason: "Complete source evidence supports the final definition." }] });
    const forged = structuredClone(repair);
    forged.coverage[0].digest = "0".repeat(64);
    expect(() => fixture.apply(incoming, forged, true)).toThrow(expect.objectContaining({ code: "topic_state_changed" }));
    expect(fixture.registry.snapshot()).toEqual(before.cards);
    expect(fixture.evidenceState(previous.incoming.id)).toEqual(before.incoming);
    expect(fixture.evidenceState(history.incoming.id)).toEqual(before.history);
    expect(fixture.assignment(previous.incoming.id)).toEqual(before.assignments);
    expect(fixture.db.query("SELECT source_hash FROM hr_conversations WHERE scope_id=? AND id=?").get(fixture.scope.id, previous.incoming.id))
      .toEqual({ source_hash: previous.incoming.sourceHash });
    expect(fixture.db.query("SELECT kind FROM hr_topic_events WHERE scope_id=?").all(fixture.scope.id)).toEqual([]);
    expect(fixture.apply(incoming, repair, true)).toEqual({ created: 0, updated: 1, merged: 0, reassigned: 0 });
    expect(fixture.registry.snapshot().revision).toBe(1);
    expect(fixture.db.query("SELECT source_hash FROM hr_conversations WHERE scope_id=? AND id=?").get(fixture.scope.id, incoming.incoming.id))
      .toEqual({ source_hash: incoming.incoming.sourceHash });
    expect(fixture.db.query("SELECT entry_id,hash FROM hr_entries WHERE scope_id=? AND conversation_id=? ORDER BY entry_id")
      .all(fixture.scope.id, incoming.incoming.id)).toEqual(incoming.source.entries.map(entry => ({ entry_id: entry.id, hash: entry.hash })));
    expect(fixture.evidenceState(history.incoming.id)).toEqual(before.history);
  });

  it("creates schema 5 without a historical vote table", async () => {
    const fixture = await setup();
    expect(fixture.db.query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
    expect(fixture.db.query("SELECT name FROM sqlite_schema WHERE name='hr_topic_votes'").all()).toEqual([]);
  });
});
