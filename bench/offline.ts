import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { HistoryStore } from "../src/store";
import type { JsonModel } from "../src/semantic";

const { values } = parseArgs({ options: {
  conversations: { type: "string", default: "512" },
  out: { type: "string", default: "artifacts/offline/results.json" },
}, strict: true });
const count = Number(values.conversations);
if (!Number.isSafeInteger(count) || count < 1 || count > 2000) throw new Error("--conversations must be from 1 to 2000.");

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "history-offline-")));
const directory = path.join(root, "sessions");
await fs.mkdir(directory);
const model: JsonModel = { identity: "offline-fixture/no-model", async generate() {
  return JSON.stringify({
    summary: "Controlled storage fixture for offline performance measurement.",
    topics: [{ title: "Corpus storage", description: "Controlled durability and retrieval fixture.", aliases: ["存储", "retrieval"] }],
  });
} };
const store = new HistoryStore(path.join(root, "index.db"), root);

function percentile(values: number[], p: number) {
  return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
}

try {
  for (let i = 0; i < count; i++) {
    const timestamp = new Date(Date.UTC(2026, 8, 1 + i % 20)).toISOString();
    const records: unknown[] = [{ type: "session", version: 3, id: `session-${i}`, cwd: root, timestamp, title: `Corpus ${i}` }];
    let parent: string | null = null;
    for (let j = 0; j < 8; j++) {
      const user = `u${i}_${j}`, assistant = `a${i}_${j}`;
      records.push({ type: "message", id: user, parentId: parent, timestamp, message: { role: "user", content: `evidence${i}slot${j} durable writes and replay correctness 存储恢复` } });
      records.push({ type: "message", id: assistant, parentId: user, timestamp, message: { role: "assistant", content: "Outcome unresolved; read the original." } });
      parent = assistant;
    }
    await fs.writeFile(path.join(directory, `${String(i).padStart(6, "0")}.jsonl`), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  }
  const coldStart = performance.now();
  await store.discover(directory, { force: true });
  const indexed = await store.work(model, { maxJobs: count, maxCalls: count, maxDailyCalls: 10_000 });
  const coldMs = performance.now() - coldStart;
  if (indexed.failed || indexed.completed !== count || store.status().conversations !== count) throw new Error("Incomplete corpus indexing.");
  const warmStart = performance.now();
  const catalog = await store.catalog(directory);
  const catalogMs = performance.now() - warmStart;
  if (catalog.conversations.length !== count || !catalog.conversations.every((conversation: any) => conversation.indexed)) throw new Error("Catalog lost indexed conversations.");
  const searchMs: number[] = [];
  for (let i = 0; i < Math.min(count, 100); i++) {
    const index = (i * 31) % count;
    const start = performance.now();
    const result = await store.search([`evidence${index}slot3`, "durable writes"]);
    searchMs.push(performance.now() - start);
    if (result.conversations.length !== 1 || result.conversations[0].session_id !== `session-${index}`) throw new Error("Wrong search result.");
  }
  const metrics = {
    kind: "offline-conversation-index-benchmark", semantic_quality_evaluated: false,
    actual_model_calls: 0, conversations: count, topics: store.status().topics,
    indexed_entries: store.status().indexed_entries, cold_index_ms: coldMs,
    catalog_ms: catalogMs, search_ms: { p50: percentile(searchMs, .5), p95: percentile(searchMs, .95) },
    db_bytes: (await fs.stat(store.dbPath)).size, bun: Bun.version, timestamp: new Date().toISOString(),
  };
  const out = path.resolve(values.out!);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
} finally {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
}
