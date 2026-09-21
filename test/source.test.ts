import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { digest, evidencePage, loadSource, redact, redactJson } from "../src/source";

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
    const { root, file } = await fixture([message("u", null, "Question 界🙂"), message("t", "u", "unique-tool-error", "toolResult")], { titleSlot: true });
    const source = await loadSource(file);
    const stat = await fs.stat(file);
    expect(source.cwd).toBe(await fs.realpath(root));
    expect(source.sizeBytes).toBe(stat.size);
    expect(source.stamp).toBe(`${stat.mtimeMs}:${stat.size}`);
    expect(source.title).toBe("Physical title");
    expect(source.entries[1].role).toBe("toolResult");
    expect(source.entries[1].text).toBe("unique-tool-error");
    expect(source.entries[0].line).toBe(3);
    expect(source.fingerprint).toBe(digest(await fs.readFile(file, "utf8")));
  });

  it("rejects evidence ranges spanning sibling branches", async () => {
    const { file } = await fixture([
      message("u", null, "shared"), message("a", "u", "branch A"),
      message("b", "u", "branch B"), message("b2", "b", "B continues"),
      message("root2", null, "reset"),
    ]);
    const source = await loadSource(file);
    const refs = source.entries.filter(entry => ["a", "b"].includes(entry.id));
    expect(() => evidencePage("scope_a", source, refs)).toThrow(expect.objectContaining({ code: "invalid_ancestry" }));
  });

  it("pages every character of large originals without invalid JSON envelopes", async () => {
    const { file } = await fixture([message("u", null, "a".repeat(5500)), message("a", "u", "answer", "assistant")]);
    const source = await loadSource(file);
    const texts = new Map<string, string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = JSON.parse(JSON.stringify(evidencePage("scope_a", source, source.entries, { cursor, maxChars: 1000 })));
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
    const first = evidencePage("scope_a", original, original.entries, { maxChars: 1000 });
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("long", "edit"));
    const edited = await loadSource(file);
    expect(() => evidencePage("scope_a", edited, original.entries)).toThrow(expect.objectContaining({ code: "stale_evidence" }));
    expect(() => evidencePage("scope_a", edited, edited.entries, { cursor: first.next_cursor! }))
      .toThrow(expect.objectContaining({ code: "invalid_cursor" }));
  });

  it("fails closed for corrupt tails, symlinks, and invalid ancestry", async () => {
    const torn = await fixture([message("u", null, "ok")], { tail: '{"type":' });
    await expect(loadSource(torn.file)).rejects.toMatchObject({ code: "invalid_source" });
    const good = await fixture([message("u", null, "ok")]);
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
    expect(evidencePage("scope_a", source, source.entries).fragments[0].text).not.toContain(fake);
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

  it("binds evidence to scope, session and references rather than source metadata", async () => {
    const { file } = await fixture([message("u", null, "original".repeat(1000))]);
    const source = await loadSource(file);
    const refs = source.entries.map(({ id, hash }) => ({ id, hash }));
    const first = evidencePage("scope_a", source, refs, { maxChars: 1000 });
    const relocated = { ...source, cwd: "/another/cwd", file: "/moved/session.jsonl", title: "Renamed" };
    expect(evidencePage("scope_a", relocated, source.entries).evidence_id).toBe(first.evidence_id);
    expect(evidencePage("scope_a", relocated, refs, { cursor: first.next_cursor! }).fragments)
      .toEqual(evidencePage("scope_a", source, refs, { cursor: first.next_cursor! }).fragments);
    expect(evidencePage("scope_b", source, refs).evidence_id).not.toBe(first.evidence_id);
    expect(evidencePage("scope_a", { ...source, sessionId: "another-session" }, refs).evidence_id).not.toBe(first.evidence_id);
    expect(() => evidencePage("scope_b", source, refs, { cursor: first.next_cursor! }))
      .toThrow(expect.objectContaining({ code: "invalid_cursor" }));
  });

  it("returns an empty evidence chain only when no cursor is supplied", async () => {
    const { file } = await fixture([]);
    const source = await loadSource(file);
    const page = evidencePage("scope_a", source, []);
    expect(page).toMatchObject({ fragments: [], next_cursor: null });
    expect(() => evidencePage("scope_a", source, [], { cursor: "" }))
      .toThrow(expect.objectContaining({ code: "invalid_cursor" }));
    const cursor = Buffer.from(JSON.stringify({ e: page.evidence_id, i: 0, o: 0 })).toString("base64url");
    expect(() => evidencePage("scope_a", source, [], { cursor }))
      .toThrow(expect.objectContaining({ code: "invalid_cursor" }));
  });

});
