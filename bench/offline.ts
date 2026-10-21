import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { HistoryStore } from "../src/store";
import type { RecallScope, SourceAccess } from "../src/scope";

const { values } = parseArgs({ options: {
  conversations: { type: "string", default: "512" },
  out: { type: "string", default: "artifacts/offline/results.json" },
}, strict: true });
const count = Number(values.conversations);
if (!Number.isSafeInteger(count) || count < 1 || count > 2000) throw new Error("--conversations must be from 1 to 2000.");

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "history-offline-")));
const sessionsRoot = path.join(root, "agent", "sessions");
const scope: RecallScope = {
  id: "scope_offline", agentDir: path.join(root, "agent"),
  sessionsRoot, customFilesRoot: path.join(root, "agent", "custom-session-files"),
};
const access: SourceAccess = { sessionDir: sessionsRoot, activeSessionId: "offline-active" };
const store = new HistoryStore(path.join(root, "index.db"), scope, access);

function percentile(values: number[], p: number) {
  return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
}

try {
  for (let index = 0; index < count; index++) {
    const timestamp = new Date(Date.UTC(2026, 8, 1 + index % 20)).toISOString();
    const bucket = path.join(sessionsRoot, `bucket-${index % 8}`);
    await fs.mkdir(bucket, { recursive: true });
    const records: unknown[] = [{ type: "session", version: 3, id: `session-${index}`, cwd: root, timestamp, title: `Corpus ${index}` }];
    let parent: string | null = null;
    for (let slot = 0; slot < 8; slot++) {
      const user = `u${index}_${slot}`, assistant = `a${index}_${slot}`;
      records.push({ type: "message", id: user, parentId: parent, timestamp, message: { role: "user", content: `evidence${index}slot${slot} durable writes and replay correctness 存储恢复` } });
      records.push({ type: "message", id: assistant, parentId: user, timestamp, message: { role: "assistant", content: "Outcome unresolved; read the original." } });
      parent = assistant;
    }
    await fs.writeFile(path.join(bucket, `${String(index).padStart(6, "0")}.jsonl`),
      records.map(record => JSON.stringify(record)).join("\n") + "\n");
  }
  const coldStart = performance.now();
  const cold = await store.sync({ maxFiles: count, maxBytes: 1_073_741_824 });
  const coldMs = performance.now() - coldStart;
  if (cold.failed || cold.ingested !== count) {
    throw new Error(`Incomplete corpus ingestion: ${JSON.stringify(cold)}`);
  }
  const warmStart = performance.now();
  const warm = await store.sync({ maxFiles: count, maxBytes: 1_073_741_824 });
  const warmMs = performance.now() - warmStart;
  if (warm.ingested !== 0 || warm.pending !== 0) throw new Error("Unchanged corpus was re-ingested.");
  const catalogStart = performance.now();
  const catalog = await store.catalog({ limit: 50 });
  const catalogMs = performance.now() - catalogStart;
  if (catalog.conversations.length !== 50) throw new Error("Catalog pagination lost entries.");
  const searchMs: number[] = [];
  for (let index = 0; index < Math.min(count, 100); index++) {
    const selected = (index * 31) % count;
    const start = performance.now();
    const result = await store.search([`evidence${selected}slot3`]);
    searchMs.push(performance.now() - start);
    if (result.conversations.length !== 1 || result.conversations[0].session_id !== `session-${selected}`) {
      throw new Error("Wrong search result.");
    }
  }
  const status = await store.status();
  if (status.conversations !== count) throw new Error(`Indexed ${status.conversations}/${count} conversations.`);

  const liveDir = path.join(sessionsRoot, "live");
  await fs.mkdir(liveDir, { recursive: true });
  const liveFile = path.join(liveDir, "current.jsonl");
  const liveTimestamp = new Date(Date.UTC(2026, 9, 21, 0, 0, 0)).toISOString();
  const liveLines = [JSON.stringify({ type: "session", version: 3, id: "offline-active", cwd: root, timestamp: liveTimestamp, title: "Live benchmark" })];
  for (let index = 0; index < 2500; index++) {
    liveLines.push(JSON.stringify({
      type: "message", id: `live${index}`, parentId: index ? `live${index - 1}` : null, timestamp: liveTimestamp,
      message: { role: index % 2 === 0 ? "user" : "assistant", content: `liveprobe ${index} ${"x".repeat(12_000)}` },
    }));
  }
  await fs.writeFile(liveFile, `${liveLines.join("\n")}\n`);
  const liveBytes = (await fs.stat(liveFile)).size;
  store.setSourceAccess({ activeSessionId: "offline-active", activeFile: liveFile, sessionDir: liveDir });
  const firstStart = performance.now();
  const first = await store.search(["liveprobe"], { session_id: "offline-active", limit: 1 });
  const firstMs = performance.now() - firstStart;
  if (first.strategy !== "index" || !first.matches?.length) throw new Error("Live index was not used.");
  const noopStart = performance.now();
  await store.search(["liveprobe"], { session_id: "offline-active", limit: 1 });
  const noopMs = performance.now() - noopStart;
  await fs.appendFile(liveFile, JSON.stringify({
    type: "message", id: "live-appended", parentId: "live2499", timestamp: liveTimestamp,
    message: { role: "user", content: "appendedtoken after the index boundary" },
  }) + "\n");
  const appendStart = performance.now();
  const appended = await store.search(["appendedtoken"], { session_id: "offline-active", limit: 1 });
  const appendMs = performance.now() - appendStart;
  if (appended.matches?.[0]?.entry_id !== "live-appended") throw new Error("Appended live entry was not indexed.");

  const metrics = {
    kind: "offline-fts-session-index-benchmark", model_calls: 0,
    conversations: count, indexed_entries: status.indexed_entries,
    cold_ingest_ms: coldMs, warm_ingest_ms: warmMs, catalog_ms: catalogMs,
    search_ms: { p50: percentile(searchMs, .5), p95: percentile(searchMs, .95) },
    live_index: {
      file_bytes: liveBytes, entries: 2500,
      first_index_ms: firstMs, noop_ms: noopMs, append_ms: appendMs,
    },
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
