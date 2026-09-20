import { describe, expect, it } from "bun:test";
import { conversationFacts, indexConversation, rewriteQuery } from "../src/semantic";
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

  it("uses a fixed rolling range and rejects ambiguous local timestamps", () => {
    expect(timeRange({ days: 2 }, Date.parse("2026-09-20T00:00:00Z")).from).toBe("2026-09-18T00:00:00.000Z");
    for (const value of ["yesterday", "2026-09-20T00:00:00", "2026-02-30T00:00:00Z"]) {
      expect(() => timeRange({ from: value })).toThrow();
    }
  });
});
