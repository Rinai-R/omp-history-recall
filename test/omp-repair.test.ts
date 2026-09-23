import { expect, it, setSystemTime } from "bun:test";
import { z } from "zod";
import { openHistoryDatabase } from "../src/database";
import { inputBudget } from "../src/chunking";
import { createRuntimeFixture, nativeToolReply, streamReply } from "./runtime-fixture";

it("executes restricted native evidence tools and preserves the parent after child disposal", async () => {
  let parentToolNames: (() => string[]) | undefined;
  const fixture = await createRuntimeFixture({ seedConversations: false, nativeReply: (_request, respond) => {
    expect(parentToolNames!().filter(name => name.startsWith("repair_"))).toEqual([]);
    return respond();
  } });
  parentToolNames = () => fixture.session.getAllToolInfos().map(tool => tool.name);
  try {
    expect(parentToolNames().filter(name => name.startsWith("repair_"))).toEqual([]);
    await fixture.session.prompt("An ordinary parent conversation without indexing.");
    expect(fixture.nativeRequests).toHaveLength(0);
    const result = await fixture.runNativeBoundary();
    expect(result.repair.proposal.drafts.map(draft => draft.ref)).toEqual(["repair:0"]);
    expect(result.repair.proposal.moves).toHaveLength(1);
    expect(result.repair.receipts).toHaveLength(1);
    expect(result.repair.coverage).toMatchObject([{ targetRef: "repair:0", memberCount: 1 }]);
    expect(result.completion.proposal_id).toBe(result.repair.proposalId);
    expect([...new Set(fixture.nativeToolCalls.map(call => call.name))].sort()).toEqual([
      "repair_check", "repair_coverage", "repair_members", "repair_propose", "repair_read", "repair_topics",
    ]);
    expect(fixture.nativeRequests.length).toBe(result.calls);
    expect(fixture.nativePeak).toBe(1);
    for (const request of fixture.nativeRequests) {
      expect(request.messages.some(message => typeof message.content === "string" && message.content.includes(fixture.cwds.c))).toBe(false);
    }
    expect(parentToolNames().filter(name => name.startsWith("repair_"))).toEqual([]);
    const parent = await fixture.tool("history_recall_conversations");
    expect(parent.isError).toBe(false);
    expect(fixture.mainRequests.length).toBeGreaterThan(0);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
}, 120_000);

it("runs the native loop under simulated strict-provider object schemas and nullable placeholders", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false, nativeReply: async (request, respond) => {
    const tools = z.array(z.object({ function: z.object({ name: z.string(), parameters: z.record(z.string(), z.unknown()) }) }))
      .parse(request.tools);
    // Local simulation of OpenAI/Codex's root-object restriction, not a real-provider test.
    for (const tool of tools) {
      expect(tool.function.parameters.type).toBe("object");
      expect(tool.function.parameters.anyOf).toBeUndefined();
      expect(tool.function.parameters.oneOf).toBeUndefined();
      expect(tool.function.parameters.additionalProperties).toBe(false);
    }
    const first = (await respond().text()).split("\n\n")[0];
    const chunk = z.object({ choices: z.array(z.object({ delta: z.object({ tool_calls: z.array(z.object({
      function: z.object({ name: z.string(), arguments: z.string() }),
    }).passthrough()) }).passthrough() })) }).parse(JSON.parse(first.slice("data: ".length)));
    const delta = chunk.choices[0].delta;
    for (const call of delta.tool_calls) {
      const schema = tools.find(tool => tool.function.name === call.function.name)!.function.parameters;
      const properties = z.record(z.string(), z.unknown()).parse(schema.properties);
      const args = z.record(z.string(), z.unknown()).parse(JSON.parse(call.function.arguments));
      for (const key of Object.keys(properties)) if (!(key in args)) args[key] = null;
      call.function.arguments = JSON.stringify(args);
    }
    return streamReply(delta, "tool_calls");
  } });
  try {
    const result = await fixture.runNativeBoundary({ text: "WAL fsync failed; acknowledgements remain blocked. ".repeat(180) });
    expect(result.repair.receipts).toHaveLength(1);
    expect(result.repair.coverage).toMatchObject([{ targetRef: "repair:0", memberCount: 1 }]);
    expect(result.repair.proposal.merge).toBeNull();
    expect(fixture.nativeToolCalls.some(call => call.name === "repair_read" && call.args.action === "remember")).toBe(true);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
}, 120_000);

it("retains the required nullable no-op proposal ID while normalizing optional native yield fields", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false, nativeReply: () => nativeToolReply([
    { name: "yield", args: { data: { proposal_id: null, reason: "Keep this initial selection." }, type: null, error: null } },
  ]) });
  try {
    const result = await fixture.runNativeBoundary();
    expect(result.completion.proposal_id).toBeNull();
    expect(result.repair.proposal.moves).toEqual([]);
    expect(result.repair.proposal.merge).toBeNull();
    expect(fixture.nativeRequests).toHaveLength(1);
  } finally { await fixture.close(); }
}, 120_000);

it("does not hide unknown non-null fields when normalizing valid transport nulls", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false, nativeReply: () => nativeToolReply([
    { name: "repair_topics", args: { cursor: null, forbidden: "not part of the tool contract" } },
  ]) });
  try {
    await expect(fixture.runNativeBoundary()).rejects.toMatchObject({ code: "invalid_model_output" });
    expect(fixture.nativeToolCalls).toEqual([]);
  } finally { await fixture.close(); }
}, 120_000);

it("replays cached native responses while rebuilding complete receipts", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false });
  try {
    const result = await fixture.runNativeBoundary();
    expect(result.repair.receipts).toHaveLength(1);
    expect(result.repair.coverage).toMatchObject([{ targetRef: "repair:0", memberCount: 1 }]);
    const requests = fixture.nativeRequests.length;
    expect(result.calls).toBe(requests);
    const replay = await fixture.runNativeBoundary();
    expect(replay.calls).toBe(0);
    expect(replay.repair).toEqual(result.repair);
    expect(fixture.nativeRequests.length).toBe(requests);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
}, 120_000);

it("reuses exact native cache across a new UTC day without losing historical text", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false });
  try {
    const first = await fixture.runNativeBoundary({ text: "2026-01-03 /tmp/original-path: WAL fsync failed; writes must not be acknowledged" });
    const requests = fixture.nativeRequests.length;
    setSystemTime(new Date(Date.now() + 86_400_000));
    const second = await fixture.runNativeBoundary({ text: "2026-01-03 /tmp/original-path: WAL fsync failed; writes must not be acknowledged" });
    expect(second.calls).toBe(0);
    expect(second.repair).toEqual(first.repair);
    expect(fixture.nativeRequests.length).toBe(requests);
    expect(JSON.stringify(fixture.nativeRequests)).toContain("2026-01-03 /tmp/original-path");
  } finally { setSystemTime(); await fixture.close(); }
}, 120_000);

it("evicts only the poisoned terminal request and retains successful evidence responses", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false });
  try {
    await fixture.runNativeBoundary();
    const requests = fixture.nativeRequests.length;
    const db = openHistoryDatabase(fixture.store.dbPath);
    try {
      const rows = db.query<{ key: string; payload: string }, [string]>("SELECT key,payload FROM hr_cache WHERE scope_id=?").all(fixture.scope.id);
      const poisoned = rows.find(row => {
        const response = JSON.parse(row.payload);
        return response.role === "assistant" && response.content.some((block: { name?: string }) => block.name === "yield");
      });
      expect(poisoned).toBeDefined();
      const response = JSON.parse(poisoned!.payload);
      response.content.find((block: { name?: string }) => block.name === "yield").arguments.data = { proposal_id: 42, reason: "poisoned" };
      db.run("UPDATE hr_cache SET payload=? WHERE scope_id=? AND key=?", [JSON.stringify(response), fixture.scope.id, poisoned!.key]);
      await expect(fixture.runNativeBoundary()).rejects.toMatchObject({ code: "invalid_model_output" });
      expect(fixture.nativeRequests.length).toBe(requests);
      const remaining = db.query<{ key: string }, [string]>("SELECT key FROM hr_cache WHERE scope_id=? ORDER BY key").all(fixture.scope.id).map(row => row.key);
      expect(remaining).toEqual(rows.filter(row => row.key !== poisoned!.key).map(row => row.key).sort());
      const recovered = await fixture.runNativeBoundary();
      expect(recovered.calls).toBe(1);
      expect(recovered.repair.receipts).toHaveLength(1);
      expect(fixture.nativeRequests.length).toBe(requests + 1);
    } finally { db.close(); }
  } finally { await fixture.close(); }
}, 120_000);

it("rejects mixed yield and read before dispatching either tool", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false, nativeReply: () => nativeToolReply([
    { name: "yield", args: { data: { proposal_id: null, reason: "premature" } } },
    { name: "repair_read", args: { action: "read", conversation_id: "forged", facet_id: "f0", entry_id: "forged" } },
  ]) });
  try {
    await expect(fixture.runNativeBoundary()).rejects.toMatchObject({ code: "invalid_model_output" });
    expect(fixture.nativeRequests).toHaveLength(1);
    expect(fixture.nativeToolCalls).toEqual([]);
    expect(fixture.store.status().conversations).toBe(0);
  } finally { await fixture.close(); }
}, 120_000);

it("does not expose ordinary native tools or recover an illegal call as success", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false, nativeReply: () => nativeToolReply([
    { name: "bash", args: { command: "exit 0" } },
  ]) });
  try {
    await expect(fixture.runNativeBoundary()).rejects.toMatchObject({ code: "invalid_model_output" });
    expect(fixture.nativeRequests).toHaveLength(1);
    expect(fixture.nativeToolCalls).toEqual([]);
    expect(fixture.store.status().conversations).toBe(0);
  } finally { await fixture.close(); }
}, 120_000);

it("treats a normal stop without yield as incomplete rather than a no-op", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false, nativeReply: () => streamReply({ role: "assistant", content: "Everything looks fine." }) });
  try {
    await expect(fixture.runNativeBoundary()).rejects.toMatchObject({ code: "repair_incomplete" });
    expect(fixture.nativeRequests).toHaveLength(1);
  } finally { await fixture.close(); }
}, 120_000);

it("rejects a truncated response even when it contains a syntactically valid yield", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false, nativeReply: () => streamReply({ role: "assistant", tool_calls: [
    { index: 0, id: "truncated-yield", type: "function", function: { name: "yield", arguments: JSON.stringify({ data: { proposal_id: null, reason: "No change" } }) } },
  ] }, "length") });
  try {
    await expect(fixture.runNativeBoundary()).rejects.toMatchObject({ code: "model_output_truncated" });
    expect(fixture.nativeToolCalls).toEqual([]);
  } finally { await fixture.close(); }
}, 120_000);

it("rejects aborted and malformed terminal yields without giving the model another turn", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false, nativeReply: () => nativeToolReply([
    { name: "yield", args: { error: "Unable to maintain this view" } },
  ]) });
  try {
    await expect(fixture.runNativeBoundary()).rejects.toMatchObject({ code: "invalid_model_output" });
    expect(fixture.nativeRequests).toHaveLength(1);
  } finally { await fixture.close(); }
}, 120_000);

it("does not launch a cancelled child or silently switch a non-native model", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false });
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(fixture.runNativeBoundary({ signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(fixture.nativeRequests).toHaveLength(0);
    const model = fixture.session.model!;
    const original = model.supportsTools;
    try {
      model.supportsTools = false;
      await expect(fixture.runNativeBoundary()).rejects.toMatchObject({ code: "unsupported_repair_model" });
    } finally { model.supportsTools = original; }
    process.env.PI_DIALECT = "xml";
    try { await expect(fixture.runNativeBoundary()).rejects.toMatchObject({ code: "unsupported_repair_model" }); }
    finally { delete process.env.PI_DIALECT; }
    expect(fixture.nativeRequests).toHaveLength(0);
  } finally { await fixture.close(); }
}, 120_000);

it("keeps long evidence partial until native remember and cursor reads reach its end", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false, contextWindow: 48_000 });
  try {
    const finalCorrection = "Final correction: acknowledgements remain blocked until fsync succeeds.";
    const text = "WAL fsync failed; writes must not be acknowledged. ".repeat(1400) + finalCorrection;
    expect(text.length).toBeGreaterThan(inputBudget(fixture.model.contextWindow, fixture.model.maxOutputTokens));
    const result = await fixture.runNativeBoundary({ text });
    expect(result.repair.coverage).toMatchObject([{ memberCount: 1 }]);
    const reads = fixture.nativeToolCalls.filter(call => call.name === "repair_read" && call.args.action === "read");
    expect(reads.length).toBeGreaterThan(1);
    const fragments = z.array(z.object({ offset: z.number(), text: z.string(), total_chars: z.number() }))
      .parse(reads.flatMap(call => Array.isArray(call.value.fragments) ? call.value.fragments : []));
    let receivedThrough = 0;
    for (const fragment of [...fragments].sort((left, right) => left.offset - right.offset)) {
      expect(fragment.offset).toBeLessThanOrEqual(receivedThrough);
      receivedThrough = Math.max(receivedThrough, fragment.offset + fragment.text.length);
    }
    expect(receivedThrough).toBe(fragments.at(-1)!.total_chars);
    expect(result.repair.receipts).toMatchObject([{ totalChars: receivedThrough }]);
    expect(fragments.map(fragment => fragment.text).join("")).toContain(finalCorrection);
    expect(fixture.nativeToolCalls.some(call => call.name === "repair_read" && call.args.action === "remember")).toBe(true);
    for (const call of fixture.nativeToolCalls) expect(Buffer.byteLength(JSON.stringify(call.value), "utf8")).toBeLessThan(48 * 1024);
    expect(JSON.stringify(fixture.nativeRequests)).not.toContain("artifact://");
  } finally { await fixture.close(); }
}, 120_000);

it("preserves cancellation when a gated native provider later returns a successful response", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fixture = await createRuntimeFixture({ seedConversations: false, nativeReply: async (_request, respond) => {
    entered.resolve();
    await release.promise;
    return respond();
  } });
  try {
    const controller = new AbortController();
    const pending = fixture.runNativeBoundary({ signal: controller.signal });
    await Promise.race([entered.promise, pending.then(() => { throw new Error("Native repair unexpectedly completed before its provider response"); })]);
    controller.abort();
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(fixture.nativeRequests).toHaveLength(1);
    expect(fixture.nativeToolCalls).toEqual([]);
    expect((await fixture.tool("history_recall_conversations")).isError).toBe(false);
  } finally { release.resolve(); await fixture.close(); }
}, 120_000);

it("fails closed on missing child authentication without closing the shared parent auth storage", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false });
  const registry = fixture.session.modelRegistry;
  const resolveKey = registry.getApiKey;
  try {
    registry.getApiKey = async () => undefined;
    await expect(fixture.runNativeBoundary()).rejects.toMatchObject({ code: "auth_unavailable" });
    expect(fixture.nativeRequests).toHaveLength(0);
    registry.getApiKey = resolveKey;
    expect((await fixture.tool("history_recall_conversations")).isError).toBe(false);
  } finally { registry.getApiKey = resolveKey; await fixture.close(); }
}, 120_000);

it("waits for the SDK-owned auth preflight to settle after parent cancellation", async () => {
  const fixture = await createRuntimeFixture({ seedConversations: false });
  const registry = fixture.session.modelRegistry;
  const resolveKey = registry.getApiKey;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let finished = false;
  let lookups = 0;
  try {
    registry.getApiKey = async (...args) => {
      lookups++;
      entered.resolve();
      await release.promise;
      return resolveKey.apply(registry, args);
    };
    const controller = new AbortController();
    const pending = fixture.runNativeBoundary({ signal: controller.signal });
    void pending.then(() => { finished = true; }, () => { finished = true; });
    await Promise.race([entered.promise, pending.then(() => { throw new Error("Repair completed before its credential preflight"); })]);
    controller.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(fixture.nativeRequests).toHaveLength(0);
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(lookups).toBe(1);
    expect(fixture.nativeRequests).toHaveLength(0);
  } finally { release.resolve(); registry.getApiKey = resolveKey; await fixture.close(); }
}, 120_000);
