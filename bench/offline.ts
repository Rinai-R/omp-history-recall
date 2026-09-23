import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { createRuntimeFixture } from "../test/runtime-fixture";

const { values } = parseArgs({ options: {
  conversations: { type: "string", default: "512" },
  out: { type: "string", default: "artifacts/offline/results.json" },
}, strict: true });
const count = Number(values.conversations);
if (!Number.isSafeInteger(count) || count < 1 || count > 2000) throw new Error("--conversations must be from 1 to 2000.");

const fixture = await createRuntimeFixture({ seedConversations: false, concurrency: 3 });
const { store, scope, root } = fixture;
const directory = path.join(scope.sessionsRoot, "corpus");
const out = path.resolve(values.out!);
let accountedCalls = 0;
const started = performance.now();

function percentile(values: number[], p: number) {
  return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
}

function callCounts() {
  let analysis = 0;
  let selection = 0;
  for (const { input } of fixture.utilityRequests) {
    if (!input || typeof input !== "object" || !("stage" in input) || typeof input.stage !== "string") continue;
    if (input.stage.startsWith("analysis_")) analysis++;
    else if (input.stage === "select_topic") selection++;
  }
  return { analysis, selection, native: fixture.nativeRequests.length,
    total: fixture.utilityRequests.length + fixture.nativeRequests.length };
}

try {
  await fs.mkdir(directory, { recursive: true });
  for (let i = 0; i < count; i++) {
    const timestamp = new Date(Date.UTC(2026, 8, 1 + i % 20)).toISOString();
    const records: unknown[] = [{ type: "session", version: 3, id: `session-${i}`, cwd: path.join(root, `cwd-${i % 3}`), timestamp, title: `Corpus ${i}` }];
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
  await store.discover();
  const indexed = await store.work(fixture.model, fixture.repairRunner, { concurrency: fixture.concurrency });
  accountedCalls = indexed.calls;
  if (indexed.errors.length) {
    throw new Error(`Corpus indexing failed: ${JSON.stringify(indexed.errors)}; fixture calls=${callCounts().total}, completed=${indexed.completed}/${count}.`);
  }
  if (indexed.completed !== count) throw new Error(`Corpus indexing completed ${indexed.completed}/${count} conversations.`);
  if (indexed.repair_deferred.length) throw new Error(`Fresh local corpus unexpectedly deferred sources: ${JSON.stringify(indexed.repair_deferred)}`);
  const coldMs = performance.now() - coldStart;
  if (store.status().conversations !== count || store.status().topics !== 1) throw new Error("Incomplete or incorrectly clustered corpus.");
  const calls = callCounts();
  if (accountedCalls !== calls.total || fixture.peak > fixture.concurrency) {
    throw new Error("Native fixture call accounting or concurrency bound was violated.");
  }
  if (count > 1 && (!calls.native || !fixture.nativeToolCalls.some(call => call.name === "repair_read"))) {
    throw new Error("Historical maintenance did not execute through the native evidence tools.");
  }
  const warmStart = performance.now();
  const catalogFiles = new Set<string>();
  let cursor: string | undefined;
  do {
    const catalog = await store.catalog({ cursor, limit: 50 });
    if (catalog.warnings.length) throw new Error(`Catalog warnings: ${JSON.stringify(catalog.warnings)}`);
    for (const conversation of catalog.conversations) {
      if (!conversation.indexed || catalogFiles.has(conversation.source_file)) throw new Error("Catalog lost or duplicated an indexed conversation.");
      catalogFiles.add(conversation.source_file);
    }
    cursor = catalog.next_cursor ?? undefined;
  } while (cursor);
  const catalogMs = performance.now() - warmStart;
  if (catalogFiles.size !== count) throw new Error("Paged catalog did not cover the full corpus.");
  const searchMs: number[] = [];
  for (let i = 0; i < Math.min(count, 100); i++) {
    const index = (i * 31) % count;
    const start = performance.now();
    const result = await store.search([`evidence${index}slot3`]);
    searchMs.push(performance.now() - start);
    if (result.conversations.length !== 1 || result.conversations[0].session_id !== `session-${index}`) throw new Error("Wrong search result.");
  }
  if (fixture.errors.length) throw new AggregateError(fixture.errors, "Local SDK fixture reported runtime errors");
  const metrics = {
    kind: "offline-conversation-index-benchmark", completed: true, semantic_quality_evaluated: false,
    external_model_calls: 0, fixture_model_calls: calls.total, analysis_calls: calls.analysis, selection_calls: calls.selection,
    native_calls: calls.native, accounted_calls: accountedCalls, peak_concurrency: fixture.peak,
    native_peak_concurrency: fixture.nativePeak, concurrency_limit: fixture.concurrency,
    conversations: count, topics: store.status().topics,
    indexed_entries: store.status().indexed_entries, cold_index_ms: coldMs,
    catalog_ms: catalogMs, search_ms: { p50: percentile(searchMs, .5), p95: percentile(searchMs, .95) },
    db_bytes: (await fs.stat(store.dbPath)).size, bun: Bun.version, timestamp: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
} catch (error) {
  const calls = callCounts();
  const failure = {
    kind: "offline-conversation-index-benchmark", completed: false, semantic_quality_evaluated: false,
    requested_conversations: count, indexed_conversations: store.status().conversations,
    fixture_model_calls: calls.total, analysis_calls: calls.analysis, selection_calls: calls.selection, native_calls: calls.native,
    accounted_calls: accountedCalls, peak_concurrency: fixture.peak,
    elapsed_ms: performance.now() - started, error: error instanceof Error ? error.message : String(error),
  };
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(failure, null, 2));
  console.error(JSON.stringify(failure, null, 2));
  throw error;
} finally {
  await fixture.close();
}
