import { describe, expect, it } from "bun:test";
import { conversationFacts, indexConversation, planChunks, rewriteQuery, type TopicVocabulary } from "../src/semantic";
import { loadSource } from "../src/source";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { timeRange } from "../src/time";

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

  it("rejects malformed index and rewrite model output", async () => {
    const fixture = await source();
    try {
      const facts = conversationFacts(fixture.loaded);
      await expect(indexConversation({ identity: "bad", generate: async () => "not json" }, fixture.loaded, facts))
        .rejects.toMatchObject({ code: "invalid_model_output" });
      await expect(rewriteQuery({ identity: "bad", generate: async () => '{"queries":[]}' }, ["query"]))
        .rejects.toMatchObject({ code: "invalid_model_output" });
    } finally { await fixture.cleanup(); }
  });

  it("plans chunks by byte budget and merges a short tail", () => {
    const entries = (count: number, bytes: number) => Array.from({ length: count }, (_, index) => ({
      id: `e${index}`, parentId: null, timestamp: "2026-09-20T01:00:00Z", type: "message", role: "user",
      text: "x".repeat(bytes), line: index, hash: `h${index}`, raw: "",
    }));
    // Small context: usable budget = (32768*0.5 - 4096) * 3 = ~36,864 bytes; each
    // entry ~1,024 bytes of text -> chunk boundaries form well before 40 entries.
    const many = planChunks(entries(80, 1000), 32_768);
    expect(many.length).toBeGreaterThan(1);
    expect(many.flatMap(chunk => chunk.entries)).toHaveLength(80);
    for (const chunk of many.slice(0, -1)) expect(chunk.bytes).toBeGreaterThan(0);

    // A tail with fewer than 10 entries is folded into the previous chunk when
    // the combination stays within the full window budget.
    const shortTail = entries(43, 1000);
    const planned = planChunks(shortTail, 32_768);
    const last = planned.at(-1)!;
    if (planned.length === 1) {
      expect(last.entries).toHaveLength(43);
    } else {
      expect(last.entries.length).toBeGreaterThanOrEqual(10);
    }
  });

  it("keeps a single chunk within budget for oversized single entries", () => {
    const oversized = [{
      id: "e0", parentId: null, timestamp: "2026-09-20T01:00:00Z", type: "message", role: "user",
      text: "y".repeat(50_000), line: 0, hash: "h0", raw: "",
    }];
    const planned = planChunks(oversized, 32_768);
    expect(planned).toHaveLength(1);
    // Entry text is truncated to head 2000 + omission marker + tail 1000.
    expect(planned[0].entries[0].text).toContain("[PREVIEW OMITTED MIDDLE]");
    expect(planned[0].entries[0].text.length).toBeLessThanOrEqual(3030);
  });

  it("runs map then reduce over chunk summaries for long conversations", async () => {
    const fixture = await source();
    try {
      const longFile = path.join(fixture.root, "long.jsonl");
      const records = [
        { type: "session", version: 3, id: "long", cwd: fixture.root, timestamp: "2026-09-20T01:00:00Z", title: "Long" },
        ...Array.from({ length: 100 }, (_, index) => ({
          type: "message", id: `m${index}`, parentId: index === 0 ? null : `m${index - 1}`,
          timestamp: "2026-09-20T01:00:00Z",
          message: { role: index % 2 ? "assistant" : "user", content: `Topic ${index % 5} discussion with unique token tok${index}. ` + "detail ".repeat(160) },
        })),
      ];
      await fs.writeFile(longFile, records.map(record => JSON.stringify(record)).join("\n") + "\n");
      const loaded = await loadSource(longFile);
      const facts = conversationFacts(loaded);
      type CallInput = { entries?: { id: string }[]; segments?: { summary: string }[] };
      const calls: { input: CallInput }[] = [];
      const vocabulary: TopicVocabulary = { topics: [{ id: "t1", title: "Storage durability", description: "WAL", aliases: ["WAL"] }] };
      const result = await indexConversation({
        identity: "fixture",
        contextWindow: 32_768,
        generate: async (_system, input: unknown): Promise<string> => {
          calls.push({ input: input as CallInput });
          const parsed = input as CallInput;
          if (parsed.segments) {
            return JSON.stringify({
              summary: "Merged summary across segments.",
              topics: [{ title: "Storage durability", description: "WAL persistence.", aliases: ["持久化"] }],
            });
          }
          return JSON.stringify({
            summary: `Segment covering ${parsed.entries?.length ?? 0} entries.`,
            topics: [{ title: "Storage durability", description: "WAL persistence.", aliases: ["WAL"] }],
          });
        },
      }, loaded, facts, { vocabulary });
      expect(result.summary).toBe("Merged summary across segments.");
      expect(calls.length).toBeGreaterThan(2); // map calls + one reduce call
      const reduceInput = calls.at(-1)!.input;
      expect(reduceInput.segments!.length).toBe(calls.length - 1);
      // Chunk prompts must never receive the full conversation at once.
      for (const call of calls.slice(0, -1)) expect(call.input.entries!.length).toBeLessThan(100);
    } finally { await fixture.cleanup(); }
  });

  it("uses a fixed rolling range and rejects ambiguous local timestamps", () => {
    expect(timeRange({ days: 2 }, Date.parse("2026-09-20T00:00:00Z")).from).toBe("2026-09-18T00:00:00.000Z");
    for (const value of ["yesterday", "2026-09-20T00:00:00", "2026-02-30T00:00:00Z"]) {
      expect(() => timeRange({ from: value })).toThrow();
    }
  });
});
