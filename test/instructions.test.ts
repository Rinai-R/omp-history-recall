import { expect, it } from "bun:test";
import historyRecallExtension, { appendSystemInstruction } from "../src/index";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

it("completely disables the extension before registering hooks or tools", () => {
  const saved = process.env.OMP_HISTORY_RECALL_DISABLED;
  process.env.OMP_HISTORY_RECALL_DISABLED = "1";
  try { expect(() => historyRecallExtension({} as ExtensionAPI)).not.toThrow(); }
  finally {
    if (saved === undefined) delete process.env.OMP_HISTORY_RECALL_DISABLED;
    else process.env.OMP_HISTORY_RECALL_DISABLED = saved;
  }
});

it("appends one static capability instruction without embedding project topics", () => {
  const base = ["Base policy"];
  const once = appendSystemInstruction(base);
  expect(once).toHaveLength(2);
  expect(once[1]).toContain("history_recall_browse");
  expect(once[1]).toContain("Summaries and topic descriptions are not evidence");
  expect(once[1]).not.toContain("Storage durability");
  expect(appendSystemInstruction(once)).toEqual(once);
  expect(base).toEqual(["Base policy"]);
});
