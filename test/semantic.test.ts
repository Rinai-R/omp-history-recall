import { describe, expect, it } from "bun:test";
import { analyzeConversation, conversationFacts, generateJson, rewriteQuery, validateConversationAnalysis, TopicDescriptorSchema,
  type ConversationAnalysis, type JsonModel } from "../src/semantic";
import { inputBudget, planChunks, requestBytes, type IndexedEntry } from "../src/chunking";
import { mapConcurrent } from "../src/concurrency";
import { loadSource, type SourceEntry } from "../src/source";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { timeRange } from "../src/time";
import { z } from "zod";

async function source() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recall-semantic-"));
  const file = path.join(root, "s.jsonl");
  const records = [
    { type: "session", version: 3, id: "s", cwd: root, timestamp: "2026-09-20T01:00:00Z", title: "Storage" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-09-20T01:00:00Z", message: { role: "user", content: "WAL sync failed" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-20T01:10:00Z", message: { role: "assistant", content: "Do not acknowledge failed writes." } },
    { type: "message", id: "u2", parentId: "a1", timestamp: "2026-09-20T03:00:00Z", message: { role: "user", content: "Continue later" } },
  ];
  await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const loaded = await loadSource(file);
  return { root, file, loaded, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function entries(count: number, text: string): SourceEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `e${String(index).padStart(3, "0")}`, parentId: null, timestamp: "2026-09-20T01:00:00Z", type: "message", role: "user",
    text, line: index + 1, hash: `h${index}`, raw: "",
  }));
}

type CallInput = {
  stage: "analysis_map" | "analysis_reduce" | "analysis_final";
  entries?: IndexedEntry[];
  segments?: { summary: string; facets: { evidence_entry_ids: string[] }[] }[];
  entry_count?: number;
};

function responseFacet(input: CallInput) {
  const ids = input.entries?.map(entry => entry.id)
    ?? input.segments!.flatMap(segment => segment.facets.flatMap(facet => facet.evidence_entry_ids));
  return { title: "Storage durability", description: "WAL persistence.", aliases: ["WAL"],
    evidence_entry_ids: [...new Set(ids)].slice(0, 12) };
}

function gatedModel() {
  const calls: { system: string; input: unknown; signal?: AbortSignal; response: PromiseWithResolvers<string> }[] = [];
  const invalidated: { system: string; input: unknown }[] = [];
  let changed = Promise.withResolvers<void>();
  let active = 0;
  let maximumActive = 0;
  const notify = () => {
    const previous = changed;
    changed = Promise.withResolvers<void>();
    previous.resolve();
  };
  const model: JsonModel = {
    identity: "gated", contextWindow: 10_000, maxOutputTokens: 1024,
    generate(system, input, signal) {
      const response = Promise.withResolvers<string>();
      calls.push({ system, input, signal, response });
      active++;
      maximumActive = Math.max(maximumActive, active);
      response.promise.then(() => { active--; }, () => { active--; });
      notify();
      return response.promise;
    },
    invalidateCachedResponse(system, input) {
      invalidated.push({ system, input });
      notify();
    },
  };
  return {
    model, calls, invalidated,
    get active() { return active; },
    get maximumActive() { return maximumActive; },
    async waitForCalls(count: number) {
      while (calls.length < count) await changed.promise;
    },
    async waitForInvalidations(count: number) {
      while (invalidated.length < count) await changed.promise;
    },
  };
}

describe("bounded concurrency", () => {
  it("refills free slots without reordering results or exceeding either concurrency boundary", async () => {
    for (const concurrency of [1, 32]) {
      const gates = Array.from({ length: concurrency + 2 }, () => Promise.withResolvers<number>());
      const started: number[] = [];
      const run = mapConcurrent(gates, concurrency, (gate, index) => {
        started.push(index);
        return gate.promise;
      });
      expect(started).toEqual(Array.from({ length: concurrency }, (_, index) => index));
      for (let index = concurrency - 1; index < gates.length; index++) {
        gates[index].resolve(index);
        await gates[index].promise;
        expect(started).toHaveLength(Math.min(index + 2, gates.length));
      }
      for (let index = concurrency - 2; index >= 0; index--) gates[index].resolve(index);
      expect(await run).toEqual(gates.map((_, index) => index));
    }
  });

  it("stops queued tasks on the first error and drains a still-running peer", async () => {
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers<number>());
    const started: number[] = [];
    const finished: number[] = [];
    const failure = new Error("provider failed");
    const run = mapConcurrent(gates, 2, async (gate, index) => {
      started.push(index);
      const value = await gate.promise;
      finished.push(index);
      return value;
    });
    let settled = false;
    const outcome = run.then(() => {
      settled = true;
      return { error: undefined, finished: [...finished] };
    }, (error: unknown) => {
      settled = true;
      return { error, finished: [...finished] };
    });
    gates[0].reject(failure);
    // Drain ready promise continuations; the peer remains blocked on its gate.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(started).toEqual([0, 1]);
    gates[1].resolve(1);
    expect(await outcome).toEqual({ error: failure, finished: [1] });
    expect(started).toEqual([0, 1]);
  });

  it("does not start work for an already-aborted signal", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before scheduling");
    controller.abort(reason);
    const started: number[] = [];
    await expect(mapConcurrent([0, 1], 2, async item => {
      started.push(item);
      return item;
    }, controller.signal)).rejects.toBe(reason);
    expect(started).toEqual([]);
  });
});

describe("conversation semantics", () => {
  it("computes activity windows, message counts, user turns and branches", async () => {
    const fixture = await source();
    try {
      const facts = conversationFacts(fixture.loaded);
      expect(facts).toMatchObject({ entry_count: 3, message_count: 3, user_turn_count: 2, branch_count: 0 });
      expect(facts.active_windows).toHaveLength(2);
      expect(facts.active_windows[1].entries).toBe(1);
    } finally { await fixture.cleanup(); }
  });

  it("rejects malformed analysis and rewrite model output", async () => {
    const fixture = await source();
    try {
      const facts = conversationFacts(fixture.loaded);
      await expect(analyzeConversation({ identity: "bad", generate: async () => "not json" }, fixture.loaded, facts))
        .rejects.toMatchObject({ code: "invalid_model_output" });
      await expect(rewriteQuery({ identity: "bad", generate: async () => '{"queries":[]}' }, ["query"]))
        .rejects.toMatchObject({ code: "invalid_model_output" });
    } finally { await fixture.cleanup(); }
  });

  it("does not call a model or invent facets for a source without text", async () => {
    const fixture = await source();
    try {
      const loaded = { ...fixture.loaded, entries: entries(2, "") };
      const controlled = gatedModel();
      const analysis = await analyzeConversation(controlled.model, loaded, conversationFacts(loaded));
      expect(analysis.facets).toEqual([]);
      expect(validateConversationAnalysis(analysis, loaded)).toEqual(analysis);
      expect(controlled.calls).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  it("assigns local facet IDs after validation and preserves independent branch references", async () => {
    const fixture = await source();
    try {
      const loaded = { ...fixture.loaded, entries: fixture.loaded.entries.map(entry => ({ ...entry })) };
      loaded.entries[2].parentId = "u1";
      loaded.entries[2].text = "Alternative branch: fsync succeeds, but the earlier branch still failed.";
      const requests: CallInput[] = [];
      const analysis = await analyzeConversation({
        identity: "branches",
        async generate(_system, input) {
          requests.push(input as CallInput);
          return JSON.stringify({ summary: "Conflicting durability outcomes remain on separate branches.", facets: [
            { title: " Storage durability ", description: " Conflicting fsync outcomes ", aliases: [" WAL "], evidence_entry_ids: ["a1", "u2"] },
            { title: "Acknowledgments", description: "Do not acknowledge failed writes.", aliases: [], evidence_entry_ids: ["a1"] },
          ] });
        },
      }, loaded, conversationFacts(loaded));
      expect(requests).toHaveLength(1);
      expect(requests[0].stage).toBe("analysis_final");
      expect(requests[0].entries!.map(entry => [entry.id, entry.parent_id])).toEqual([["u1", null], ["a1", "u1"], ["u2", "u1"]]);
      expect(analysis.facets).toEqual([
        { id: "f0", title: "Storage durability", description: "Conflicting fsync outcomes", aliases: ["WAL"], evidence_entry_ids: ["a1", "u2"] },
        { id: "f1", title: "Acknowledgments", description: "Do not acknowledge failed writes.", aliases: [], evidence_entry_ids: ["a1"] },
      ]);
      expect(validateConversationAnalysis(analysis, loaded)).toEqual(analysis);
    } finally { await fixture.cleanup(); }
  });

  it("rejects malformed evidence instead of silently dropping references or accepting model-owned IDs", async () => {
    const fixture = await source();
    try {
      const descriptor = { title: "Storage", description: "Durability", aliases: [] };
      for (const facets of [
        [{ ...descriptor, evidence_entry_ids: ["missing"] }],
        [{ ...descriptor, evidence_entry_ids: ["u1", "u1"] }],
        [{ ...descriptor, evidence_entry_ids: [] }],
        [{ ...descriptor, evidence_entry_ids: ["u1"], id: "f0" }],
        [],
      ]) {
        const controlled = gatedModel();
        const run = analyzeConversation(controlled.model, fixture.loaded, conversationFacts(fixture.loaded));
        const outcome = run.catch((error: unknown) => error);
        const call = controlled.calls[0];
        call.response.resolve(JSON.stringify({ summary: "Malformed facets", facets }));
        expect(await outcome).toMatchObject({ code: "invalid_model_output" });
        expect(controlled.invalidated).toEqual([{ system: call.system, input: call.input }]);
      }
    } finally { await fixture.cleanup(); }
  });

  it("revalidates cached analysis numbering, shape and evidence against the current source", async () => {
    const fixture = await source();
    try {
      const valid: ConversationAnalysis = { summary: "WAL errors", facets: [
        { id: "f0", title: "Storage", description: "Durability", aliases: [], evidence_entry_ids: ["u1"] },
      ] };
      expect(validateConversationAnalysis(valid, fixture.loaded)).toEqual(valid);
      const badValues = [
        { ...valid, facets: [{ ...valid.facets[0], id: "f1" }] },
        { ...valid, facets: [{ ...valid.facets[0], evidence_entry_ids: ["missing"] }] },
        { ...valid, facets: [{ ...valid.facets[0], evidence_entry_ids: ["u1", "u1"] }] },
        { ...valid, facets: [{ ...valid.facets[0], evidence_entry_ids: [] }] },
        { ...valid, facets: [{ ...valid.facets[0], injected: true }] },
        { ...valid, summary: "x".repeat(1201) },
        { ...valid, facets: [] },
      ];
      for (const value of badValues) {
        expect(() => validateConversationAnalysis(value, fixture.loaded)).toThrow(expect.objectContaining({ code: "invalid_model_output" }));
      }
      const changed = { ...fixture.loaded, entries: fixture.loaded.entries.filter(entry => entry.id !== "u1") };
      expect(() => validateConversationAnalysis(valid, changed)).toThrow(expect.objectContaining({ code: "invalid_model_output" }));
    } finally { await fixture.cleanup(); }
  });

  it("invalidates reduce and final references absent from their immediate candidate evidence", async () => {
    const fixture = await source();
    try {
      const loaded = { ...fixture.loaded, entries: entries(18, "x".repeat(2400)) };
      for (const stage of ["analysis_reduce", "analysis_final"] as const) {
        const calls: { system: string; input: CallInput }[] = [];
        const invalidated: { system: string; input: unknown }[] = [];
        await expect(analyzeConversation({
          identity: stage, contextWindow: 10_000, maxOutputTokens: 1024,
          async generate(system, raw) {
            const input = raw as CallInput;
            calls.push({ system, input });
            if (input.stage === "analysis_map") {
              return JSON.stringify({ summary: stage === "analysis_reduce" ? "x".repeat(1800) : "Discarded evidence", facets: [] });
            }
            return JSON.stringify({ summary: "A source reference is not enough after evidence was discarded.", facets: [
              { title: "Storage", description: "Durability", aliases: [], evidence_entry_ids: [loaded.entries[0].id] },
            ] });
          },
          invalidateCachedResponse(system, input) { invalidated.push({ system, input }); },
        }, loaded, conversationFacts(loaded))).rejects.toMatchObject({ code: "invalid_model_output" });
        expect(invalidated.length).toBeGreaterThan(0);
        expect(invalidated).toEqual(calls.filter(call => call.input.stage === stage));
        expect(calls.every(call => call.input.stage === "analysis_map" || call.input.stage === stage)).toBe(true);
      }
    } finally { await fixture.cleanup(); }
  });

  it("rejects invalid concurrency before the empty-conversation shortcut", async () => {
    const fixture = await source();
    try {
      const loaded = { ...fixture.loaded, entries: [] };
      const controlled = gatedModel();
      for (const concurrency of [0, -1, 1.5, 33, NaN, Infinity]) {
        await expect(analyzeConversation(controlled.model, loaded, conversationFacts(loaded), { concurrency }))
          .rejects.toMatchObject({ code: "invalid_concurrency" });
      }
      expect(controlled.calls).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  it("keeps both concurrent layers ordered when their earliest request finishes last", async () => {
    const fixture = await source();
    try {
      const loaded = { ...fixture.loaded, entries: entries(18, "x".repeat(2400)) };
      const controlled = gatedModel();
      const run = analyzeConversation(controlled.model, loaded, conversationFacts(loaded));
      const released = new Set<number>();
      const lastId = loaded.entries.at(-1)!.id;
      const respond = (index: number) => {
        const input = controlled.calls[index].input as CallInput;
        const ids = input.entries ? input.entries.map(entry => entry.id).join(",")
          : input.segments!.map(segment => segment.summary.split("|")[0]).join(",");
        controlled.calls[index].response.resolve(JSON.stringify({
          summary: `${ids}|${input.entries ? "x".repeat(1800) : ""}`, facets: [responseFacet(input)],
        }));
        released.add(index);
      };
      expect(controlled.calls).toHaveLength(3);
      while (!(controlled.calls.at(-1)!.input as CallInput).entries!.some(entry => entry.id === lastId)) {
        const count = controlled.calls.length;
        respond(count - 1);
        await controlled.waitForCalls(count + 1);
      }
      const mapCount = controlled.calls.length;
      expect(controlled.calls.every(call => (call.input as CallInput).entries)).toBe(true);
      for (let index = mapCount - 1; index >= 0; index--) if (!released.has(index)) respond(index);
      await controlled.waitForCalls(mapCount + 3);
      expect(controlled.calls.slice(mapCount).every(call => (call.input as CallInput).stage === "analysis_reduce")).toBe(true);
      while (!(controlled.calls.at(-1)!.input as CallInput).segments!.some(segment => segment.summary.split("|")[0].split(",").includes(lastId))) {
        const count = controlled.calls.length;
        respond(count - 1);
        await controlled.waitForCalls(count + 1);
      }
      const reduceEnd = controlled.calls.length;
      expect(controlled.calls.every(call => (call.input as CallInput).stage !== "analysis_final")).toBe(true);
      for (let index = reduceEnd - 1; index >= mapCount; index--) if (!released.has(index)) respond(index);
      await controlled.waitForCalls(reduceEnd + 1);
      const final = controlled.calls[reduceEnd];
      const finalInput = final.input as CallInput;
      expect(finalInput.entry_count).toBe(loaded.entries.length);
      expect(finalInput.segments!.flatMap(segment => segment.summary.split("|")[0].split(",")))
        .toEqual(loaded.entries.map(entry => entry.id));
      final.response.resolve(JSON.stringify({ summary: "Ordered history", facets: [responseFacet(finalInput)] }));
      expect((await run).summary).toBe("Ordered history");
      expect(controlled.maximumActive).toBe(3);
      expect(controlled.active).toBe(0);
      expect(controlled.calls).toHaveLength(reduceEnd + 1);
    } finally { await fixture.cleanup(); }
  });

  it("evicts each invalid concurrent response without evicting a valid sibling or publishing final analysis", async () => {
    const fixture = await source();
    try {
      const loaded = { ...fixture.loaded, entries: entries(18, "x".repeat(2400)) };
      const controlled = gatedModel();
      const run = analyzeConversation(controlled.model, loaded, conversationFacts(loaded));
      const outcome = run.then(() => ({ error: undefined, active: controlled.active, invalidated: [...controlled.invalidated] }),
        (error: unknown) => ({ error, active: controlled.active, invalidated: [...controlled.invalidated] }));
      const [first, valid, invalid] = controlled.calls;
      first.response.resolve("not JSON");
      await controlled.waitForInvalidations(1);
      valid.response.resolve(JSON.stringify({ summary: "Valid cached summary", facets: [responseFacet(valid.input as CallInput)] }));
      await valid.response.promise;
      invalid.response.resolve(JSON.stringify({ summary: "References an entry from a different leaf", facets: [
        { ...responseFacet(invalid.input as CallInput), evidence_entry_ids: [(first.input as CallInput).entries![0].id] },
      ] }));
      expect(await outcome).toMatchObject({ error: { code: "invalid_model_output" }, active: 0, invalidated: [
        { system: first.system, input: first.input }, { system: invalid.system, input: invalid.input },
      ] });
      expect(controlled.invalidated.map(request => request.input)).toEqual([first.input, invalid.input]);
      expect(controlled.calls).toHaveLength(3);
    } finally { await fixture.cleanup(); }
  });

  it("drains ignored map cancellation without starting queued chunks or the final layer", async () => {
    const fixture = await source();
    try {
      const loaded = { ...fixture.loaded, entries: entries(18, "x".repeat(2400)) };
      const controlled = gatedModel();
      const controller = new AbortController();
      const reason = new Error("index cancelled");
      const run = analyzeConversation(controlled.model, loaded, conversationFacts(loaded), { signal: controller.signal, concurrency: 2 });
      let settled = false;
      const outcome = run.then(() => {
        settled = true;
        return { error: undefined, active: controlled.active };
      }, (error: unknown) => {
        settled = true;
        return { error, active: controlled.active };
      });
      expect(controlled.calls).toHaveLength(2);
      controller.abort(reason);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      for (const call of controlled.calls) {
        expect(call.signal).toBe(controller.signal);
        call.response.resolve(JSON.stringify({ summary: "Finished despite cancellation", facets: [responseFacet(call.input as CallInput)] }));
        await call.response.promise;
      }
      expect(await outcome).toEqual({ error: reason, active: 0 });
      expect(controlled.calls).toHaveLength(2);
      expect(controlled.invalidated).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  it("rejects a completed final response when its provider ignores cancellation", async () => {
    const fixture = await source();
    try {
      const controlled = gatedModel();
      const controller = new AbortController();
      const reason = new Error("final cancelled");
      const run = analyzeConversation(controlled.model, fixture.loaded, conversationFacts(fixture.loaded), { signal: controller.signal });
      const outcome = run.catch((error: unknown) => error);
      controller.abort(reason);
      controlled.calls[0].response.resolve(JSON.stringify({
        summary: "Must not publish", facets: [responseFacet(controlled.calls[0].input as CallInput)],
      }));
      expect(await outcome).toBe(reason);
      expect(controlled.active).toBe(0);
      expect(controlled.invalidated).toEqual([]);
    } finally { await fixture.cleanup(); }
  });

  it("merges a nine-entry tail, but not ten entries or an oversized final envelope", () => {
    const records = entries(30, "界".repeat(20));
    const sample: IndexedEntry = {
      id: records[0].id, parent_id: null, time: records[0].timestamp, role: "user", text: records[0].text,
    };
    const overheadBytes = requestBytes("policy", { title: "Timeline", entries: [] });
    const targetBytes = overheadBytes + 20 * Buffer.byteLength(JSON.stringify(sample), "utf8") + 19;
    const budget = { maximumBytes: targetBytes * 2, overheadBytes, finalOverheadBytes: overheadBytes };

    expect(planChunks(records.slice(0, 29), budget).map(chunk => chunk.length)).toEqual([29]);
    expect(planChunks(records, budget).map(chunk => chunk.length)).toEqual([20, 10]);
    expect(planChunks(records.slice(0, 29), { ...budget, finalOverheadBytes: targetBytes }).map(chunk => chunk.length))
      .toEqual([20, 9]);
  });

  it("preserves oversized Unicode text exactly with byte-bounded, contiguous fragments", () => {
    const text = "前😀\\\"\n\0".repeat(2000) + "THE_MIDDLE_MUST_SURVIVE" + "後🧭".repeat(2000);
    const records = entries(1, text);
    const system = "分类器";
    const metadata = { title: "日志\"\n", entries: [] };
    const maximumBytes = 2048;
    const overheadBytes = requestBytes(system, metadata);
    const chunks = planChunks(records, { maximumBytes, overheadBytes, finalOverheadBytes: overheadBytes });
    const fragments = chunks.flat();
    expect(fragments.map(fragment => fragment.text).join("")).toBe(text);
    let offset = 0;
    for (const fragment of fragments) {
      expect(fragment.text_offset).toBe(offset);
      expect(fragment.text_length).toBe(text.length);
      expect(fragment.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      offset += fragment.text.length;
    }
    for (let index = 0; index < chunks.length; index++) {
      const limit = index === chunks.length - 1 ? maximumBytes : maximumBytes / 2;
      expect(requestBytes(system, { ...metadata, entries: chunks[index] })).toBeLessThanOrEqual(limit);
    }
  });

  it("carries middle corrections through bounded hierarchical reduction without resubmitting source text", async () => {
    const fixture = await source();
    try {
      const correction = "The earlier success claim was wrong: WAL fsync returned EIO; durability remains unresolved.";
      const secret = `sk-${"a".repeat(24)}`;
      const loaded = { ...fixture.loaded, entries: entries(120, "Routine storage investigation. ".repeat(90)) };
      loaded.entries[60].text += correction;
      const submittedText: string[] = [];
      let intermediateReduce = false;
      let finalInput = "";
      const contextWindow = 8192;
      const maxOutputTokens = 1024;
      await analyzeConversation({
        identity: "fixture", contextWindow, maxOutputTokens,
        generate: async (system, input: unknown): Promise<string> => {
          expect(requestBytes(system, input)).toBeLessThanOrEqual(inputBudget(contextWindow, maxOutputTokens));
          expect(JSON.stringify(input)).not.toContain(fixture.root);
          const parsed = input as CallInput;
          const text = parsed.entries
            ? parsed.entries.map(entry => entry.text).join("") : parsed.segments!.map(segment => segment.summary).join("\n");
          if (parsed.entries) submittedText.push(...parsed.entries.map(entry => entry.text));
          else {
            expect(text).not.toContain(secret);
            if (parsed.stage === "analysis_reduce") intermediateReduce = true;
            else finalInput = text;
          }
          const summary = parsed.stage === "analysis_final" ? "Storage durability needs investigation."
            : (text.includes(correction) ? `${correction} ${parsed.entries ? secret : ""} ` : "")
              + "Other segment detail remains unresolved. ".repeat(38);
          return JSON.stringify({ summary, facets: [responseFacet(parsed)] });
        },
      }, loaded, conversationFacts(loaded));
      expect(submittedText.join("")).toBe(loaded.entries.map(entry => entry.text).join(""));
      expect(intermediateReduce).toBe(true);
      expect(finalInput).toContain(correction);
    } finally { await fixture.cleanup(); }
  });

  it("rejects a small advertised context instead of substituting a larger fallback", async () => {
    const fixture = await source();
    try {
      await expect(analyzeConversation({
        identity: "small", contextWindow: 512,
        generate: async () => { throw new Error("An impossible request must not reach the model."); },
      }, fixture.loaded, conversationFacts(fixture.loaded))).rejects.toMatchObject({ code: "model_context_too_small" });
    } finally { await fixture.cleanup(); }
  });

  it("stops reduction when the model cannot shrink individually fitting summaries", async () => {
    const fixture = await source();
    try {
      const loaded = { ...fixture.loaded, entries: entries(12, "x".repeat(3000)) };
      await expect(analyzeConversation({
        identity: "nonshrinking", contextWindow: 10_000, maxOutputTokens: 1024,
        generate: async (_system, input) => JSON.stringify({
          summary: "文".repeat(1900), facets: [responseFacet(input as CallInput)],
        }),
      }, loaded, conversationFacts(loaded))).rejects.toMatchObject({ code: "model_reduce_not_shrinking" });
    } finally { await fixture.cleanup(); }
  });

  it("uses a fixed rolling range and rejects ambiguous local timestamps", () => {
    expect(timeRange({ days: 2 }, Date.parse("2026-09-20T00:00:00Z")).from).toBe("2026-09-18T00:00:00.000Z");
    for (const value of ["yesterday", "2026-09-20T00:00:00", "2026-02-30T00:00:00Z"]) {
      expect(() => timeRange({ from: value })).toThrow();
    }
  });
});

describe("shared JSON generation", () => {
  it("applies the UTF-8 response cap and evicts only the offending request", async () => {
    const invalidated: unknown[] = [];
    const request = { stage: "large_response" };
    await expect(generateJson({
      identity: "large",
      generate: async () => JSON.stringify({ text: "界".repeat(30_000) }),
      invalidateCachedResponse: (system, input) => { invalidated.push({ system, input }); },
    }, "policy", request, z.object({ text: z.string() }).strict())).rejects.toMatchObject({ code: "invalid_model_output" });
    expect(invalidated).toEqual([{ system: "policy", input: request }]);
  });

  it("runs request-local reference validation inside exact-response invalidation", async () => {
    const controlled = gatedModel();
    const request = { allowed: ["t1"] };
    const schema = z.object({ id: z.string() }).strict().superRefine((value, context) => {
      if (!request.allowed.includes(value.id)) context.addIssue({ code: "custom", message: "Unknown topic" });
    });
    const run = generateJson(controlled.model, "policy", request, schema);
    const outcome = run.catch((error: unknown) => error);
    controlled.calls[0].response.resolve('{"id":"t2"}');
    expect(await outcome).toMatchObject({ code: "invalid_model_output" });
    expect(controlled.invalidated).toEqual([{ system: "policy", input: request }]);
  });

  it("trims descriptor fields, preserves 100-character aliases and redacts generated credentials", async () => {
    const token = `sk-${"a".repeat(24)}`;
    const result = await generateJson({ identity: "descriptor", generate: async () => JSON.stringify({
      title: " Storage ", description: `Durability ${token}`, aliases: [` ${"x".repeat(100)} `],
    }) }, "policy", {}, TopicDescriptorSchema);
    expect(result).toEqual({ title: "Storage", description: "Durability [REDACTED_TOKEN]", aliases: ["x".repeat(100)] });
  });

  it("rejects oversize request envelopes and already-cancelled requests before dispatch", async () => {
    const controlled = gatedModel();
    await expect(generateJson(controlled.model, "policy", { text: "界".repeat(4000) }, z.object({})))
      .rejects.toMatchObject({ code: "model_context_too_small" });
    const controller = new AbortController();
    const reason = new Error("cancelled before request");
    controller.abort(reason);
    await expect(generateJson(controlled.model, "policy", {}, z.object({}), controller.signal)).rejects.toBe(reason);
    expect(controlled.calls).toEqual([]);
    expect(controlled.invalidated).toEqual([]);
  });
});
