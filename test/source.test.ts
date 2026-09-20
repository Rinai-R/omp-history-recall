import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { evidencePage, loadSource, redact, redactJson, sourceChunks } from "../src/source";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

export function message(id: string, parentId: string | null, text: string, role = "user") {
  return { type: "message", id, parentId, timestamp: "2026-09-20T00:00:00Z", message: { role, content: text } };
}

async function fixture(entries: unknown[], options: { titleSlot?: boolean; tail?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recall-source-"));
  roots.push(root);
  const file = path.join(root, "history.jsonl");
  const header = { type: "session", version: 3, id: "s1", cwd: root, timestamp: "2026-09-19T00:00:00Z", title: "Old title" };
  const records = options.titleSlot ? [{ type: "title", title: "Physical title" }, header, ...entries] : [header, ...entries];
  await fs.writeFile(file, `${records.map(value => JSON.stringify(value)).join("\n")}\n${options.tail ?? ""}`);
  return { root, file };
}

describe("source evidence", () => {
  it("reads OMP title slots, canonical identity and tool text", async () => {
    const { root, file } = await fixture([message("u", null, "Question"), message("t", "u", "unique-tool-error", "toolResult")], { titleSlot: true });
    const source = await loadSource(file, { project: root });
    expect(source.title).toBe("Physical title");
    expect(source.entries[1].role).toBe("toolResult");
    expect(source.entries[1].text).toBe("unique-tool-error");
    expect(source.entries[0].line).toBe(3);
    expect(source.fingerprint).toHaveLength(64);
  });

  it("partitions forks into disjoint branch-correct chains", async () => {
    const { file } = await fixture([
      message("u", null, "shared"), message("a", "u", "branch A"),
      message("b", "u", "branch B"), message("b2", "b", "B continues"),
      message("root2", null, "reset"),
    ]);
    const source = await loadSource(file);
    expect(sourceChunks(source).map(chunk => chunk.entries.map(entry => entry.id)))
      .toEqual([["u"], ["a"], ["b", "b2"], ["root2"]]);
    const refs = source.entries.filter(entry => ["a", "b"].includes(entry.id));
    expect(() => evidencePage(source, refs)).toThrow("crosses branches");
  });

  it("pages every character of large originals without invalid JSON envelopes", async () => {
    const { file } = await fixture([message("u", null, "a".repeat(5500)), message("a", "u", "answer", "assistant")]);
    const source = await loadSource(file);
    const texts = new Map<string, string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = JSON.parse(JSON.stringify(evidencePage(source, source.entries, { cursor, maxChars: 1000 })));
      for (const fragment of page.fragments) {
        expect(fragment.offset).toBe((texts.get(fragment.entry_id) ?? "").length);
        texts.set(fragment.entry_id, (texts.get(fragment.entry_id) ?? "") + fragment.text);
      }
      cursor = page.next_cursor ?? undefined;
      expect(++pages).toBeLessThan(20);
    } while (cursor);
    for (const entry of source.entries) expect(texts.get(entry.id)).toBe(entry.raw);
    expect(pages).toBeGreaterThan(5);
  });

  it("rejects stale evidence and cursors from another revision", async () => {
    const { file } = await fixture([message("u", null, "long".repeat(1000))]);
    const original = await loadSource(file);
    const first = evidencePage(original, original.entries, { maxChars: 1000 });
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("long", "edit"));
    const edited = await loadSource(file);
    expect(() => evidencePage(edited, original.entries)).toThrow("changed or disappeared");
    expect(() => evidencePage(edited, edited.entries, { cursor: first.next_cursor! })).toThrow("revision");
  });

  it("fails closed for corrupt tails, foreign projects, symlinks, and invalid ancestry", async () => {
    const torn = await fixture([message("u", null, "ok")], { tail: '{"type":' });
    await expect(loadSource(torn.file)).rejects.toMatchObject({ code: "invalid_source" });
    const good = await fixture([message("u", null, "ok")]);
    await expect(loadSource(good.file, { project: torn.root })).rejects.toMatchObject({ code: "wrong_project" });
    const link = path.join(good.root, "link.jsonl");
    await fs.symlink(good.file, link);
    await expect(loadSource(link)).rejects.toMatchObject({ code: "invalid_source" });
    const bad = await fixture([message("u", "missing", "oops")]);
    await expect(loadSource(bad.file)).rejects.toMatchObject({ code: "invalid_ancestry" });
  });

  it("enforces byte and cancellation budgets", async () => {
    const { file } = await fixture([message("u", null, "oversized")]);
    await expect(loadSource(file, { maxBytes: 10 })).rejects.toMatchObject({ code: "source_too_large" });
    await expect(loadSource(file, { signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it("redacts credentials without changing the original source", async () => {
    const fake = `glpat-${"x".repeat(20)}`;
    const { file } = await fixture([message("u", null, `api_key=abcdefghijklmnop ${fake}`)]);
    const source = await loadSource(file);
    expect(source.entries[0].text).not.toContain(fake);
    expect(evidencePage(source, source.entries).fragments[0].text).not.toContain(fake);
    expect(await fs.readFile(file, "utf8")).toContain(fake);
    expect(redact("Bearer abcdefghijklmnop")).toContain("REDACTED");
  });

  it("redacts structured credentials without corrupting JSON escapes", () => {
    const encoded = JSON.stringify({ password: 'abcdefghijk"suffix', message: { content: 'api_key="abcdefghijk\\\"suffix"' } });
    const decoded = JSON.parse(redactJson(encoded));
    expect(decoded.password).toBe("[REDACTED_SECRET]");
    expect(decoded.message.content).toContain("REDACTED");
    expect(redactJson('{ "plain": "unchanged" }')).toBe('{ "plain": "unchanged" }');
  });

  it("covers every entry exactly once across many forks and chunk boundaries", async () => {
    const entries = Array.from({ length: 160 }, (_, i) => message(`e${i}`, i ? `e${Math.floor((i - 1) / 2)}` : null, "x".repeat(400)));
    const { file } = await fixture(entries);
    const source = await loadSource(file);
    const chunks = sourceChunks(source, 1100);
    const ids = chunks.flatMap(chunk => chunk.entries.map(entry => entry.id));
    expect(ids.length).toBe(160);
    expect(new Set(ids).size).toBe(160);
    for (const chunk of chunks) {
      for (let i = 1; i < chunk.entries.length; i++) expect(chunk.entries[i].parentId).toBe(chunk.entries[i - 1].id);
    }
  });

  it("preserves ancestry and exact coverage across deterministic randomized trees", async () => {
    let seed = 0x12345678;
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    for (let trial = 0; trial < 12; trial++) {
      const entries = Array.from({ length: 60 }, (_, i) => message(`r${i}`, i && next() % 7 ? `r${next() % i}` : null, "x".repeat(next() % 1500)));
      const { file } = await fixture(entries);
      const source = await loadSource(file);
      const chunks = sourceChunks(source, 2000);
      expect(chunks.flatMap(chunk => chunk.entries.map(entry => entry.id)).sort()).toEqual(entries.map(entry => entry.id).sort());
      for (const chunk of chunks) for (let i = 1; i < chunk.entries.length; i++) expect(chunk.entries[i].parentId).toBe(chunk.entries[i - 1].id);
    }
  });
});
