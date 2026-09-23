import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/register-builtins";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createAgentSession, type ExtensionContext, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { HistoryStore } from "../src/store";
import { digest, loadSource } from "../src/source";
import { resolveRecallScope, type RecallScope } from "../src/scope";
import { TopicDescriptorSchema, type JsonModel } from "../src/semantic";
import { inputBudget } from "../src/chunking";
import { openHistoryDatabase } from "../src/database";
import { ModelBudget } from "../src/model-budget";
import { ompModel } from "../src/omp-model";
import { ompRepairRunner } from "../src/omp-repair";
import { RepairProtocol, type RepairCompletion, type RepairProposal, type RepairRunner, type ValidatedRepair } from "../src/repair";
import { TopicRegistry } from "../src/topic-registry";
import type { IncomingConversation, TopicSelection } from "../src/topics";

const storageProfile = {
  title: "Storage durability", description: "Durable storage writes, WAL sync failures, and acknowledgement correctness.",
  aliases: ["Storage durability", "WAL", "持久化"],
};
const uiProfile = {
  title: "Interface appearance", description: "Button spacing and interface colors.", aliases: ["Interface appearance", "UI"],
};
const cardSchema = TopicDescriptorSchema.extend({ id: z.string() }).passthrough();
const broadProfile = { title: "Application maintenance", description: "Storage durability and interface appearance.", aliases: ["Application maintenance"] };
const memberSchema = z.object({ conversation_id: z.string(), source_hash: z.string(), facet_id: z.string(),
  descriptor: TopicDescriptorSchema, evidence: z.array(z.object({ id: z.string(), hash: z.string() })), topic_id: z.string() });
const requestSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()) }).passthrough();
const stageSchema = z.object({ stage: z.string() }).passthrough();
export type WireRequest = z.infer<typeof requestSchema>;

/** Deterministic protocol fixture, not an evaluation of real-model semantic accuracy. */
function utilityResponse(input: unknown, selectionMode: SelectionMode): unknown {
  const stage = stageSchema.safeParse(input);
  if (!stage.success) return z.object({ queries: z.array(z.string()) }).parse(input);
  switch (stage.data.stage) {
    case "analysis_map":
    case "analysis_reduce":
    case "analysis_final": {
      const value = z.object({
        entries: z.array(z.object({ id: z.string(), text: z.string() }).passthrough()).optional(),
        segments: z.array(z.object({ summary: z.string(), facets: z.array(TopicDescriptorSchema.extend({ evidence_entry_ids: z.array(z.string()) })) })).optional(),
      }).parse(input);
      const text = value.entries?.map(entry => entry.text).join("\n") ?? JSON.stringify(value.segments ?? []);
      const ids = [...new Set(value.entries?.map(entry => entry.id)
        ?? value.segments?.flatMap(segment => segment.facets.flatMap(facet => facet.evidence_entry_ids)) ?? [])].slice(0, 12);
      assert(ids.length > 0, "Analysis fixture received no evidence");
      const profile = /按钮|button|spacing|colors|Interface appearance/iu.test(text) ? uiProfile
        : selectionMode === "collapse" ? broadProfile : storageProfile;
      return { summary: profile.description, facets: [{ ...profile, evidence_entry_ids: ids }] };
    }
    case "select_topic": {
      const value = z.object({ facet: TopicDescriptorSchema, previous: z.array(cardSchema), candidates: z.array(cardSchema) }).parse(input);
      const chosen = selectionMode === "distinct" ? undefined : selectionMode === "collapse"
        ? [...value.previous, ...value.candidates][0]
        : [...value.previous, ...value.candidates].find(card => card.title === value.facet.title);
      return { topic_id: chosen?.id ?? null, candidate_ids: chosen ? [chosen.id] : [], reason: "Controlled fixture preserves matching discussion scope." };
    }
    default:
      throw new Error(`Unexpected utility stage: ${stage.data.stage}`);
  }
}

export function streamReply(delta: unknown, finish = "stop") {
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const common = { id: "local-protocol-fixture", object: "chat.completion.chunk", created: 1, model: "history-fixture" };
  return new Response(chunk({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })
    + chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })
    + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  return z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).parse(content)
    .filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
}

export type FixtureToolResult = { isError: boolean; value: unknown };
const toolResultSchema = z.object({ message: z.object({ isError: z.boolean().optional(), content: z.unknown() }).passthrough() });

export type SelectionMode = "normal" | "collapse" | "distinct";
export type NativeRepairMode = "keep" | "split" | "merge" | "merge_stream" | "boundary";
export type FixtureNativeCall = { name: string; args: Record<string, unknown> };
export type FixtureNativeResult = FixtureNativeCall & { id: string; value: Record<string, unknown> };
export type RuntimeFixtureOptions = {
  seedConversations?: boolean;
  batchCalls?: number;
  concurrency?: number;
  contextWindow?: number;
  readyBanner?: boolean;
  providerFetch?: FetchImpl;
  nativeReply?: (request: WireRequest, defaultReply: () => Response) => Response | Promise<Response>;
};

/** These are provider responses, not calls to host tools; the SDK owns every dispatch. */
export function nativeToolReply(calls: readonly FixtureNativeCall[], prefix = "native-fixture"): Response {
  return streamReply({ role: "assistant", tool_calls: calls.map((call, index) => ({ index,
    id: `${prefix}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
  })) }, "tool_calls");
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(messageText(value));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function nativeResults(request: WireRequest): FixtureNativeResult[] {
  const calls = new Map<string, FixtureNativeCall>();
  const results: FixtureNativeResult[] = [];
  for (const message of request.messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const value of message.tool_calls) {
        const call = z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }).parse(value);
        calls.set(call.id, { name: call.function.name, args: JSON.parse(call.function.arguments) });
      }
    }
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      const call = calls.get(message.tool_call_id);
      const value = jsonObject(message.content);
      if (call && value) results.push({ ...call, id: message.tool_call_id, value });
    }
  }
  return results;
}

const nativeInputSchema = z.object({
  protocol: z.literal("omp-topic-repair-v1"), view_id: z.string(),
  incoming: z.object({ id: z.string(), source_hash: z.string(), analysis: z.object({ facets: z.array(
    TopicDescriptorSchema.extend({ id: z.string(), evidence_entry_ids: z.array(z.string()) }),
  ) }).passthrough() }),
  selection: z.object({ assignments: z.array(z.object({ facetId: z.string(), topicRef: z.string() }).passthrough()),
    newTopics: z.array(z.object({ ref: z.string(), descriptor: TopicDescriptorSchema })) }),
  topics: z.array(cardSchema), audit: z.array(z.unknown()),
}).passthrough();
type NativeInput = z.infer<typeof nativeInputSchema>;
type NativeMember = z.infer<typeof memberSchema>;

function facetKey(member: { conversation_id: string; facet_id: string }): string {
  return JSON.stringify([member.conversation_id, member.facet_id]);
}

function incomingMembers(input: NativeInput): NativeMember[] {
  return input.incoming.analysis.facets.map(facet => ({
    conversation_id: input.incoming.id, source_hash: input.incoming.source_hash, facet_id: facet.id,
    descriptor: { title: facet.title, description: facet.description, aliases: facet.aliases },
    evidence: facet.evidence_entry_ids.map(id => ({ id, hash: "" })),
    topic_id: input.selection.assignments.find(assignment => assignment.facetId === facet.id)!.topicRef,
  }));
}

function nativeResponse(request: WireRequest, mode: NativeRepairMode): Response {
  const objects = request.messages.map(message => jsonObject(message.content)).filter(value => value !== undefined);
  const input = nativeInputSchema.parse(objects.find(value => value.protocol === "omp-topic-repair-v1"));
  const state = objects.findLast(value => value.protocol_state === "omp-topic-repair-v1");
  const results = nativeResults(request);
  const reply = (calls: FixtureNativeCall[]) => nativeToolReply(calls, `r_${digest(JSON.stringify(request.messages)).slice(0, 20)}`);
  const one = (name: string, args: Record<string, unknown>) => reply([{ name, args }]);
  const finish = (proposalId: string | null) => one("yield", { data: {
    proposal_id: proposalId, reason: proposalId ? "All proposed destinations were checked against complete original evidence." : "Keep the verified topic memberships.",
  } });
  const members = new Map<string, NativeMember>();
  for (const value of input.audit) {
    const parsed = memberSchema.safeParse(value);
    if (parsed.success) members.set(facetKey(parsed.data), parsed.data);
  }
  for (const member of incomingMembers(input)) members.set(facetKey(member), member);
  for (const result of results) if (Array.isArray(result.value.members)) {
    for (const value of result.value.members) {
      const parsed = memberSchema.safeParse(value);
      if (parsed.success) members.set(facetKey(parsed.data), parsed.data);
    }
  }
  const completed = new Set<string>();
  // Receipts survive projection; infer nothing from a summary or a partial fragment.
  function collectReceipts(value: unknown): void {
    if (Array.isArray(value)) { for (const item of value) collectReceipts(item); return; }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (typeof item.conversationId === "string" && typeof item.facetId === "string" && typeof item.entryHash === "string") {
      completed.add(facetKey({ conversation_id: item.conversationId, facet_id: item.facetId }));
    }
    for (const child of Object.values(item)) collectReceipts(child);
  }
  collectReceipts(state);
  const readResults = results.filter(result => result.name === "repair_read" && result.args.action === "read");
  const received = new Map<string, number>();
  for (const result of readResults) {
    if (!Array.isArray(result.value.fragments)) continue;
    for (const fragment of result.value.fragments) {
      const parsed = z.object({ entry_id: z.string(), offset: z.number().optional(), total_chars: z.number(),
        text: z.string().optional(), received_through: z.number().optional() }).safeParse(fragment);
      if (!parsed.success) continue;
      const ref = z.object({ conversation_id: z.string(), facet_id: z.string() }).parse(result.args);
      const key = JSON.stringify([facetKey(ref), parsed.data.entry_id]);
      const through = parsed.data.received_through ?? (typeof parsed.data.offset === "number" && parsed.data.offset === (received.get(key) ?? 0)
        ? parsed.data.offset + (parsed.data.text?.length ?? 0) : received.get(key) ?? 0);
      received.set(key, through);
      if (through === parsed.data.total_chars) completed.add(facetKey(ref));
    }
  }
  const continuations = z.array(z.object({ conversation_id: z.string(), facet_id: z.string(), entry_id: z.string(),
    before: z.number(), after: z.number(), next_cursor: z.string().nullable(),
    entries: z.array(z.object({ received_through: z.number(), total_chars: z.number() }).passthrough()),
  }).passthrough()).parse(state?.reads ?? []);
  for (const continuation of continuations) if (continuation.entries.some(entry => entry.received_through === entry.total_chars)) {
    completed.add(facetKey(continuation));
  }
  const continuation = continuations.find(item => item.next_cursor !== null && !completed.has(facetKey(item)));
  if (continuation) return reply([{ name: "repair_read", args: { action: "remember", conversation_id: continuation.conversation_id,
    facet_id: continuation.facet_id, summary: "Retain the source's failures and unresolved outcome while reading its continuation." } },
  { name: "repair_read", args: { action: "read", conversation_id: continuation.conversation_id, facet_id: continuation.facet_id,
    entry_id: continuation.entry_id, before: continuation.before, after: continuation.after, cursor: continuation.next_cursor } }]);
  const latest = results.at(-1);
  // Long evidence advances only after the model writes a rolling fact note. The
  // next read uses the cursor returned by the real tool, never a guessed offset.
  if (latest?.name === "repair_read" && latest.args.action === "read" && typeof latest.value.next_cursor === "string") {
    return reply([{ name: "repair_read", args: { action: "remember", conversation_id: latest.args.conversation_id,
      facet_id: latest.args.facet_id, summary: "Retain the source's failures and unresolved outcome while reading its continuation." } },
    { name: "repair_read", args: { ...latest.args, cursor: latest.value.next_cursor } }]);
  }
  const read = (member: NativeMember): FixtureNativeCall => ({ name: "repair_read", args: { action: "read",
    conversation_id: member.conversation_id, facet_id: member.facet_id, entry_id: member.evidence[0].id,
  } });
  const proposed = results.findLast(result => result.name === "repair_propose" && result.value.accepted === true);
  const activeProposal = state?.proposal && typeof state.proposal === "object" ? state.proposal as Record<string, unknown> : undefined;
  const proposalId = typeof activeProposal?.proposal_id === "string" ? activeProposal.proposal_id
    : typeof proposed?.value.proposal_id === "string" ? proposed.value.proposal_id : undefined;
  if (proposalId) {
    const coverage = Array.isArray(state?.coverage) ? state.coverage as Record<string, unknown>[] : [];
    const pending = coverage.find(target => target.pending)?.pending as Record<string, unknown> | undefined;
    const pageResult = results.findLast(result => result.name === "repair_coverage");
    const page = pending ?? (latest?.name === "repair_coverage" || latest?.name === "repair_read" ? pageResult?.value : undefined);
    if (page && typeof page.page_id === "string") {
      const pageMembers = z.array(memberSchema).parse(page.members);
      const unread = pageMembers.find(member => !completed.has(facetKey(member)));
      if (unread) return reply([read(unread)]);
      return one("repair_check", { proposal_id: proposalId, page_id: page.page_id,
        fits: pageMembers.map(member => ({ conversation_id: member.conversation_id, facet_id: member.facet_id, fits: true })) });
    }
    const targets = proposed?.value.coverage_targets;
    const targetRefs = Array.isArray(targets) ? targets.map(value => z.object({ target_ref: z.string() }).parse(value).target_ref)
      : coverage.map(target => String(target.target_ref));
    const done = new Set(coverage.filter(target => target.complete === true).map(target => String(target.target_ref)));
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.name !== "repair_check" || result.value.complete !== true) continue;
      const checked = results.slice(0, index).findLast(item => item.name === "repair_coverage" && item.value.page_id === result.args.page_id);
      if (checked) done.add(String(checked.value.target_ref));
    }
    const target = targetRefs.find(ref => !done.has(ref));
    if (!target) return finish(proposalId);
    const lastPage = results.findLast(result => result.name === "repair_coverage" && result.value.target_ref === target);
    const cursor = coverage.find(item => item.target_ref === target)?.next_cursor ?? lastPage?.value.next_cursor;
    return one("repair_coverage", { proposal_id: proposalId, target_ref: target, ...(typeof cursor === "string" ? { cursor } : {}) });
  }
  if (mode !== "keep") {
    const catalogs = results.filter(result => result.name === "repair_topics");
    const catalog = catalogs.at(-1);
    if (!catalog || typeof catalog.value.next_cursor === "string") {
      return one("repair_topics", typeof catalog?.value.next_cursor === "string" ? { cursor: catalog.value.next_cursor } : {});
    }
    const cards = [...input.topics, ...catalogs.flatMap(result => z.array(cardSchema).parse(result.value.topics))];
    if (mode !== "merge_stream") {
      const refs = [...new Set([...cards.map(card => card.id), ...input.selection.newTopics.map(topic => topic.ref)])];
      for (const ref of refs) {
        const page = results.findLast(result => result.name === "repair_members" && result.args.topic_ref === ref);
        if (!page || typeof page.value.next_cursor === "string") return one("repair_members", { topic_ref: ref,
          ...(typeof page?.value.next_cursor === "string" ? { cursor: page.value.next_cursor } : {}) });
      }
    }
  }
  const auditIds = new Set(input.audit.flatMap(value => {
    const ref = z.object({ conversation_id: z.string(), facet_id: z.string() }).safeParse(value);
    return ref.success ? [facetKey(ref.data)] : [];
  }));
  const unread = [...members.values()].filter(member => !completed.has(facetKey(member)) && (mode !== "keep" || auditIds.has(facetKey(member))));
  if (unread.length) return reply(unread.slice(0, 8).map(read));
  if (mode === "keep") return finish(null);
  if (mode === "boundary" && !results.some(result => result.name === "repair_read" && result.args.action === "remember")) {
    const member = incomingMembers(input)[0];
    return one("repair_read", { action: "remember", conversation_id: member.conversation_id, facet_id: member.facet_id,
      summary: "The original reports a WAL fsync failure and explicitly forbids acknowledging the writes." });
  }
  const proposal: RepairProposal = { drafts: [], updates: [], moves: [], merge: null, reason: "Controlled evidence-backed native repair fixture." };
  if (mode === "boundary") {
    const member = incomingMembers(input)[0];
    proposal.drafts.push({ ref: "repair:0", descriptor: storageProfile });
    proposal.moves.push({ conversationId: member.conversation_id, sourceHash: member.source_hash, facetId: member.facet_id,
      fromTopicRef: member.topic_id, targetRef: "repair:0", reason: "Exercise a complete prospective destination proof." });
  } else if (mode === "split") {
    const misplaced = [...members.values()].filter(member => member.conversation_id !== input.incoming.id && member.descriptor.title === uiProfile.title);
    assert(misplaced.length > 0 && misplaced.length <= 8, "Split fixture must find bounded historical UI members in real results");
    proposal.drafts.push({ ref: "repair:0", descriptor: uiProfile });
    proposal.moves = misplaced.map(member => ({ conversationId: member.conversation_id, sourceHash: member.source_hash, facetId: member.facet_id,
      fromTopicRef: member.topic_id, targetRef: "repair:0", reason: "Original evidence concerns interface appearance, not durable writes." }));
    proposal.updates = [...new Set(misplaced.map(member => member.topic_id))].map(topicId => ({ topicId, descriptor: storageProfile,
      reason: "The remaining original evidence concerns storage durability only." }));
  } else {
    const ids = [...new Set(mode === "merge_stream"
      ? results.filter(result => result.name === "repair_topics").flatMap(result => z.array(cardSchema).parse(result.value.topics).map(card => card.id))
      : [...members.values()].map(member => member.topic_id))].filter(id => id.startsWith("t_"));
    assert.equal(ids.length, 2, "Merge fixture must discover both persisted topics");
    proposal.merge = { leftTopicId: ids[0], rightTopicId: ids[1], descriptor: storageProfile,
      reason: "Both topics contain the same durability scope, not merely a broader common category." };
  }
  return one("repair_propose", proposal);
}
const environmentKeys = [
  "OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR", "OMP_HISTORY_RECALL_DB", "OMP_HISTORY_RECALL_MODEL",
  "OMP_HISTORY_RECALL_DISABLED", "OMP_HISTORY_RECALL_BATCH_CALLS",
  "OMP_HISTORY_RECALL_BATCH_SESSIONS", "OMP_HISTORY_RECALL_CONCURRENCY", "PI_DIALECT",
] as const;

export async function createRuntimeFixture(options: RuntimeFixtureOptions = {}): Promise<RuntimeFixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recall-runtime-")));
  const savedEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  const closers: (() => void | Promise<void>)[] = [];
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const dispose of closers.reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    __resetDirsFromEnvForTests();
    await fs.rm(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Runtime fixture teardown failed");
  }
  try {
    delete process.env.OMP_PROFILE;
    delete process.env.PI_PROFILE;
    delete process.env.OMP_HISTORY_RECALL_DISABLED;
    delete process.env.PI_DIALECT;
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir);
    setAgentDir(agentDir);
    process.env.OMP_HISTORY_RECALL_DB = path.join(root, "index.db");
    process.env.OMP_HISTORY_RECALL_MODEL = "history-local-fixture/history-fixture";
    process.env.OMP_HISTORY_RECALL_BATCH_CALLS = String(options.batchCalls ?? 12);
    process.env.OMP_HISTORY_RECALL_BATCH_SESSIONS = "2";
    const concurrency = options.concurrency ?? 3;
    process.env.OMP_HISTORY_RECALL_CONCURRENCY = String(concurrency);
    const scope = await resolveRecallScope();
    const cwds = { a: path.join(root, "storage-a"), b: path.join(root, "storage-b"), c: path.join(root, "interface-c") };
    await Promise.all(Object.values(cwds).map(cwd => fs.mkdir(cwd)));
    const files = {
      a: path.join(scope.sessionsRoot, "bucket-a", "a.jsonl"),
      b: path.join(scope.sessionsRoot, "bucket-b", "b.jsonl"),
      c: path.join(scope.sessionsRoot, "bucket-c", "c.jsonl"),
    };
    async function writeConversation(file: string, id: string, cwd: string, text: string) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const timestamp = "2026-09-20T01:00:00.000Z";
      await fs.writeFile(file, [
        { type: "session", version: 3, id, cwd, timestamp },
        { type: "message", id: `${id}-entry`, parentId: null, timestamp, message: { role: "user", content: text } },
      ].map(value => JSON.stringify(value)).join("\n") + "\n");
    }
    if (options.seedConversations !== false) {
      await writeConversation(files.a, "source-a", cwds.a, "WAL fsync failed; writes must not be acknowledged");
      await writeConversation(files.b, "source-b", cwds.b, "持久化失败，写入不能确认");
      await writeConversation(files.c, "source-c", cwds.c, "调整按钮间距和颜色");
    }
    const foreignAgent = path.join(root, "foreign-profile");
    const foreignScope: RecallScope = {
      id: `scope_${digest(foreignAgent).slice(0, 24)}`, agentDir: foreignAgent,
      sessionsRoot: path.join(foreignAgent, "sessions"), customFilesRoot: path.join(foreignAgent, "custom-session-files"),
    };
    const foreignFiles = [path.join(foreignScope.sessionsRoot, "outside-a.jsonl"), path.join(foreignScope.sessionsRoot, "outside-b.jsonl")];
    for (const [index, file] of foreignFiles.entries()) await writeConversation(file, `foreign-${index}`, foreignAgent, "FOREIGN_PROFILE_SECRET must never reach the provider");

    // Resolver isolation precedes every SessionManager, including explicit custom directories.
    const manager = SessionManager.create(cwds.c, path.dirname(files.c));
    closers.push(() => manager.close());
    await manager.setSessionName("History runtime fixture", "user");
    const store = new HistoryStore(process.env.OMP_HISTORY_RECALL_DB, scope, {
      sessionDir: manager.getSessionDir(), activeFile: manager.getSessionFile(), activeSessionId: manager.getSessionId(),
    });
    closers.push(() => store.close());
    const requests: WireRequest[] = [];
    const utilityRequests: { input: unknown; request: WireRequest }[] = [];
    const mainRequests: WireRequest[] = [];
    const nativeRequests: WireRequest[] = [];
    const nativeToolCalls: FixtureNativeResult[] = [];
    const observedCalls = new Set<string>();
    let repairMode: NativeRepairMode = "keep";
    let selectionMode: SelectionMode = "normal";
    const errors: unknown[] = [];
    const notifications: { message: string; type: string }[] = [];
    const queued: { name: string; args: Record<string, unknown> }[] = [];
    let active = 0;
    let peak = 0;
    let nativeActive = 0;
    let nativePeak = 0;
    let invalidAnalysis = false;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        try {
          const body = requestSchema.parse(await request.json());
          requests.push(body);
          if (body.messages.some(message => (message.role === "system" || message.role === "developer")
            && messageText(message.content).includes("OMP_HISTORY_REPAIR_PROTOCOL=omp-topic-repair-v1"))) {
            nativeRequests.push(body);
            const toolNames = z.array(z.object({ function: z.object({ name: z.string() }).passthrough() }).passthrough()).parse(body.tools)
              .map(tool => tool.function.name).sort();
            assert.deepEqual(toolNames, ["repair_check", "repair_coverage", "repair_members", "repair_propose", "repair_read", "repair_topics", "yield"],
              "Native child must expose exactly its six restricted tools and terminal yield");
            for (const result of nativeResults(body)) if (!observedCalls.has(result.id)) {
              observedCalls.add(result.id);
              nativeToolCalls.push(result);
            }
            active++; nativeActive++;
            peak = Math.max(peak, active); nativePeak = Math.max(nativePeak, nativeActive);
            try {
              await Bun.sleep(5);
              const respond = () => nativeResponse(body, repairMode);
              return await (options.nativeReply ? options.nativeReply(body, respond) : respond());
            } finally { active--; nativeActive--; }
          }
          const last = body.messages.at(-1);
          let input: unknown;
          if (last?.role === "user") {
            try { input = JSON.parse(messageText(last.content)); } catch { /* Ordinary agent turns are not utility requests. */ }
          }
          if (input && typeof input === "object" && ("stage" in input || "queries" in input)) {
            utilityRequests.push({ input, request: body });
            active++;
            peak = Math.max(peak, active);
            try {
              await Bun.sleep(5);
              if (invalidAnalysis && stageSchema.safeParse(input).data?.stage.startsWith("analysis_")) {
                invalidAnalysis = false;
                return streamReply({ role: "assistant", content: JSON.stringify({
                  summary: "Invalid evidence fixture", facets: [{ ...storageProfile, evidence_entry_ids: ["not-in-source"] }],
                }) });
              }
              return streamReply({ role: "assistant", content: JSON.stringify(utilityResponse(input, selectionMode)) });
            } finally { active--; }
          }
          mainRequests.push(body);
          const parentToolNames = z.array(z.object({ function: z.object({ name: z.string() }).passthrough() }).passthrough())
            .parse(body.tools ?? []).map(tool => tool.function.name);
          assert(!parentToolNames.some(name => name.startsWith("repair_")),
            "Repair tools must never be exposed on an ordinary parent provider request, before or after child execution");
          const call = queued.shift();
          if (!call) return streamReply({ role: "assistant", content: "Local protocol fixture complete." });
          return streamReply({ role: "assistant", tool_calls: [{ index: 0, id: `recall${requests.length}`, type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, "tool_calls");
        } catch (error) {
          errors.push(error);
          return new Response("Local fixture request failed", { status: 500 });
        }
      },
    });
    closers.push(async () => { await server.stop(true); });
    if (options.readyBanner) console.log("native-repair-smoke ready");
    const auth = await AuthStorage.create(path.join(root, "auth.db"));
    closers.push(() => auth.close());
    auth.setRuntimeApiKey("history-local-fixture", "local-only");
    const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
    if (options.providerFetch) closers.push(() => registry.syncExtensionSources([]));
    let fixtureContext: ExtensionContext | undefined;
    let openAICompat: Model<"openai-completions">["compat"] | undefined;
    const provider: ExtensionFactory = pi => {
      pi.registerProvider("history-local-fixture", {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        api: options.providerFetch ? "history-local-fixture-fetch" : "openai-completions", apiKey: "local-only",
        streamSimple: options.providerFetch ? (model, context, streamOptions) => {
          // Custom API registration does not resolve built-in compat. Borrow
          // only the public builder's OpenAI policy, retaining model/result API
          // identity and the real lazy stream's unmodified lifecycle.
          openAICompat ??= buildModel<"openai-completions">({ ...model, api: "openai-completions", compat: undefined, remoteCompaction: undefined }).compat;
          assert(streamOptions?.apiKey === undefined || typeof streamOptions.apiKey === "string", "The native SDK must resolve credentials before custom provider dispatch");
          return streamOpenAICompletions({ ...model, compat: openAICompat } as Model<"openai-completions">, context,
            { ...streamOptions, apiKey: streamOptions?.apiKey, fetch: options.providerFetch });
        } : undefined,
        models: [{ id: "history-fixture", name: "Local fixture", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: options.contextWindow ?? 128000, maxTokens: 8192 }],
      });
      pi.on("session_start", (_event, context) => { fixtureContext = context; });
    };
    const settings = Settings.isolated();
    settings.setModelRole("default", "history-local-fixture/history-fixture");
    settings.set("advisor.enabled", false);
    settings.set("compaction.enabled", false);
    settings.set("retry.enabled", false);
    settings.set("tools.speculativeExecution.enabled", false);
    settings.set("tools.format", "native");
    const { session, extensionsResult } = await createAgentSession({
      cwd: cwds.c, agentDir, authStorage: auth, modelRegistry: registry, settings, sessionManager: manager, extensions: [provider],
      additionalExtensionPaths: [path.resolve(import.meta.dir, "../src/index.ts")], disableExtensionDiscovery: true,
      systemPrompt: "You are a local integration fixture. Use the requested tools.",
      skills: [], contextFiles: [], promptTemplates: [], slashCommands: [], rules: [], enableMCP: false,
      enableLsp: false, enableIrc: false, skipPythonPreflight: true, preloadedCustomToolPaths: [], toolNames: [], autoApprove: true,
    });
    closers.push(() => session.dispose());
    assert.deepEqual(extensionsResult.errors, []);
    await initializeExtensions(session, {
      reportSendError: (_action, error) => errors.push(error), reportRuntimeError: error => errors.push(error),
      uiContext: { ...session.extensionRunner!.getUIContext(), notify: (message, type = "info") => notifications.push({ message, type }) },
    });
    assert(fixtureContext, "The real SDK must deliver its session_start ExtensionContext");
    const model = ompModel(fixtureContext, metric => store.recordModelCall("index", metric));
    const repairRunner = ompRepairRunner(fixtureContext, metric => store.recordModelCall("index", metric));
    async function runNativeBoundary(runOptions: NativeBoundaryOptions = {}): Promise<NativeBoundaryResult> {
      const file = path.join(scope.sessionsRoot, "native-boundary", "source.jsonl");
      await writeConversation(file, "native-boundary-source", cwds.a,
        runOptions.text ?? "WAL fsync failed; writes must not be acknowledged");
      const source = await loadSource(file);
      const evidence = source.entries.filter(entry => entry.text.length > 0);
      const incoming: IncomingConversation = {
        id: `c_${digest(JSON.stringify([scope.id, source.sessionId])).slice(0, 24)}`, sourceHash: source.fingerprint,
        analysis: { summary: storageProfile.description, facets: [{ id: "f0", ...storageProfile, evidence_entry_ids: [evidence[0].id] }] },
        evidenceById: new Map(evidence.map(({ id, hash }) => [id, { id, hash }])),
      };
      const selection: TopicSelection = { assignments: [{ facetId: "f0", topicRef: "new:f0", candidateIds: [], reason: "Initial native fixture preview." }],
        newTopics: [{ ref: "new:f0", descriptor: storageProfile }], neighborIds: [] };
      const db = openHistoryDatabase(store.dbPath);
      const priorMode = repairMode;
      repairMode = "boundary";
      try {
        const topics = new TopicRegistry(db, scope.id, manager.getSessionId());
        const protocol = new RepairProtocol(scope, topics, incoming, source, selection, topics.snapshot(),
          async () => { throw new Error("Boundary fixture has no historical sources"); },
          { inputBytes: inputBudget(model.contextWindow, model.maxOutputTokens), concurrency });
        protocol.bindModel(model);
        await protocol.prepare(runOptions.signal);
        const budget = new ModelBudget(db, scope.id, { maxCalls: runOptions.maxCalls ?? 100});
        const completion = await repairRunner({ protocol, budget, concurrency, signal: runOptions.signal });
        return { completion, repair: protocol.finalize(completion), calls: budget.calls };
      } finally { repairMode = priorMode; db.close(); }
    }
    async function tool(name: string, args: Record<string, unknown> = {}): Promise<FixtureToolResult> {
      const countBefore = session.messages.filter(message => message.role === "toolResult").length;
      queued.push({ name, args });
      await session.prompt(`Run the requested ${name} operation.`);
      assert.equal(queued.length, 0, "The provider did not dispatch the requested tool");
      assert.equal(session.messages.filter(message => message.role === "toolResult").length, countBefore + 1);
      const persisted = await loadSource(manager.getSessionFile()!);
      const entry = persisted.entries.filter(entry => entry.role === "toolResult").at(-1);
      assert(entry, "The real SDK did not persist the tool result");
      const result = toolResultSchema.parse(JSON.parse(entry.raw));
      return { isError: result.message.isError ?? false, value: JSON.parse(messageText(result.message.content)) };
    }
    async function foreignCursor() {
      const other = new HistoryStore(store.dbPath, foreignScope, { activeSessionId: "foreign-active" });
      try {
        const catalog = await other.catalog({ limit: 1 });
        assert(catalog.next_cursor);
        return catalog.next_cursor;
      } finally { other.close(); }
    }
    return {
      root, scope, cwds, files, foreignFiles, store, session, model, repairRunner, runNativeBoundary,
      requests, mainRequests, utilityRequests, nativeRequests, nativeToolCalls, errors, notifications, tool, close,
      foreignCursor, writeConversation, failNextAnalysis() { invalidAnalysis = true; },
      setRepairMode(mode) { repairMode = mode; }, setSelectionMode(mode) { selectionMode = mode; },
      get peak() { return peak; }, get nativePeak() { return nativePeak; }, concurrency,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type NativeBoundaryOptions = { maxCalls?: number; signal?: AbortSignal; text?: string };
export type NativeBoundaryResult = { completion: RepairCompletion; repair: ValidatedRepair; calls: number };

export type RuntimeFixture = {
  root: string;
  scope: RecallScope;
  cwds: { a: string; b: string; c: string };
  files: { a: string; b: string; c: string };
  foreignFiles: string[];
  store: HistoryStore;
  session: AgentSession;
  model: JsonModel;
  repairRunner: RepairRunner;
  runNativeBoundary(options?: NativeBoundaryOptions): Promise<NativeBoundaryResult>;
  requests: WireRequest[];
  mainRequests: WireRequest[];
  utilityRequests: { input: unknown; request: WireRequest }[];
  nativeRequests: WireRequest[];
  nativeToolCalls: FixtureNativeResult[];
  errors: unknown[];
  notifications: { message: string; type: string }[];
  tool(name: string, args?: Record<string, unknown>): Promise<FixtureToolResult>;
  close(): Promise<void>;
  foreignCursor(): Promise<string>;
  writeConversation(file: string, id: string, cwd: string, text: string): Promise<void>;
  failNextAnalysis(): void;
  setRepairMode(mode: NativeRepairMode): void;
  setSelectionMode(mode: SelectionMode): void;
  readonly peak: number;
  readonly nativePeak: number;
  concurrency: number;
};
const catalogSchema = z.object({ scope_id: z.string(), next_cursor: z.string().nullable(), conversations: z.array(z.object({
  source_file: z.string(), indexed: z.boolean(), source_cwd: z.string().nullable(), time_basis: z.enum(["filesystem", "indexed"]),
  started_at: z.string().nullable(), last_active_at: z.string().nullable(),
})), warnings: z.array(z.unknown()) });
const membershipSchema = z.object({ topic_id: z.string(), facet_id: z.string(), evidence_refs: z.array(z.object({ entry_id: z.string(), sha256: z.string() })) });
const conversationSchema = z.object({ id: z.string(), session_id: z.string(), source_cwd: z.string(), memberships: z.array(membershipSchema) });
const browseSchema = z.object({ entries: z.array(z.object({ id: z.string(), member_count: z.number() })) });
const searchSchema = z.object({ conversations: z.array(conversationSchema.extend({ matched_entry_ids: z.array(z.string()) })) });
const evidenceSchema = z.object({ source_file: z.string(), fragments: z.array(z.object({ entry_id: z.string(), sha256: z.string(), text: z.string() })) });

export async function exerciseSemanticRecall(fixture: RuntimeFixture) {
  await fixture.session.prompt("Acknowledge this ordinary turn without retrieving history.");
  assert.equal(fixture.mainRequests.length, 1);
  assert.equal(fixture.utilityRequests.length, 0);
  assert.equal(fixture.nativeRequests.length, 0);
  assert.equal(fixture.store.status().conversations, 0);
  assert.equal(fixture.store.status().jobs.length, 0);
  const firstSystem = JSON.stringify(fixture.mainRequests[0].messages[0]);
  assert(firstSystem.includes("omp-history-recall-instructions"));
  assert(!firstSystem.includes(storageProfile.title));
  assert(!JSON.stringify(fixture.mainRequests[0]).includes("WAL fsync failed"));

  const catalogEntries: z.infer<typeof catalogSchema>["conversations"] = [];
  let cursor: string | undefined;
  do {
    const result = await fixture.tool("history_recall_conversations", { limit: 1, ...(cursor ? { cursor } : {}) });
    assert.equal(result.isError, false);
    const catalog = catalogSchema.parse(result.value);
    assert.equal(catalog.scope_id, fixture.scope.id);
    assert.deepEqual(catalog.warnings, []);
    catalogEntries.push(...catalog.conversations);
    cursor = catalog.next_cursor ?? undefined;
  } while (cursor);
  assert.deepEqual(catalogEntries.map(entry => entry.source_file).sort(), Object.values(fixture.files).sort());
  for (const entry of catalogEntries) {
    assert.equal(entry.indexed, false);
    assert.equal(entry.source_cwd, null);
    assert.equal(entry.time_basis, "filesystem");
    assert.equal(entry.started_at, null);
    assert.equal(entry.last_active_at, null);
  }
  assert.equal(fixture.utilityRequests.length, 0, "Catalog discovery must not call the model");

  let firstTopic = "";
  for (const [key, file] of Object.entries(fixture.files)) {
    assert(catalogEntries.some(entry => entry.source_file === file));
    const indexed = await fixture.tool("history_recall_index", { file });
    assert.equal(indexed.isError, false, JSON.stringify(indexed.value));
    const result = z.object({ result: z.object({ completed: z.number(), failed: z.number() }) }).parse(indexed.value);
    assert.equal(result.result.completed, 1);
    assert.equal(result.result.failed, 0);
    if (key === "a") {
      assert.equal(fixture.nativeRequests.length, 0, "The first conversation must not launch maintenance without history");
      const browse = await fixture.tool("history_recall_browse");
      assert.equal(browse.isError, false);
      firstTopic = browseSchema.parse(browse.value).entries[0].id;
    }
  }
  const browsed = await fixture.tool("history_recall_browse");
  assert.equal(browsed.isError, false);
  const topics = browseSchema.parse(browsed.value).entries;
  assert.equal(topics.length, 2);
  const conversations: z.infer<typeof conversationSchema>[] = [];
  for (const topic of topics) {
    const members = await fixture.tool("history_recall_browse", { topic_id: topic.id });
    assert.equal(members.isError, false);
    const rows = z.object({ entries: z.array(conversationSchema) }).parse(members.value).entries;
    assert.equal(topic.member_count, rows.length);
    conversations.push(...rows);
  }
  const a = conversations.find(conversation => conversation.session_id === "source-a")!;
  const b = conversations.find(conversation => conversation.session_id === "source-b")!;
  const c = conversations.find(conversation => conversation.session_id === "source-c")!;
  assert(a && b && c);
  assert.equal(a.memberships[0].topic_id, firstTopic);
  assert.equal(a.memberships[0].topic_id, b.memberships[0].topic_id);
  assert.notEqual(a.memberships[0].topic_id, c.memberships[0].topic_id);
  assert.equal(a.source_cwd, fixture.cwds.a);
  assert.equal(b.source_cwd, fixture.cwds.b);
  assert.equal(c.source_cwd, fixture.cwds.c);

  const searched = await fixture.tool("history_recall_search", { queries: ["WAL fsync", "持久化失败"], topic_id: firstTopic });
  assert.equal(searched.isError, false);
  const hits = searchSchema.parse(searched.value).conversations;
  assert.deepEqual(hits.map(hit => hit.session_id).sort(), ["source-a", "source-b"]);
  const matched = hits.find(hit => hit.id === a.id)!;
  const read = await fixture.tool("history_recall_read_conversation", { conversation_id: a.id, entry_id: matched.matched_entry_ids[0] });
  assert.equal(read.isError, false);
  const evidence = evidenceSchema.parse(read.value);
  assert.equal(evidence.source_file, fixture.files.a);
  assert(evidence.fragments.some(fragment => fragment.text.includes("WAL fsync failed; writes must not be acknowledged")));
  assert.equal(evidence.fragments[0].sha256, a.memberships[0].evidence_refs[0].sha256);
  assert.equal(evidence.fragments[0].entry_id, a.memberships[0].evidence_refs[0].entry_id);
  assert(fixture.mainRequests.every(request => JSON.stringify(request.messages[0]) === firstSystem), "Indexing must not mutate the static system prompt");
  assert(!JSON.stringify(fixture.utilityRequests).includes("FOREIGN_PROFILE_SECRET"));
  assert.deepEqual(fixture.errors, []);
  assert(fixture.peak > 0 && fixture.peak <= fixture.concurrency);
  return {
    topics: topics.length, a_topic_id: a.memberships[0].topic_id, b_topic_id: b.memberships[0].topic_id,
    c_topic_id: c.memberships[0].topic_id, source_a_read: true, peak_calls: fixture.peak, concurrency: fixture.concurrency,
    fixture_calls: fixture.utilityRequests.length + fixture.nativeRequests.length,
    native_calls: fixture.nativeRequests.length, native_tool_sequence: fixture.nativeToolCalls.map(call => call.name), semantic_quality_evaluated: false,
  };
}

/** Standalone native SDK boundary: independent of store.apply/schema cutover. */
export async function exerciseNativeRepairBoundary(options: RuntimeFixtureOptions = {}) {
  const fixture = await createRuntimeFixture({ ...options, seedConversations: false, readyBanner: options.readyBanner ?? true });
  try {
    await fixture.session.prompt("Ordinary parent conversation before any native child: acknowledge without indexing.");
    assert.equal(fixture.mainRequests.length, 1);
    assert.equal(fixture.utilityRequests.length, 0);
    assert.equal(fixture.nativeRequests.length, 0, "An ordinary parent turn must not start a repair child");
    const result = await fixture.runNativeBoundary();
    assert(result.completion.proposal_id);
    assert.equal(result.repair.proposal.moves.length, 1);
    assert.equal(result.repair.coverage.length, 1);
    assert.equal(result.repair.coverage[0].memberCount, 1);
    assert.equal(result.repair.receipts.length, 1);
    assert.deepEqual([...new Set(fixture.nativeToolCalls.map(call => call.name))].sort(),
      ["repair_check", "repair_coverage", "repair_members", "repair_propose", "repair_read", "repair_topics"]);
    const nativeBeforeParent = fixture.nativeRequests.length;
    await fixture.session.prompt("Acknowledge the parent still works after its native child was disposed.");
    const catalog = await fixture.tool("history_recall_conversations");
    assert.equal(catalog.isError, false);
    assert.equal(fixture.nativeRequests.length, nativeBeforeParent, "The parent remains ordinary after child disposal");
    assert(fixture.nativePeak > 0 && fixture.nativePeak <= fixture.concurrency);
    assert.equal(result.calls, fixture.nativeRequests.length);
    assert.deepEqual(fixture.errors, []);
    return { native_boundary: true, parent_after_dispose: true, source_read: true,
      repair_tools_exposed_to_parent: false, child_tools_restricted: true, ordinary_parent_child_calls: 0,
      native_tool_sequence: fixture.nativeToolCalls.map(call => call.name), native_calls: fixture.nativeRequests.length,
      accounted_calls: result.calls, peak_calls: fixture.peak, concurrency: fixture.concurrency, semantic_quality_evaluated: false };
  } finally { await fixture.close(); }
}

async function indexFixtureFile(fixture: RuntimeFixture, file: string) {
  const indexed = await fixture.tool("history_recall_index", { file });
  assert.equal(indexed.isError, false, JSON.stringify(indexed.value));
  const result = z.object({ result: z.object({ completed: z.number(), failed: z.number(), calls: z.number(),
    topic_changes: z.object({ created: z.number(), updated: z.number(), merged: z.number(), reassigned: z.number() }),
  }) }).parse(indexed.value).result;
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  return result;
}

async function fixtureMemberships(fixture: RuntimeFixture) {
  const browsed = await fixture.tool("history_recall_browse");
  assert.equal(browsed.isError, false);
  const topics = browseSchema.parse(browsed.value).entries;
  const conversations: z.infer<typeof conversationSchema>[] = [];
  for (const topic of topics) {
    const members = await fixture.tool("history_recall_browse", { topic_id: topic.id });
    assert.equal(members.isError, false);
    const rows = z.object({ entries: z.array(conversationSchema) }).parse(members.value).entries;
    assert.equal(topic.member_count, rows.length);
    conversations.push(...rows);
  }
  assert.equal(new Set(conversations.map(conversation => conversation.id)).size, conversations.length, "Browse must not duplicate memberships");
  return { topics, conversations };
}

/** Full production runtime + native child + SQLite smoke; all providers and profiles are temporary. */
export async function exerciseNativeRepair() {
  const splitFixture = await createRuntimeFixture({ batchCalls: 100, readyBanner: true });
  let split: { original_topic_id: string; ui_topic_id: string; incoming_topic_id: string; repair_id: string };
  let splitCalls = 0;
  let splitAccounted = 0;
  let splitSequence: string[] = [];
  let peak = 0;
  try {
    await splitFixture.session.prompt("Ordinary parent conversation: do not index history.");
    assert.equal(splitFixture.nativeRequests.length, 0);
    assert.equal(splitFixture.utilityRequests.length, 0);
    await splitFixture.writeConversation(splitFixture.files.b, "source-b", splitFixture.cwds.b, "调整按钮间距和颜色");
    await splitFixture.writeConversation(splitFixture.files.c, "source-c", splitFixture.cwds.c, "WAL durable writes require successful fsync before acknowledgement");
    splitFixture.setSelectionMode("collapse");
    splitAccounted += (await indexFixtureFile(splitFixture, splitFixture.files.a)).calls;
    assert.equal(splitFixture.nativeRequests.length, 0);
    splitAccounted += (await indexFixtureFile(splitFixture, splitFixture.files.b)).calls;
    const before = await fixtureMemberships(splitFixture);
    assert.equal(before.topics.length, 1);
    const oldB = before.conversations.find(conversation => conversation.session_id === "source-b")!;
    assert(oldB);
    const originalId = before.topics[0].id;
    const db = openHistoryDatabase(splitFixture.store.dbPath);
    try {
      const oldEntries = db.query("SELECT * FROM hr_entries WHERE scope_id=? AND conversation_id=? ORDER BY id").all(splitFixture.scope.id, oldB.id);
      const oldFts = db.query("SELECT rowid,* FROM hr_search WHERE scope_id=? AND conversation_id=? ORDER BY rowid").all(splitFixture.scope.id, oldB.id);
      splitFixture.setRepairMode("split");
      const repaired = await indexFixtureFile(splitFixture, splitFixture.files.c);
      splitAccounted += repaired.calls;
      assert.equal(repaired.topic_changes.created, 1);
      assert.equal(repaired.topic_changes.reassigned, 1);
      assert.equal(repaired.topic_changes.updated, 1);
      const after = await fixtureMemberships(splitFixture);
      assert.equal(after.topics.length, 2);
      const a = after.conversations.find(conversation => conversation.session_id === "source-a")!;
      const b = after.conversations.find(conversation => conversation.session_id === "source-b")!;
      const c = after.conversations.find(conversation => conversation.session_id === "source-c")!;
      assert(a && b && c);
      assert.equal(a.memberships[0].topic_id, originalId);
      assert.equal(c.memberships[0].topic_id, originalId, "The incoming trigger must not be the historical-only UI child member");
      assert.notEqual(b.memberships[0].topic_id, originalId);
      assert.deepEqual(b.memberships[0].evidence_refs, oldB.memberships[0].evidence_refs);
      assert.deepEqual(db.query("SELECT * FROM hr_entries WHERE scope_id=? AND conversation_id=? ORDER BY id").all(splitFixture.scope.id, oldB.id), oldEntries);
      assert.deepEqual(db.query("SELECT rowid,* FROM hr_search WHERE scope_id=? AND conversation_id=? ORDER BY rowid").all(splitFixture.scope.id, oldB.id), oldFts);
      const events = db.query<{ kind: string; payload: string }, [string, number]>(
        "SELECT kind,payload FROM hr_topic_events WHERE scope_id=? AND revision=? ORDER BY id").all(splitFixture.scope.id, splitFixture.store.status().revision);
      assert(events.some(event => event.kind === "create") && events.some(event => event.kind === "move") && events.some(event => event.kind === "update"));
      const repairIds = [...new Set(events.map(event => z.object({ repair_id: z.string().min(1) }).parse(JSON.parse(event.payload)).repair_id))];
      assert.equal(repairIds.length, 1);
      split = { original_topic_id: originalId, ui_topic_id: b.memberships[0].topic_id, incoming_topic_id: c.memberships[0].topic_id, repair_id: repairIds[0] };
      const read = await splitFixture.tool("history_recall_read_conversation", { conversation_id: a.id, entry_id: a.memberships[0].evidence_refs[0].entry_id });
      assert.equal(read.isError, false);
      assert(evidenceSchema.parse(read.value).fragments.some(fragment => fragment.text.includes("WAL fsync failed; writes must not be acknowledged")));
    } finally { db.close(); }
    const nativeBeforeParent = splitFixture.nativeRequests.length;
    await splitFixture.session.prompt("The parent continues after native topic repair disposal.");
    assert.equal((await splitFixture.tool("history_recall_conversations")).isError, false);
    assert.equal(splitFixture.nativeRequests.length, nativeBeforeParent);
    assert(!JSON.stringify(splitFixture.requests).includes("FOREIGN_PROFILE_SECRET"));
    assert.deepEqual(splitFixture.errors, []);
    splitCalls = splitFixture.nativeRequests.length;
    splitSequence = splitFixture.nativeToolCalls.map(call => call.name);
    peak = splitFixture.peak;
    assert.equal(splitAccounted, splitFixture.utilityRequests.length + splitCalls);
  } finally { await splitFixture.close(); }

  const mergeFixture = await createRuntimeFixture({ batchCalls: 100 });
  try {
    await mergeFixture.session.prompt("Ordinary parent conversation before merge indexing: do not retrieve history.");
    assert.equal(mergeFixture.utilityRequests.length, 0);
    assert.equal(mergeFixture.nativeRequests.length, 0, "An ordinary parent turn must not start a repair child");
    await mergeFixture.writeConversation(mergeFixture.files.c, "source-c", mergeFixture.cwds.c, "Durable storage WAL writes must wait for successful fsync");
    let accounted = (await indexFixtureFile(mergeFixture, mergeFixture.files.a)).calls;
    const first = (await fixtureMemberships(mergeFixture)).topics[0].id;
    mergeFixture.setSelectionMode("distinct");
    accounted += (await indexFixtureFile(mergeFixture, mergeFixture.files.b)).calls;
    assert.equal((await fixtureMemberships(mergeFixture)).topics.length, 2);
    const db = openHistoryDatabase(mergeFixture.store.dbPath);
    try {
      const assignmentRows = db.query("SELECT conversation_id,facet_id,assigned_at,reason FROM hr_memberships WHERE scope_id=? ORDER BY conversation_id,facet_id").all(mergeFixture.scope.id);
      mergeFixture.setSelectionMode("normal");
      mergeFixture.setRepairMode("merge");
      const merged = await indexFixtureFile(mergeFixture, mergeFixture.files.c);
      accounted += merged.calls;
      assert.equal(merged.topic_changes.merged, 1, "One evidence-backed native run must merge without a second incoming vote");
      const after = await fixtureMemberships(mergeFixture);
      assert.equal(after.topics.length, 1);
      assert.equal(after.topics[0].id, first, "The earliest persisted topic ID survives");
      assert.equal(after.conversations.length, 3);
      const assignments = db.query("SELECT conversation_id,facet_id,assigned_at,reason FROM hr_memberships WHERE scope_id=? ORDER BY conversation_id,facet_id").all(mergeFixture.scope.id);
      for (const row of assignmentRows) assert(assignments.some(candidate => JSON.stringify(candidate) === JSON.stringify(row)), "Container merge must preserve original assignment time and reason");
      const nativeBeforeParent = mergeFixture.nativeRequests.length;
      await mergeFixture.session.prompt("The parent can still answer after the merge child was disposed.");
      assert.equal((await mergeFixture.tool("history_recall_conversations")).isError, false);
      assert.equal(mergeFixture.nativeRequests.length, nativeBeforeParent);
      assert.deepEqual(mergeFixture.errors, []);
      assert.equal(accounted, mergeFixture.utilityRequests.length + mergeFixture.nativeRequests.length);
      peak = Math.max(peak, mergeFixture.peak);
      assert(peak > 0 && peak <= mergeFixture.concurrency);
      return { historical_only_split: true, immediate_merge: true, source_original_readable: true,
        source_entries_fts_unchanged: true, parent_after_dispose: true, split: split!, merge_survivor: first,
        repair_tools_exposed_to_parent: false, child_tools_restricted: true, ordinary_parent_child_calls: 0,
        native_tool_sequence: [...splitSequence, ...mergeFixture.nativeToolCalls.map(call => call.name)],
        native_calls: splitCalls + mergeFixture.nativeRequests.length, accounted_calls: splitAccounted + accounted,
        peak_calls: peak, concurrency: mergeFixture.concurrency, semantic_quality_evaluated: false };
    } finally { db.close(); }
  } finally { await mergeFixture.close(); }
}
