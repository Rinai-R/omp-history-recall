import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { Database } from "bun:sqlite";
import { setAgentDir, __resetDirsFromEnvForTests } from "@oh-my-pi/pi-utils/dirs";
import { loadSource } from "../src/source";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function streamReply(delta: unknown, finish = "stop") {
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const common = { id: "local-fts-fixture", object: "chat.completion.chunk", created: 1, model: "history-fixture" };
  return new Response(chunk({ ...common, choices: [{ index: 0, delta, finish_reason: null }] }) +
    chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) +
    "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

it("searches and reads historical sessions through real OMP tools without extra model calls", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recall-fts-runtime-")));
  cleanup.push(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const agentDir = path.join(root, "agent");
  const sessionsRoot = path.join(agentDir, "sessions");
  const bucket = path.join(sessionsRoot, "past-project");
  await fs.mkdir(bucket, { recursive: true });

  const historical = path.join(bucket, "past.jsonl");
  const records = [
    { type: "session", version: 3, id: "past-session", cwd: path.join(root, "past-project"), timestamp: "2026-09-20T00:00:00Z", title: "Storage review" },
    { type: "message", id: "u", parentId: null, timestamp: "2026-09-20T01:00:00Z", message: { role: "user", content: "WAL fsync failed; writes must not be acknowledged" } },
    { type: "message", id: "a", parentId: "u", timestamp: "2026-09-20T01:01:00Z", message: { role: "assistant", content: "A failed sync must not be acknowledged." } },
  ];
  await fs.writeFile(historical, records.map(record => JSON.stringify(record)).join("\n") + "\n");

  const savedEnv = {
    OMP_HISTORY_RECALL_DB: process.env.OMP_HISTORY_RECALL_DB,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    OMP_PROFILE: process.env.OMP_PROFILE,
    PI_PROFILE: process.env.PI_PROFILE,
  };
  process.env.OMP_HISTORY_RECALL_DB = path.join(root, "index.db");
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  setAgentDir(agentDir);
  cleanup.push(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    __resetDirsFromEnvForTests();
  });

  const requestSchema = { messages: [] as unknown[] };
  const requests: { messages: unknown[] }[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [
    { name: "history_recall_search", args: { queries: ["fsync"] } },
    { name: "history_recall_read_conversation", args: { conversation_id: "" } },
    { name: "history_recall_search", args: { queries: ["fsync"], session_id: "" } },
    { name: "history_recall_read_conversation", args: { session_id: "", last: 2 } },
    { name: "history_recall_trace", args: { session_id: "" } },
  ];
  let step = 0;
  let conversationId = "";
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = await request.json() as typeof requestSchema;
      requests.push(body as typeof requestSchema);
      const call = calls[step++];
      if (!call) return streamReply({ role: "assistant", content: "Protocol fixture complete." });
      if ((call.name === "history_recall_search" || call.name === "history_recall_trace") && call.args.session_id === "") {
        call.args.session_id = manager.getSessionId();
      }
      if (call.name === "history_recall_read_conversation") {
        if (call.args.session_id === "") {
          call.args.session_id = manager.getSessionId();
        } else {
          if (!conversationId) {
            conversationId = probe.query<{ id: string }, []>("SELECT id FROM hr_conversations").get()?.id ?? "";
          }
          call.args.conversation_id = conversationId;
        }
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
  const manager = SessionManager.create(root);
  cleanup.push(async () => { await manager.close(); });
  const { session, extensionsResult } = await createAgentSession({
    cwd: root, agentDir, authStorage: auth, modelRegistry: registry, settings, sessionManager: manager,
    extensions: [provider], additionalExtensionPaths: [path.resolve(import.meta.dir, "../src/index.ts")],
    disableExtensionDiscovery: true, systemPrompt: "You are a local integration fixture.",
    skills: [], contextFiles: [], promptTemplates: [], slashCommands: [], rules: [],
    enableMCP: false, enableLsp: false, skipPythonPreflight: true, preloadedCustomToolPaths: [], toolNames: [],
    autoApprove: true,
  });
  cleanup.push(async () => { await session.dispose(); });
  expect(extensionsResult.errors).toEqual([]);

  // The extension opens the override index; read the ingested id for the fixture's read call.
  const dbPath = process.env.OMP_HISTORY_RECALL_DB!;
  const probe = new Database(dbPath);
  cleanup.push(async () => { probe.close(); });

  const errors: unknown[] = [];
  await initializeExtensions(session, {
    reportSendError: (_action, error) => errors.push(error),
    reportRuntimeError: error => errors.push(error),
  });
  // One turn: search, then read the matched conversation. Both are local.
  await session.prompt("Find the historical fsync decision and read the matched conversation.");
  expect(conversationId).not.toBe("");

  expect(errors).toEqual([]);
  // Five tool calls plus the final answer; no indexing/search model calls.
  expect(requests).toHaveLength(6);
  const sessionFile = manager.getSessionFile();
  expect(sessionFile).toBeDefined();
  const persisted = await loadSource(sessionFile!);
  const toolResults = persisted.entries.filter(entry => entry.role === "toolResult");
  expect(toolResults).toHaveLength(5);
  const outputs = JSON.stringify(toolResults);
  expect(outputs).toContain("past-session");
  expect(outputs).toContain("current-session");
  expect(outputs).toContain("session-trace");
  expect(outputs).toContain("WAL fsync failed");
  expect(outputs).not.toContain('"isError":true');
  const system = JSON.stringify(requests[0].messages[0]);
  expect(system).toContain("omp-history-recall-instructions");
  expect(system).not.toContain("WAL fsync failed");
  const all = JSON.stringify(requests);
  expect(all).not.toContain("untrusted historical DATA");
  expect(all).not.toContain("OMP_HISTORY_REPAIR_PROTOCOL");
}, 60_000);
