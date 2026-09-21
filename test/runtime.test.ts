import { expect, it } from "bun:test";
import * as path from "node:path";
import { z } from "zod";
import { inputBudget } from "../src/chunking";
import { openHistoryDatabase } from "../src/database";
import { TopicDescriptorSchema } from "../src/semantic";
import { createRuntimeFixture, exerciseNativeRepair, exerciseSemanticRecall, nativeResults, nativeToolReply } from "./runtime-fixture";

it("runs cross-cwd semantic recall through real OMP tools without implicit indexing or dynamic prompts", async () => {
  const fixture = await createRuntimeFixture();
  try {
    await exerciseSemanticRecall(fixture);

    const callsBeforeErrors = fixture.utilityRequests.length + fixture.nativeRequests.length;
    const missing = await fixture.tool("history_recall_index", { file: path.join(fixture.scope.sessionsRoot, "missing.jsonl") });
    expect(missing).toMatchObject({ isError: true, value: { error: "invalid_file" } });
    const foreign = await fixture.tool("history_recall_index", { file: fixture.foreignFiles[0] });
    expect(foreign).toMatchObject({ isError: true, value: { error: "invalid_file" } });
    const topic = await fixture.tool("history_recall_browse", { topic_id: "t_unavailable" });
    expect(topic).toMatchObject({ isError: true, value: { error: "not_found" } });
    const cursor = await fixture.tool("history_recall_conversations", { cursor: await fixture.foreignCursor(), limit: 1 });
    expect(cursor).toMatchObject({ isError: true, value: { error: "stale_cursor" } });
    expect(fixture.utilityRequests.length + fixture.nativeRequests.length).toBe(callsBeforeErrors);
    expect(fixture.store.status().conversations).toBe(3);

    // Invalid command arity must not turn a selected-file request into bulk indexing.
    const requestsBeforeCommands = fixture.requests.length;
    for (const command of ["index", "index relative.jsonl", `index ${fixture.files.a} extra`, "index-all extra", "rebuild extra", "status extra", "conversations extra"]) {
      const notificationsBefore = fixture.notifications.length;
      await fixture.session.prompt(`/history-recall ${command}`);
      expect(fixture.notifications.length).toBe(notificationsBefore + 1);
      expect(fixture.notifications.at(-1)?.type).toBe("warning");
    }
    expect(fixture.requests.length).toBe(requestsBeforeCommands);
    expect(fixture.store.status().jobs).toEqual([]);

    // A work result with failed>0 must surface as a tool error, not a successful empty index.
    const rejectedFile = path.join(fixture.scope.sessionsRoot, "bucket-c", "rejected.jsonl");
    await fixture.writeConversation(rejectedFile, "rejected-source", fixture.cwds.c, "WAL failed with a distinct rejected witness");
    fixture.failNextAnalysis();
    const rejected = await fixture.tool("history_recall_index", { file: rejectedFile });
    expect(rejected).toMatchObject({ isError: true, value: { result: { completed: 0, failed: 1,
      errors: [{ file: rejectedFile, code: "invalid_model_output" }] } } });
    expect(fixture.store.status().conversations).toBe(3);
    expect(fixture.store.status().topics).toBe(2);
    expect(JSON.stringify(fixture.utilityRequests)).not.toContain("FOREIGN_PROFILE_SECRET");
    expect(JSON.stringify(fixture.nativeRequests)).not.toContain("FOREIGN_PROFILE_SECRET");
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 120_000);

it("automatically splits a historical-only topic and immediately merges equivalent topics through native evidence tools", async () => {
  const result = await exerciseNativeRepair();
  expect(result.historical_only_split).toBe(true);
  expect(result.immediate_merge).toBe(true);
  expect(result.source_original_readable).toBe(true);
  expect(result.source_entries_fts_unchanged).toBe(true);
  expect(result.parent_after_dispose).toBe(true);
  expect(result.repair_tools_exposed_to_parent).toBe(false);
  expect(result.child_tools_restricted).toBe(true);
  expect(result.ordinary_parent_child_calls).toBe(0);
  expect(result.split.incoming_topic_id).toBe(result.split.original_topic_id);
  expect(result.split.ui_topic_id).not.toBe(result.split.original_topic_id);
}, 180_000);

it("streams at least 130 final members through native singleton merge proofs within the normal context budget", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false, batchCalls: 1000, dailyCalls: 5000 });
  const finalMembers = 130;
  try {
    let survivor = "";
    // Seed actual sources using the same production analysis/native runner. A
    // controlled selector creates the second stable topic; no host plan is faked.
    for (let index = 0; index < finalMembers - 1; index++) {
      const file = path.join(fixture.scope.sessionsRoot, "large-merge", `${index}.jsonl`);
      await fixture.writeConversation(file, `large-${index}`, fixture.cwds.a,
        `WAL fsync failed; writes must not be acknowledged. Durable storage evidence ${index}.`);
      fixture.setSelectionMode(index === 1 ? "distinct" : "normal");
      await fixture.store.discover({ file });
      const seeded = await fixture.store.work(fixture.model, fixture.repairRunner,
        { file, maxJobs: 1, maxCalls: 12, maxDailyCalls: 5000, concurrency: fixture.concurrency });
      expect(seeded.errors).toEqual([]);
      expect(seeded.completed).toBe(1);
      if (index === 0) survivor = z.object({ entries: z.array(z.object({ id: z.string() })) }).parse(fixture.store.browse()).entries[0].id;
    }
    expect(fixture.store.status().topics).toBe(2);
    expect(fixture.store.status().conversations).toBe(finalMembers - 1);
    const file = path.join(fixture.scope.sessionsRoot, "large-merge", "trigger.jsonl");
    await fixture.writeConversation(file, `large-${finalMembers - 1}`, fixture.cwds.b,
      "The final durable storage conversation still requires fsync before acknowledging writes.");
    fixture.setSelectionMode("normal");
    fixture.setRepairMode("merge_stream");
    const requestStart = fixture.nativeRequests.length;
    const toolStart = fixture.nativeToolCalls.length;
    const indexed = await fixture.tool("history_recall_index", { file });
    expect(indexed).toMatchObject({ isError: false, value: { result: { completed: 1, failed: 0, topic_changes: { merged: 1 } } } });
    expect(fixture.store.status().conversations).toBe(finalMembers);
    expect(fixture.store.status().topics).toBe(1);
    expect(fixture.store.status().jobs).toEqual([]);
    const catalog = z.object({ entries: z.array(z.object({ id: z.string(), member_count: z.number() })) }).parse(fixture.store.browse());
    expect(catalog.entries).toMatchObject([{ id: survivor, member_count: finalMembers }]);

    const observedMembers = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = z.object({ entries: z.array(z.object({ session_id: z.string(), memberships: z.array(z.object({
        topic_id: z.string(), evidence_refs: z.array(z.object({ entry_id: z.string() })),
      })) })), next_cursor: z.string().nullable() }).parse(fixture.store.browse({ topic_id: survivor, limit: 50, cursor }));
      for (const member of page.entries) {
        expect(observedMembers.has(member.session_id)).toBe(false);
        observedMembers.add(member.session_id);
        expect(member.memberships).toMatchObject([{ topic_id: survivor, evidence_refs: [{ entry_id: `${member.session_id}-entry` }] }]);
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect([...observedMembers].sort()).toEqual(Array.from({ length: finalMembers }, (_, index) => `large-${index}`).sort());

    const calls = fixture.nativeToolCalls.slice(toolStart);
    expect(calls.some(call => call.name === "repair_topics")).toBe(true);
    expect(calls.some(call => call.name === "repair_members")).toBe(false);
    const coverages = calls.filter(call => call.name === "repair_coverage");
    const coverageMembers = coverages.map(call => z.array(z.object({ conversation_id: z.string(), facet_id: z.string() })).parse(call.value.members));
    expect(coverageMembers.filter(members => members.length === 1)).toHaveLength(finalMembers);
    expect(coverageMembers.every(members => members.length <= 1)).toBe(true);
    expect(coverageMembers.filter(members => members.length === 0)).toHaveLength(1);
    const checks = calls.filter(call => call.name === "repair_check");
    const fits = checks.flatMap(call => z.array(z.object({ conversation_id: z.string(), facet_id: z.string(), fits: z.literal(true) })).parse(call.args.fits));
    expect(fits).toHaveLength(finalMembers);
    expect(new Set(fits.map(fit => JSON.stringify([fit.conversation_id, fit.facet_id]))).size).toBe(finalMembers);
    expect(checks.every(call => call.value.accepted === true)).toBe(true);
    expect(checks.at(-1)?.args.fits).toEqual([]);
    expect(checks.at(-1)?.value).toMatchObject({ complete: true, member_count: finalMembers });

    const requests = fixture.nativeRequests.slice(requestStart);
    const byteBudget = inputBudget(fixture.model.contextWindow, fixture.model.maxOutputTokens);
    for (const request of requests) expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThanOrEqual(byteBudget);
    for (const call of calls) expect(Buffer.byteLength(JSON.stringify(call.value), "utf8")).toBeLessThan(48 * 1024);
    expect(JSON.stringify(requests)).not.toContain("artifact://");
    expect(fixture.nativePeak).toBeLessThanOrEqual(fixture.concurrency);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
}, 300_000);

it("executes native read then check then next coverage within one assistant tool-call batch", async () => {
  let proposedBeforeEvidence = false;
  let sentOrderedBatch = false;
  let observedOrderedBatch = false;
  const fixture = await createRuntimeFixture({ seedConversations: false, nativeReply(request, respond) {
    const results = nativeResults(request);
    const latest = results.at(-1);
    if (latest?.name === "repair_members" && !proposedBeforeEvidence) {
      expect(results.some(result => result.name === "repair_read")).toBe(false);
      const member = z.object({ members: z.array(z.object({ conversation_id: z.string(), source_hash: z.string(),
        facet_id: z.string(), topic_id: z.string(), descriptor: TopicDescriptorSchema,
      })).length(1) }).parse(latest.value).members[0];
      proposedBeforeEvidence = true;
      return nativeToolReply([{ name: "repair_propose", args: {
        drafts: [{ ref: "repair:0", descriptor: member.descriptor }], updates: [], merge: null,
        moves: [{ conversationId: member.conversation_id, sourceHash: member.source_hash, facetId: member.facet_id,
          fromTopicRef: member.topic_id, targetRef: "repair:0", reason: "Verify the destination using the upcoming native evidence batch." }],
        reason: "Stage a singleton proof before reading so native ordering must enforce evidence completion.",
      } }], "ordered-proposal");
    }
    if (latest?.name === "repair_coverage" && !sentOrderedBatch) {
      expect(results.some(result => result.name === "repair_read")).toBe(false);
      const page = z.object({ proposal_id: z.string(), target_ref: z.string(), page_id: z.string(), next_cursor: z.string(),
        members: z.array(z.object({ conversation_id: z.string(), facet_id: z.string(), evidence: z.array(z.object({ id: z.string() })).min(1) })).length(1),
      }).parse(latest.value);
      const member = page.members[0];
      sentOrderedBatch = true;
      return nativeToolReply([
        { name: "repair_read", args: { action: "read", conversation_id: member.conversation_id,
          facet_id: member.facet_id, entry_id: member.evidence[0].id } },
        { name: "repair_check", args: { proposal_id: page.proposal_id, page_id: page.page_id,
          fits: [{ conversation_id: member.conversation_id, facet_id: member.facet_id, fits: true }] } },
        { name: "repair_coverage", args: { proposal_id: page.proposal_id, target_ref: page.target_ref, cursor: page.next_cursor } },
      ], "ordered-proof");
    }
    const batch = results.filter(result => result.id.startsWith("ordered-proof_"));
    if (batch.length && !observedOrderedBatch) {
      expect(batch.map(result => result.name)).toEqual(["repair_read", "repair_check", "repair_coverage"]);
      expect(batch[0].value).toMatchObject({ next_cursor: null });
      expect(batch[1].value).toMatchObject({ checked: true, accepted: true, member_count: 1, complete: false });
      expect(batch[2].value).toMatchObject({ members: [], next_cursor: null });
      observedOrderedBatch = true;
    }
    return respond();
  } });
  try {
    const result = await fixture.runNativeBoundary();
    expect(proposedBeforeEvidence).toBe(true);
    expect(sentOrderedBatch).toBe(true);
    expect(observedOrderedBatch).toBe(true);
    expect(result.completion.proposal_id).toBe(result.repair.proposalId);
    expect(result.repair.receipts).toHaveLength(1);
    expect(result.repair.coverage).toMatchObject([{ memberCount: 1 }]);
    const finalCheck = fixture.nativeToolCalls.filter(call => call.name === "repair_check").at(-1);
    expect(finalCheck?.args.fits).toEqual([]);
    expect(finalCheck?.value).toMatchObject({ accepted: true, complete: true, member_count: 1 });
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
}, 120_000);

it("holds the index lease until an ignored-abort native HTTP request actually settles", async () => {
  const originalFetch = globalThis.fetch;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const network = new Set<Promise<Response>>();
  const originalSignals: AbortSignal[] = [];
  const controller = new AbortController();
  let gateNative = false;
  let settledWork: Promise<unknown> | undefined;
  const fixture = await createRuntimeFixture({ seedConversations: false,
    providerFetch(input, init) {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      expect(new URL(request.url).hostname).toBe("127.0.0.1");
      originalSignals.push(request.signal);
      // Both effective signal locations ignore cancellation, while the real
      // SDK lazy provider and local HTTP transport remain otherwise unchanged.
      const signal = new AbortController().signal;
      const pending = originalFetch(new Request(request, { signal }), { signal });
      network.add(pending);
      void pending.then(() => network.delete(pending), () => network.delete(pending));
      return pending;
    },
    async nativeReply(_request, respond) {
      if (gateNative) {
        entered.resolve();
        await release.promise;
      }
      return respond();
    },
  });
  const db = openHistoryDatabase(fixture.store.dbPath);
  try {
    await fixture.writeConversation(fixture.files.a, "drain-history-a", fixture.cwds.a,
      "WAL fsync failed; writes must not be acknowledged.");
    await fixture.store.discover({ file: fixture.files.a });
    const seeded = await fixture.store.work(fixture.model, fixture.repairRunner,
      { file: fixture.files.a, maxCalls: 100, maxDailyCalls: 1000 });
    expect(seeded.completed).toBe(1);
    expect(seeded.errors).toEqual([]);
    const visibleBefore = fixture.store.status();
    await fixture.writeConversation(fixture.files.b, "drain-incoming-b", fixture.cwds.b,
      "WAL fsync failed again; acknowledgements remain blocked until durable recovery.");
    await fixture.store.discover({ file: fixture.files.b });
    gateNative = true;
    const work = fixture.store.work(fixture.model, fixture.repairRunner,
      { file: fixture.files.b, maxCalls: 100, maxDailyCalls: 1000, signal: controller.signal });
    const outcome = work.then(value => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }));
    settledWork = outcome;
    await Promise.race([entered.promise, outcome.then(result => {
      throw new Error(`Work settled before reaching the local native provider gate: ${JSON.stringify(result)}`);
    })]);
    const query = db.query<{ token: string; lease_until: number; error: string | null; attempts: number }, [string, string]>(
      "SELECT token,lease_until,error,attempts FROM hr_jobs WHERE scope_id=? AND file=?");
    const beforeAbort = query.get(fixture.scope.id, fixture.files.b)!;
    expect(beforeAbort.token.length).toBeGreaterThan(0);
    expect(beforeAbort.lease_until).toBeGreaterThan(Date.now());
    controller.abort();
    // Real HTTP cancellation and SQLite lease deadlines share platform time;
    // fake timers would not drive the SDK's native transport settlement.
    const settledBeforeRelease = await Promise.race([outcome.then(() => true), Bun.sleep(2000).then(() => false)]);
    const held = query.get(fixture.scope.id, fixture.files.b)!;
    const forced = await fixture.store.discover({ file: fixture.files.b, force: true });
    expect(originalSignals.at(-1)?.aborted).toBe(true);
    expect(network.size).toBe(1);
    expect(settledBeforeRelease).toBe(false);
    expect(held.lease_until).toBeGreaterThan(Date.now());
    expect(held.token).toBe(beforeAbort.token);
    expect(forced.queued).toBe(0);
    expect(query.get(fixture.scope.id, fixture.files.b)?.token).toBe(beforeAbort.token);
    expect(fixture.store.status()).toMatchObject({ conversations: visibleBefore.conversations,
      topics: visibleBefore.topics, revision: visibleBefore.revision, indexed_entries: visibleBefore.indexed_entries });

    release.resolve();
    const final = await outcome;
    await Promise.allSettled([...network]);
    expect(final).toMatchObject({ status: "rejected", error: { code: "cancelled" } });
    expect(network.size).toBe(0);
    expect(query.get(fixture.scope.id, fixture.files.b)).toMatchObject({ token: "", lease_until: 0, error: "cancelled", attempts: 0 });
    expect(fixture.store.status()).toMatchObject({ conversations: visibleBefore.conversations,
      topics: visibleBefore.topics, revision: visibleBefore.revision, indexed_entries: visibleBefore.indexed_entries });
    expect(fixture.errors).toEqual([]);
  } finally {
    release.resolve();
    controller.abort();
    await settledWork;
    await Promise.allSettled([...network]);
    db.close();
    await fixture.close();
  }
}, 120_000);

it("holds the lease while an ignored-abort native response body and its cancellation cleanup remain active", async () => {
  const originalFetch = globalThis.fetch;
  const bodyWaiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const headersPending = new Set<Promise<Response>>();
  const bodyReads = new Set<Promise<unknown>>();
  const bodyCancellations = new Set<Promise<void>>();
  const serverPumps = new Set<Promise<void>>();
  const controller = new AbortController();
  let gateNative = false;
  let headersReceived = false;
  let forwardedChunks = 0;
  let originalSignal: AbortSignal | undefined;
  let settledWork: Promise<unknown> | undefined;
  const fixture = await createRuntimeFixture({ seedConversations: false,
    async providerFetch(input, init) {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      expect(new URL(request.url).hostname).toBe("127.0.0.1");
      const signal = new AbortController().signal;
      const pending = originalFetch(new Request(request, { signal }), { signal });
      headersPending.add(pending);
      void pending.then(() => headersPending.delete(pending), () => headersPending.delete(pending));
      const response = await pending;
      if (response.headers.get("x-history-native-body") !== "gated") return response;
      originalSignal = request.signal;
      headersReceived = true;
      const reader = response.body!.getReader();
      let cancelling = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(target) {
          const reading = reader.read();
          bodyReads.add(reading);
          void reading.then(() => bodyReads.delete(reading), () => bodyReads.delete(reading));
          if (forwardedChunks > 0) bodyWaiting.resolve();
          const chunk = await reading;
          if (cancelling) return;
          if (chunk.done) target.close();
          else { forwardedChunks++; target.enqueue(chunk.value); }
        },
        cancel(reason) {
          cancelling = true;
          // Controlled uncooperative client cleanup, not remote CPU work:
          // iterator.return must await this actual body-cancel promise too.
          const closing = release.promise.then(() => reader.cancel(reason));
          bodyCancellations.add(closing);
          void closing.then(() => bodyCancellations.delete(closing), () => bodyCancellations.delete(closing));
          return closing;
        },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
    async nativeReply(_request, respond) {
      const response = respond();
      if (!gateNative) return response;
      const wire = await response.text();
      const firstFrameEnd = wire.indexOf("\n\n") + 2;
      expect(firstFrameEnd).toBeGreaterThan(2);
      const encoder = new TextEncoder();
      let disconnected = false;
      const body = new ReadableStream<Uint8Array>({
        start(target) {
          target.enqueue(encoder.encode(wire.slice(0, firstFrameEnd)));
          const pumping = release.promise.then(() => {
            if (!disconnected) { target.enqueue(encoder.encode(wire.slice(firstFrameEnd))); target.close(); }
          });
          serverPumps.add(pumping);
          void pumping.then(() => serverPumps.delete(pumping), () => serverPumps.delete(pumping));
        },
        cancel() { disconnected = true; },
      });
      const headers = new Headers(response.headers);
      headers.set("x-history-native-body", "gated");
      return new Response(body, { status: response.status, headers });
    },
  });
  const db = openHistoryDatabase(fixture.store.dbPath);
  try {
    await fixture.writeConversation(fixture.files.a, "body-history-a", fixture.cwds.a,
      "WAL fsync failed; writes must not be acknowledged.");
    await fixture.store.discover({ file: fixture.files.a });
    const seeded = await fixture.store.work(fixture.model, fixture.repairRunner,
      { file: fixture.files.a, maxCalls: 100, maxDailyCalls: 1000 });
    expect(seeded.completed).toBe(1);
    expect(seeded.errors).toEqual([]);
    const visibleBefore = fixture.store.status();
    await fixture.writeConversation(fixture.files.b, "body-incoming-b", fixture.cwds.b,
      "WAL fsync failed again; the durable acknowledgement remains blocked.");
    await fixture.store.discover({ file: fixture.files.b });
    gateNative = true;
    const work = fixture.store.work(fixture.model, fixture.repairRunner,
      { file: fixture.files.b, maxCalls: 100, maxDailyCalls: 1000, signal: controller.signal });
    const outcome = work.then(value => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }));
    settledWork = outcome;
    await Promise.race([bodyWaiting.promise, outcome.then(result => {
      throw new Error(`Work settled before reaching the mid-body read gate: ${JSON.stringify(result)}`);
    })]);
    const query = db.query<{ token: string; lease_until: number; error: string | null }, [string, string]>(
      "SELECT token,lease_until,error FROM hr_jobs WHERE scope_id=? AND file=?");
    const beforeAbort = query.get(fixture.scope.id, fixture.files.b)!;
    expect(headersReceived).toBe(true);
    expect(forwardedChunks).toBeGreaterThan(0);
    expect(headersPending.size).toBe(0);
    expect(bodyReads.size).toBe(1);
    controller.abort();
    // Native stream cancellation and SQLite leases require platform time;
    // fake timers cannot drive the active HTTP body reader or its cleanup.
    const settledBeforeRelease = await Promise.race([outcome.then(() => true), Bun.sleep(2000).then(() => false)]);
    const held = query.get(fixture.scope.id, fixture.files.b)!;
    const forced = await fixture.store.discover({ file: fixture.files.b, force: true });
    expect(originalSignal?.aborted).toBe(true);
    expect(bodyReads.size + bodyCancellations.size).toBeGreaterThan(0);
    expect(settledBeforeRelease).toBe(false);
    expect(held.token.length).toBeGreaterThan(0);
    expect(held.token).toBe(beforeAbort.token);
    expect(held.lease_until).toBeGreaterThan(Date.now());
    expect(forced.queued).toBe(0);
    expect(query.get(fixture.scope.id, fixture.files.b)?.token).toBe(beforeAbort.token);
    expect(fixture.store.status()).toMatchObject({ conversations: visibleBefore.conversations,
      topics: visibleBefore.topics, revision: visibleBefore.revision, indexed_entries: visibleBefore.indexed_entries });
    release.resolve();
    expect(await outcome).toMatchObject({ status: "rejected", error: { code: "cancelled" } });
    await Promise.allSettled([...headersPending, ...bodyReads, ...bodyCancellations, ...serverPumps]);
    expect(bodyReads.size).toBe(0);
    expect(bodyCancellations.size).toBe(0);
    expect(query.get(fixture.scope.id, fixture.files.b)).toMatchObject({ token: "", lease_until: 0, error: "cancelled" });
    expect(fixture.store.status()).toMatchObject({ conversations: visibleBefore.conversations,
      topics: visibleBefore.topics, revision: visibleBefore.revision, indexed_entries: visibleBefore.indexed_entries });
    expect(fixture.errors).toEqual([]);
  } finally {
    release.resolve();
    controller.abort();
    await settledWork;
    await Promise.allSettled([...headersPending, ...bodyReads, ...bodyCancellations, ...serverPumps]);
    db.close();
    await fixture.close();
  }
}, 120_000);
