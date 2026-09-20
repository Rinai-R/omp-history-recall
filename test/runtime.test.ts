import { afterEach, expect, it } from "bun:test";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { HistoryStore } from "../src/store";
import { loadSource } from "../src/source";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function streamReply(delta: unknown, finish = "stop", tokens = 100) {
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const common = { id: "local-protocol-fixture", object: "chat.completion.chunk", created: 1, model: "history-fixture" };
  return new Response(chunk({ ...common, choices: [{ index: 0, delta, finish_reason: null }] }) +
    chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: tokens, completion_tokens: 10, total_tokens: tokens + 10 } }) +
    "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

it("runs real OMP tools with explicit indexing and a static system prompt", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recall-runtime-")));
  cleanup.push(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const oldDb = process.env.OMP_HISTORY_RECALL_DB;
  process.env.OMP_HISTORY_RECALL_DB = path.join(root, "index.db");
  cleanup.push(async () => {
    if (oldDb === undefined) delete process.env.OMP_HISTORY_RECALL_DB; else process.env.OMP_HISTORY_RECALL_DB = oldDb;
  });
  const directory = path.join(root, "sessions");
  await fs.mkdir(directory);
  const prior = SessionManager.create(root, directory);
  prior.appendMessage({ role: "user", timestamp: Date.parse("2026-09-20T01:00:00Z"), content: [{ type: "text", text: "WAL sync failure and EIO acknowledgement" }] });
  prior.appendMessage({ role: "user", timestamp: Date.parse("2026-09-20T01:01:00Z"), content: [{ type: "text", text: "A failed sync must not be acknowledged." }] });
  await prior.ensureOnDisk();
  await prior.close();
  const store = new HistoryStore(process.env.OMP_HISTORY_RECALL_DB, root);
  cleanup.push(async () => { store.close(); });

  const requestSchema = z.object({ messages: z.array(z.unknown()) });
  const requests: z.infer<typeof requestSchema>[] = [];
  const manager = SessionManager.create(root, directory);
  const calls = [
    { name: "history_recall_conversations", args: {} },
    { name: "history_recall_index", args: { file: prior.getSessionFile() } },
    { name: "history_recall_browse", args: {} },
    { name: "history_recall_read_conversation", args: { conversation_id: "" } },
  ];
  let step = -1;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = requestSchema.parse(await request.json());
      requests.push(body);
      if (JSON.stringify(body.messages[0]).includes("untrusted historical DATA")) {
        return streamReply({ role: "assistant", content: JSON.stringify({
          summary: "Investigated WAL durability and corrected acknowledgement behavior.",
          topics: [{ title: "Storage durability", description: "WAL persistence and sync failures.", aliases: ["持久化", "WAL"] }],
        }) });
      }
      const call = calls[step];
      if (step >= 0) step++;
      if (!call) return streamReply({ role: "assistant", content: "Protocol fixture complete." });
      if (call.name === "history_recall_read_conversation") {
        call.args.conversation_id = store.db.query<{ id: string }, []>("SELECT id FROM hr_conversations").get()!.id;
      }
      return streamReply({ role: "assistant", tool_calls: [{ index: 0, id: `recall${requests.length}`, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, "tool_calls");
    },
  });
  cleanup.push(async () => { await server.stop(true); });
  const auth = await AuthStorage.create(path.join(root, "auth.db"));
  cleanup.push(async () => { auth.close(); });
  auth.setRuntimeApiKey("history-local-fixture", "local-only");
  const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
  const provider: ExtensionFactory = pi => pi.registerProvider("history-local-fixture", {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "local-only",
    models: [{ id: "history-fixture", name: "Local fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
  });
  const settings = Settings.isolated();
  settings.setModelRole("default", "history-local-fixture/history-fixture");
  const { session, extensionsResult } = await createAgentSession({
    cwd: root, agentDir: path.join(root, "agent"), authStorage: auth, modelRegistry: registry, settings,
    sessionManager: manager, extensions: [provider],
    additionalExtensionPaths: [path.resolve(import.meta.dir, "../src/index.ts")], disableExtensionDiscovery: true,
    systemPrompt: "You are a local integration fixture. Use the requested tools.",
    skills: [], contextFiles: [], promptTemplates: [], slashCommands: [], rules: [], enableMCP: false,
    enableLsp: false, skipPythonPreflight: true, preloadedCustomToolPaths: [], toolNames: [], autoApprove: true,
  });
  cleanup.push(async () => { await session.dispose(); });
  expect(extensionsResult.errors).toEqual([]);
  const errors: unknown[] = [];
  await initializeExtensions(session, {
    reportSendError: (_action, error) => errors.push(error),
    reportRuntimeError: error => errors.push(error),
  });

  await session.prompt("Acknowledge this turn without retrieving history.");
  expect(errors).toEqual([]);
  expect(requests).toHaveLength(1);
  expect(store.status()).toMatchObject({ conversations: 0, topics: 0 });
  expect(store.status().jobs).toHaveLength(0);
  const first = requests[0];
  expect(JSON.stringify(first.messages[0])).toContain("omp-history-recall-instructions");
  expect(JSON.stringify(first.messages[0])).not.toContain("Storage durability");
  expect(JSON.stringify(first.messages)).not.toContain("failed sync");

  step = 0;
  await session.prompt("Inspect the historical storage decision.");
  const mainRequests = requests.filter(request => !JSON.stringify(request.messages[0]).includes("untrusted historical DATA"));
  const utilityRequests = requests.filter(request => JSON.stringify(request.messages[0]).includes("untrusted historical DATA"));
  expect(mainRequests).toHaveLength(6);
  expect(utilityRequests).toHaveLength(1);
  expect(mainRequests.every(request => JSON.stringify(request.messages[0]) === JSON.stringify(first.messages[0]))).toBeTrue();
  expect(store.status()).toMatchObject({ conversations: 1, topics: 1, indexed_entries: 2 });
  const persisted = await loadSource(manager.getSessionFile()!, { project: root });
  expect(persisted.entries.filter(entry => entry.role === "toolResult")).toHaveLength(4);
  expect(JSON.stringify(persisted.entries)).not.toContain('"isError":true');
  expect(JSON.stringify(persisted.entries)).toContain("conversation_id");
  expect(JSON.stringify(persisted.entries)).toContain("failed sync");
  expect(errors).toEqual([]);

  // A failed index must be returned as a tool error, not a successful empty result.
  calls.splice(0, calls.length, { name: "history_recall_index", args: { file: path.join(directory, "missing.jsonl") } });
  step = 0;
  await session.prompt("Index the selected historical file.");
  const afterFailure = await loadSource(manager.getSessionFile()!, { project: root });
  const failedTool = afterFailure.entries.filter(entry => entry.role === "toolResult").at(-1)!;
  expect(JSON.parse(failedTool.raw)).toMatchObject({ message: { isError: true } });
  expect(store.status().conversations).toBe(1);
}, 60_000);
