import { describe, expect, it } from "bun:test";
import { inputBudget, requestBytes } from "../src/chunking";
import type { ConversationAnalysis, JsonModel, TopicDescriptor } from "../src/semantic";
import { selectTopics, type ModelTopicCard, type TopicCard } from "../src/topics";

type SelectInput = { stage: "select_topic"; facet: TopicDescriptor; previous: ModelTopicCard[]; candidates: ModelTopicCard[] };

function profile(title = "Storage durability", description = "WAL synchronization failures and write acknowledgements"): TopicDescriptor {
  return { title, description, aliases: [] };
}

function card(id: string, createdAt: string | null = "2026-01-01T00:00:00.000Z"): TopicCard {
  return { id, ...profile(), createdAt };
}


function analysis(...titles: string[]): ConversationAnalysis {
  return {
    summary: "Conversation discusses separate semantic facets.",
    facets: titles.map((title, index) => ({ ...profile(title), id: `f${index}`, evidence_entry_ids: [`e${index}`] })),
  };
}


function fixtureModel(
  respond: (input: SelectInput, index: number) => unknown | Promise<unknown>,
  contextWindow = 32_768,
  maxOutputTokens = 1024,
) {
  const calls: { system: string; input: SelectInput }[] = [];
  const invalidated: SelectInput[] = [];
  let changed = Promise.withResolvers<void>();
  let active = 0;
  let peak = 0;
  const model: JsonModel = {
    identity: "local-topic-protocol-fixture", contextWindow, maxOutputTokens,
    async generate(system, value) {
      const input = value as SelectInput;
      const index = calls.length;
      calls.push({ system, input });
      active++;
      peak = Math.max(peak, active);
      const previous = changed;
      changed = Promise.withResolvers<void>();
      previous.resolve();
      try { return JSON.stringify(await respond(input, index)); }
      finally { active--; }
    },
    invalidateCachedResponse(_system, input) { invalidated.push(input as SelectInput); },
  };
  return {
    model, calls, invalidated,
    get peak() { return peak; },
    get active() { return active; },
    async waitForCalls(count: number) { while (calls.length < count) await changed.promise; },
  };
}

const unmatched = { topic_id: null, candidate_ids: [], reason: "No supplied definition covers this facet." };

describe("whole-catalog semantic selection", () => {
  it("compares all topics, including a semantic match beyond the fortieth card", async () => {
    const catalog = Array.from({ length: 64 }, (_, index) => ({ ...card(`t_${String(index).padStart(2, "0")}`), description: "Other semantic scope. ".repeat(12) }));
    const seen: string[] = [];
    const fixture = fixtureModel(input => {
      if (input.stage !== "select_topic") throw new Error("Unexpected stage");
      seen.push(...input.candidates.map(candidate => candidate.id));
      const found = [...input.previous, ...input.candidates].some(candidate => candidate.id === "t_47");
      return found ? { topic_id: "t_47", candidate_ids: ["t_47"], reason: "This definition covers the facet." } : unmatched;
    }, 5000, 512);
    const selected = await selectTopics(fixture.model, analysis("Durability"), [...catalog].reverse());
    expect(seen).toEqual(catalog.map(item => item.id));
    expect(selected.assignments[0].topicRef).toBe("t_47");
    expect(selected.newTopics).toEqual([]);
    for (const call of fixture.calls) expect(requestBytes(call.system, call.input)).toBeLessThanOrEqual(inputBudget(5000, 512));
  });

  it("keeps same-title topics distinct and creates separate unmatched drafts without title deduplication", async () => {
    const first = { ...card("t_first"), title: "Reliability", description: "UI accessibility and visual consistency" };
    const second = { ...card("t_second"), title: "Reliability", description: "Storage synchronization guarantees" };
    const fixture = fixtureModel(input => {
      if (input.stage !== "select_topic") throw new Error("Unexpected stage");
      expect(input.candidates.map(candidate => candidate.id)).toEqual(["t_first", "t_second"]);
      return { topic_id: "t_second", candidate_ids: ["t_second"], reason: "Storage, not UI." };
    });
    expect((await selectTopics(fixture.model, analysis("Reliability"), [first, second])).assignments[0].topicRef).toBe("t_second");
    const unmatchedModel = fixtureModel(() => unmatched);
    const selected = await selectTopics(unmatchedModel.model, analysis("Reliability", "Reliability"), [first, second]);
    expect(selected.assignments.map(item => item.topicRef)).toEqual(["new:f0", "new:f1"]);
    expect(selected.newTopics.map(item => item.ref)).toEqual(["new:f0", "new:f1"]);
  });

  it("does not make empty-catalog or empty-analysis model requests", async () => {
    const fixture = fixtureModel(() => { throw new Error("No model request is allowed"); });
    expect((await selectTopics(fixture.model, analysis("Storage", "UI"), [])).newTopics.map(item => item.ref)).toEqual(["new:f0", "new:f1"]);
    expect(await selectTopics(fixture.model, analysis(), [card("t_a")])).toEqual({ assignments: [], newTopics: [], neighborIds: [] });
    expect(fixture.calls).toEqual([]);
  });

  it("ranks neighbors by facet support then rank, excluding every assigned topic", async () => {
    const candidates = [["a", "n1", "n2"], ["a", "n1", "n3"], ["a", "n2", "n3"], ["a", "n3", "n4"]];
    const fixture = fixtureModel((_input, index) => ({ topic_id: "a", candidate_ids: candidates[index], reason: "Chosen scope and nearby alternatives." }));
    const result = await selectTopics(fixture.model, analysis("one", "two", "three", "four"), ["a", "n1", "n2", "n3", "n4"].map(id => card(id)));
    expect(result.neighborIds).toEqual(["n3", "n1"]);
  });

  it("breaks neighbor ties by creation time and ID, with drafts last", async () => {
    const fixture = fixtureModel((_input, index) => ({ topic_id: null, candidate_ids: index ? ["a", "b", "c"] : ["b", "a", "c"], reason: "Related, but no exact fit." }));
    const selected = await selectTopics(fixture.model, analysis("one", "two"), [card("b"), card("c", null), card("a")]);
    expect(selected.neighborIds).toEqual(["a", "b"]);
  });

  it.each([
    { topic_id: "foreign", candidate_ids: ["foreign"], reason: "Invented ID" },
    { topic_id: "t_a", candidate_ids: [], reason: "Chosen ID omitted" },
    { topic_id: "t_a", candidate_ids: ["t_a", "t_a"], reason: "Duplicate references" },
    { topic_id: null, candidate_ids: [], reason: " ", extra: true },
  ])("invalidates a malformed selection response rather than publishing it: %j", async response => {
    const fixture = fixtureModel(() => response);
    await expect(selectTopics(fixture.model, analysis("Storage"), [card("t_a")])).rejects.toMatchObject({ code: "invalid_model_output" });
    expect(fixture.invalidated).toEqual([fixture.calls[0].input]);
  });

  it("accepts the exact byte boundary and refuses truncating a card one byte over it", async () => {
    const catalog = [{ ...card("t_a"), description: "界".repeat(400) }];
    const probe = fixtureModel(() => unmatched);
    await selectTopics(probe.model, analysis("Storage"), catalog);
    const bytes = requestBytes(probe.calls[0].system, probe.calls[0].input);
    const exact = fixtureModel(() => unmatched, bytes + 512 + 256, 512);
    expect((await selectTopics(exact.model, analysis("Storage"), catalog)).assignments[0].topicRef).toBe("new:f0");
    const tooSmall = fixtureModel(() => unmatched, bytes + 512 + 255, 512);
    await expect(selectTopics(tooSmall.model, analysis("Storage"), catalog)).rejects.toMatchObject({ code: "model_context_too_small" });
    expect(tooSmall.calls).toEqual([]);
  });

  it("processes selection requests strictly one at a time across catalog pages", async () => {
    const fixture = fixtureModel((input) => {
      if (input.stage !== "select_topic") throw new Error("Unexpected stage");
      const id = input.facet.title === "one" ? "t_00" : "t_01";
      return [...input.previous, ...input.candidates].some(candidate => candidate.id === id)
        ? { topic_id: id, candidate_ids: [id], reason: "Correct independent facet." } : unmatched;
    }, 5000, 512);
    const catalog = Array.from({ length: 32 }, (_, index) => ({ ...card(`t_${String(index).padStart(2, "0")}`), description: "x".repeat(450) }));
    const result = await selectTopics(fixture.model, analysis("one", "two"), catalog);
    expect(result.assignments.map(item => item.topicRef)).toEqual(["t_00", "t_01"]);
    expect(fixture.peak).toBe(1);
    expect(fixture.active).toBe(0);
  });

  it("stops at the first invalid selection response without further requests", async () => {
    const fixture = fixtureModel(() => ({ topic_id: "foreign", candidate_ids: ["foreign"], reason: "Invalid reference." }), 5000, 512);
    const catalog = Array.from({ length: 32 }, (_, index) => ({ ...card(`t_${index}`), description: "x".repeat(450) }));
    await expect(selectTopics(fixture.model, analysis("one", "two", "three"), catalog)).rejects.toMatchObject({ code: "invalid_model_output" });
    expect(fixture.active).toBe(0);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.invalidated).toEqual([fixture.calls[0].input]);
  });
});

