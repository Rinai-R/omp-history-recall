import type { AssistantMessage, Context, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { inputBudget } from "./chunking";
import type { ModelBudget } from "./model-budget";
import type { RecallScope } from "./scope";
import { TopicDescriptorSchema, type JsonModel, type TopicDescriptor } from "./semantic";
import { digest, readSourceEvidence, RecallError, type EvidencePage, type SessionSource } from "./source";
import { extendCoverageDigest, repairViewId, startCoverageDigest, type TopicRegistry } from "./topic-registry";
import { modelCard, modelMember, type CursorUpdate, type IncomingConversation, type MemberFacet, type ModelMemberFacet, type TopicCard, type TopicSelection, type TopicSnapshot } from "./topics";

export const REPAIR_VERSION = "omp-topic-repair-v1";
const IdSchema = z.string().min(1);
const ReasonSchema = z.string().trim().min(1).max(500);
export const FacetRefSchema = z.object({ conversationId: IdSchema, sourceHash: IdSchema, facetId: IdSchema }).strict();
export const RepairDraftSchema = z.object({ ref: IdSchema.optional(), descriptor: TopicDescriptorSchema }).strict();
export const RepairMoveSchema = FacetRefSchema.extend({ fromTopicRef: IdSchema, targetRef: IdSchema, reason: ReasonSchema }).strict();
export const RepairUpdateSchema = z.object({ topicId: IdSchema, descriptor: TopicDescriptorSchema, reason: ReasonSchema }).strict();
export const RepairMergeSchema = z.object({ leftTopicId: IdSchema, rightTopicId: IdSchema, descriptor: TopicDescriptorSchema, reason: ReasonSchema }).strict();
export const RepairProposalSchema = z.object({
  drafts: z.array(RepairDraftSchema).max(5).default([]), updates: z.array(RepairUpdateSchema).max(5).default([]),
  moves: z.array(RepairMoveSchema).max(13).default([]), merge: RepairMergeSchema.nullable().default(null), reason: ReasonSchema,
}).strict();
export const RepairCompletionSchema = z.object({ proposal_id: IdSchema.nullable(), reason: ReasonSchema }).strict();
export type FacetRef = z.infer<typeof FacetRefSchema>;
export type RepairDraft = z.infer<typeof RepairDraftSchema>;
export type RepairMove = z.infer<typeof RepairMoveSchema>;
export type RepairUpdate = z.infer<typeof RepairUpdateSchema>;
export type RepairMerge = z.infer<typeof RepairMergeSchema>;
export type RepairProposal = z.infer<typeof RepairProposalSchema>;
export type RepairCompletion = z.infer<typeof RepairCompletionSchema>;
export type SourceGuard = { conversationId: string; sessionId: string; sourceHash: string; file: string };
export type CoverageProof = { targetRef: string; memberCount: number; digest: string };
export type MemberPage = { members: MemberFacet[]; nextCursor: string | null };
export type EvidenceReceipt = FacetRef & { entryId: string; entryHash: string; totalChars: number };
export type DeferredRepair = { conversation_id: string; code: string };
export type RepairTopicCard = TopicCard & { memberCount: number; hasActiveMembers: boolean };
export type ValidatedRepair = {
  proposal: RepairProposal; proposalId: string; coverage: CoverageProof[]; sourceGuards: SourceGuard[];
  receipts: EvidenceReceipt[]; cursorUpdates: CursorUpdate[];
};
export type RepairRunRequest = { protocol: RepairProtocol; budget: ModelBudget; signal?: AbortSignal };
export type RepairRunner = (request: RepairRunRequest) => Promise<RepairCompletion>;

const CursorSchema = z.string().min(1).max(8192).optional();
export const RepairTopicsSchema = z.object({ cursor: CursorSchema }).strict();
export const RepairMembersSchema = z.object({ topic_ref: IdSchema, cursor: CursorSchema }).strict();
export const RepairReadSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read"), conversation_id: IdSchema, facet_id: IdSchema, entry_id: IdSchema, cursor: CursorSchema,
    before: z.number().int().min(0).max(50).optional(), after: z.number().int().min(0).max(50).optional(),
    max_chars: z.number().int().min(1000).max(12000).optional(),
  }).strict(),
  z.object({ action: z.literal("remember"), conversation_id: IdSchema, facet_id: IdSchema, summary: z.string(), cursor: z.unknown().optional(), entry_id: z.unknown().optional() }).strict(),
]);
export const RepairCoverageSchema = z.object({ proposal_id: IdSchema, target_ref: IdSchema, cursor: CursorSchema }).strict();
export const RepairCheckSchema = z.object({
  proposal_id: IdSchema, page_id: IdSchema, target_ref: IdSchema.optional(),
  fits: z.array(z.object({ conversation_id: IdSchema, facet_id: IdSchema, fits: z.boolean() }).strict()).max(1),
}).strict();

type KnownFacet = FacetRef & { topicId: string; evidence: MemberFacet["evidence"] };
type EvidenceReadResult = Omit<EvidencePage, "source_file" | "session_id"> & { context?: { entry_id: string; before: number; after: number; alternate_children: string[] } };
type EntryProgress = { hash: string; total: number; ranges: [number, number][] };
type ReadRecord = { facetKey: string; sequence: number; entries: { entry_id: string; sha256: string; received_through: number; total_chars: number }[] };
type ToolRecord = { name: string; read?: ReadRecord; pageId?: string; facetKey?: string; retry?: true };
type CoverageTarget = {
  targetRef: string; descriptor: TopicDescriptor; allMembers: boolean; moveKeys: string[];
  count: number; digest: string; nextCursor: string | null; started: boolean; complete: boolean;
  pending?: { id: string; member?: MemberFacet; receipt?: EvidenceReceipt; cursor?: string; nextCursor: string | null; rawNext: string | null };
};
type ActiveProposal = { id: string; proposal: RepairProposal; targets: CoverageTarget[]; rejected: boolean };
const EMPTY_PROPOSAL: RepairProposal = { drafts: [], updates: [], moves: [], merge: null, reason: "No repair changes." };
const RETRY_READ = { retry_after_remember: true };
const TOOL_SCHEMAS: Record<string, z.ZodType<Record<string, unknown>>> = { repair_topics: RepairTopicsSchema, repair_members: RepairMembersSchema,
  repair_read: RepairReadSchema, repair_propose: RepairProposalSchema, repair_coverage: RepairCoverageSchema, repair_check: RepairCheckSchema };

function invalid(message: string): never { throw new RecallError("invalid_model_output", message); }
function key(value: Pick<FacetRef, "conversationId" | "facetId">): string { return `${value.conversationId}\0${value.facetId}`; }
function ref(value: FacetRef): FacetRef { return { conversationId: value.conversationId, sourceHash: value.sourceHash, facetId: value.facetId }; }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RecallError("cancelled", "History topic repair was cancelled.");
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalid(`Invalid repair tool arguments: ${parsed.error.message}`);
  return parsed.data;
}

/** A revision-bound evidence protocol. It never commits data or runs a model. */
export class RepairProtocol {
  readonly viewId: string;
  readonly inputBytes: number;
  private usableHistory = false;
  get modelBinding() { return this.binding; }
  get hasUsableHistory(): boolean { return this.usableHistory; }
  private readonly resultBytes: number;
  private prepared = false;
  private initialInput: unknown;
  private readonly knownTopics = new Set<string>();
  private readonly known = new Map<string, KnownFacet>();
  private auditMembers: MemberFacet[] = [];
  private auditSelection: MemberFacet[] = [];
  private cards: RepairTopicCard[] = [];
  private readonly guards = new Map<string, SourceGuard>();
  private readonly unavailable = new Map<string, DeferredRepair>();
  private readonly receipts = new Map<string, EvidenceReceipt>();
  private readonly progress = new Map<string, Map<string, EntryProgress>>();
  private readonly continuations = new Map<string, { sequence: number; entry_id: string; before: number; after: number; next_cursor: string | null; entries: ReadRecord["entries"] }>();
  private readonly notes = new Map<string, { summary: string; sequence: number }>();
  private readonly records = new Map<string, ToolRecord>();
  private readonly retiredPages = new Set<string>();
  private readonly coveredThrough = new Map<string, number>();
  private readonly reservations = new Map<string, number>();
  private readonly readOrder = new Map<string, { before: Promise<void>; release: () => void }>();
  private readonly issuedCursors = new Map<string, unknown>();
  private readonly finishedChecks = new Map<string, { fits: string; result: Record<string, unknown> }>();
  private active?: ActiveProposal;
  private sequence = 0;
  private contextBytes = 0;
  private binding?: Readonly<Pick<JsonModel, "identity" | "contextWindow" | "maxOutputTokens">>;

  constructor(
    readonly scope: RecallScope, private readonly registry: TopicRegistry, private readonly incoming: IncomingConversation,
    private readonly source: SessionSource, private readonly selection: TopicSelection, private readonly snapshot: TopicSnapshot,
    private readonly readSource: (conversationId: string, signal?: AbortSignal) => Promise<SessionSource>,
    limits: { inputBytes: number },
  ) {
    if (!Number.isSafeInteger(limits.inputBytes) || limits.inputBytes < 1) throw new RecallError("model_context_too_small", "Repair requires a positive input budget.");
    this.inputBytes = limits.inputBytes;
    this.resultBytes = Math.min(Math.floor(limits.inputBytes / 4), 48 * 1024 - 1);
    this.viewId = repairViewId(scope.id, snapshot.revision, incoming, selection);
  }

  bindModel(model: Pick<JsonModel, "identity" | "contextWindow" | "maxOutputTokens">): void {
    if (this.binding) throw new RecallError("invalid_model_output", "A repair model binding cannot be replaced.");
    if (inputBudget(model.contextWindow, model.maxOutputTokens) !== this.inputBytes) throw new RecallError("invalid_model_output", "Repair model limits differ from the analysis model limits.");
    this.binding = Object.freeze({ identity: model.identity, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens });
  }

  private rememberMember(member: MemberFacet): void {
    const memberKey = key(member);
    const previous = this.known.get(memberKey);
    if (previous && previous.sourceHash !== member.sourceHash) throw new RecallError("topic_state_changed", "A facet changed within the captured repair view.");
    if (!previous) this.known.set(memberKey, { ...ref(member), topicId: member.topicId, evidence: member.evidence });
  }

  private revision(): void { this.registry.assertRevision(this.snapshot.revision); }


  private defer(conversationId: string, error: unknown): undefined {
    if (error instanceof RecallError && ["cancelled", "topic_state_changed", "scope_mismatch", "wrong_scope", "invalid_scope", "active_session", "invalid_model_output"].includes(error.code)) throw error;
    if (this.guards.has(conversationId)) throw new RecallError("stale_evidence", "Previously healthy history changed during topic repair.");
    const code = error instanceof RecallError ? error.code : "source_unreadable";
    this.unavailable.set(conversationId, { conversation_id: conversationId, code });
    if (this.active && this.dependencies(this.active.proposal).some(item => item.conversation_id === conversationId)) this.active.rejected = true;
    return undefined;
  }

  private async healthy(member: KnownFacet | MemberFacet, signal?: AbortSignal): Promise<SessionSource | undefined> {
    checkSignal(signal);
    this.revision();
    if (member.conversationId === this.incoming.id) {
      if (this.source.fingerprint !== member.sourceHash) throw new RecallError("source_busy", "Incoming source changed during topic repair.");
      return this.source;
    }
    if (this.unavailable.has(member.conversationId)) return undefined;
    try {
      const source = await this.readSource(member.conversationId, signal);
      checkSignal(signal);
      this.revision();
      const old = this.guards.get(member.conversationId);
      if (source.fingerprint !== member.sourceHash || (old && (source.sessionId !== old.sessionId || source.file !== old.file))) {
        throw new RecallError("stale_evidence", "Original history no longer matches the indexed source revision.");
      }
      for (const evidence of member.evidence) {
        if (!source.entries.some(entry => entry.id === evidence.id && entry.hash === evidence.hash)) throw new RecallError("stale_evidence", "Indexed evidence is absent from the original source.");
      }
      this.guards.set(member.conversationId, { conversationId: member.conversationId, sessionId: source.sessionId, sourceHash: source.fingerprint, file: source.file });
      return source;
    } catch (error) { checkSignal(signal); return this.defer(member.conversationId, error); }
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    if (this.prepared) { this.revision(); checkSignal(signal); return; }
    checkSignal(signal);
    this.cards = this.registry.repairCards(this.snapshot.revision);
    const audit = this.registry.audit(this.selection, this.incoming, this.snapshot.revision);
    this.auditSelection = audit.members;
    for (const card of audit.topics) this.knownTopics.add(card.id);
    for (const draft of this.selection.newTopics) this.knownTopics.add(draft.ref);
    for (const assignment of this.selection.assignments) this.knownTopics.add(assignment.topicRef);
    for (const facet of this.incoming.analysis.facets) {
      const assignment = this.selection.assignments.find(item => item.facetId === facet.id);
      if (!assignment) invalid("Incoming selection is incomplete.");
      this.rememberMember({ conversationId: this.incoming.id, sourceHash: this.incoming.sourceHash, facetId: facet.id,
        descriptor: facet, evidence: facet.evidence_entry_ids.map(id => {
          const evidence = this.incoming.evidenceById.get(id); if (!evidence) invalid("Incoming evidence is missing."); return evidence;
        }), topicId: assignment.topicRef, assignedAt: null });
    }
    for (const member of audit.members) this.rememberMember(member);
    const prepared = await Promise.allSettled(audit.members.map(async member => { await this.healthy(member, signal); }));
    const failure = prepared.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    this.auditMembers = audit.members.filter(member => !this.unavailable.has(member.conversationId));
    this.usableHistory = this.auditMembers.length > 0;
    if (!this.usableHistory) {
      for (const card of this.cards) {
        let cursor: string | undefined;
        do {
          const page = this.registry.memberPage([card.id], this.incoming, this.selection, null, this.snapshot.revision, { cursor, limit: 64 });
          for (const member of page.members) {
            if (member.conversationId !== this.incoming.id && await this.healthy(member, signal)) { this.usableHistory = true; break; }
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor && !this.usableHistory);
        if (this.usableHistory) break;
      }
    }
    for (const member of audit.members) if (this.unavailable.has(member.conversationId)) this.known.delete(key(member));
    this.initialInput = {
      protocol: REPAIR_VERSION, view_id: this.viewId,
      incoming: { id: this.incoming.id, source_hash: this.incoming.sourceHash, analysis: this.incoming.analysis },
      selection: { assignments: this.selection.assignments, newTopics: this.selection.newTopics },
      topics: audit.topics.map(modelCard), audit: this.auditMembers.map(modelMember), unavailable: this.deferred(),
    };
    if (bytes(this.initialInput) > this.inputBytes) throw new RecallError("model_context_too_small", "The mandatory repair input exceeds the model input budget.");
    this.prepared = true;
  }

  input(): unknown {
    if (!this.prepared) throw new RecallError("repair_incomplete", "Repair protocol must be prepared before use.");
    return this.initialInput;
  }

  deferred(): DeferredRepair[] { return [...this.unavailable.values()].sort((a, b) => a.conversation_id.localeCompare(b.conversation_id) || a.code.localeCompare(b.code)); }

  private token(kind: string, data: unknown): string {
    const token = digest(JSON.stringify([REPAIR_VERSION, this.viewId, kind, data]));
    this.issuedCursors.set(token, data);
    return token;
  }

  private cursor<T>(kind: string, token: string, verify: (data: T) => boolean): T {
    const data = this.issuedCursors.get(token) as T | undefined;
    if (data === undefined || digest(JSON.stringify([REPAIR_VERSION, this.viewId, kind, data])) !== token || !verify(data)) throw new RecallError("invalid_cursor", "Repair cursor is outside this view or operation.");
    return data;
  }

  private allowance(id: string): number { return this.reservations.get(id) ?? this.resultBytes; }

  private bounded(value: unknown, id: string): unknown {
    if (bytes(value) > this.allowance(id)) throw new RecallError("model_context_too_small", "A complete repair tool envelope cannot fit the available model context.");
    return value;
  }

  prepareToolBatch(message: AssistantMessage): void {
    this.input();
    const calls = message.content.filter(part => part.type === "toolCall");
    if (calls.length > 32) invalid("A repair response may contain at most 32 tool calls.");
    if (calls.some(call => call.name === "yield") && calls.length !== 1) invalid("Terminal yield must be the only tool call in its response.");
    if (new Set(calls.map(call => call.id)).size !== calls.length) invalid("Repair tool call IDs must be unique.");
    this.reservations.clear();
    this.readOrder.clear();
    let previousRead = Promise.resolve();
    const minimum = bytes(RETRY_READ);
    let available = this.inputBytes - (this.contextBytes || bytes(this.input())) - bytes(message) - calls.length * (256 + minimum) - 1024;
    for (const call of calls) {
      if (call.name !== "yield") {
        const schema = TOOL_SCHEMAS[call.name];
        if (!Object.hasOwn(TOOL_SCHEMAS, call.name)) invalid("An unavailable tool was requested by topic repair.");
        call.arguments = parse(schema, call.arguments);
      }
      if (call.name === "repair_read" && call.arguments.action === "read") {
        const finished = Promise.withResolvers<void>();
        this.readOrder.set(call.id, { before: previousRead, release: () => finished.resolve() });
        previousRead = previousRead.then(() => finished.promise);
      }
      let ceiling = this.resultBytes;
      if (call.name === "repair_read" && call.arguments.action === "remember") {
        ceiling = bytes({ remembered: true, receipt: null });
        const conversationId = call.arguments.conversation_id;
        const facetId = call.arguments.facet_id;
        const member = typeof conversationId === "string" && typeof facetId === "string" ? this.known.get(key({ conversationId, facetId })) : undefined;
        // A preceding read in this batch may complete any of this facet's evidence entries.
        if (member) for (const evidence of member.evidence) ceiling = Math.max(ceiling, bytes({ remembered: true,
          receipt: { ...ref(member), entryId: evidence.id, entryHash: evidence.hash, totalChars: Number.MAX_SAFE_INTEGER } }));
      } else if (call.name === "repair_check") {
        ceiling = bytes({ checked: true, accepted: false, next_cursor: "0".repeat(64), member_count: Number.MAX_SAFE_INTEGER, digest: "0".repeat(64), complete: false });
      }
      const floor = call.name === "repair_check" || call.name === "repair_coverage" || (call.name === "repair_read" && call.arguments.action === "remember")
        ? ceiling : minimum;
      const allocation = Math.max(Math.min(floor, this.resultBytes), Math.min(this.resultBytes, ceiling, available + minimum));
      this.reservations.set(call.id, allocation);
      available -= allocation - minimum;
    }
  }

  tools(): ToolDefinition[] {
    const define = <T>(name: string, description: string, schema: z.ZodType<T>, run: (args: T, id: string, signal?: AbortSignal) => unknown | Promise<unknown>): ToolDefinition => ({
      name, label: name, description, parameters: z.toJSONSchema(schema), approval: "read", strict: true, loadMode: "essential",
      execute: async (id, args, signal) => {
        try {
          this.input(); checkSignal(signal); this.revision();
          const parsed = parse(schema, args);
          const result = await run(parsed, id, signal);
          checkSignal(signal); this.revision();
          let text: string;
          try {
            text = JSON.stringify(this.bounded(result, id));
          } catch (error) {
            if (error instanceof RecallError && error.code === "model_context_too_small" && name !== "repair_read") {
              text = JSON.stringify({ degraded: true, hint: "The full tool result exceeded the remaining context; repeat the call if you need its details." });
            } else throw error;
          }
          if (!this.records.has(id)) this.records.set(id, { name });
          return { content: [{ type: "text", text }], details: { protocol: REPAIR_VERSION, view_id: this.viewId } };
        } finally { this.readOrder.get(id)?.release(); }
      },
    });
    return [
      define("repair_topics", "Page the complete topic directory. Cursors are bound to this repair view.", RepairTopicsSchema, (args, id) => this.topicPage(args, id)),
      define("repair_members", "Page prospective initial members of a known topic, including incoming replacements.", RepairMembersSchema, (args, id) => this.members(args, id)),
      define("repair_read", "Read original same-branch evidence, or remember a rolling factual note. Read every byte of an evidence entry to earn a receipt; remember does not complete evidence.", RepairReadSchema, (args, id, signal) => this.read(args, id, signal)),
      define("repair_propose", "Stage one replacement proposal. Cover all returned targets with evidence and singleton fit checks before yielding its ID.", RepairProposalSchema, (args, id) => this.propose(args, id)),
      define("repair_coverage", "Read the next singleton final-membership proof page. Check it before advancing; confirm the empty EOF page too.", RepairCoverageSchema, (args, id) => this.coverage(args, id)),
      define("repair_check", "Confirm exactly the current proof member with a complete original-evidence receipt, or confirm empty EOF with fits:[].", RepairCheckSchema, (args, id) => this.check(args, id)),
    ];
  }

  private topicPage(args: z.infer<typeof RepairTopicsSchema>, id: string): unknown {
    let start = 0;
    if (args.cursor) {
      try { start = this.cursor<{ index: number }>("topics", args.cursor, value => Number.isInteger(value.index)).index; }
      catch (error) { if (error instanceof RecallError && error.code === "invalid_cursor") start = 0; else throw error; }
    }
    const topics: unknown[] = [];
    let index = start;
    const cards = this.registry.repairCards(this.snapshot.revision);
    const deferredTopics = this.deferredTopicIds();
    for (; index < cards.length && topics.length < 50; index++) {
      const card = cards[index];
      const value = { ...modelCard(card), member_count: card.memberCount, repairable: !card.hasActiveMembers && !deferredTopics.has(card.id) };
      const next = index + 1 < cards.length ? this.token("topics", { index: index + 1 }) : null;
      if (bytes({ topics: [...topics, value], next_cursor: next }) > this.allowance(id)) break;
      topics.push(value); this.knownTopics.add(card.id);
    }
    if (index === start && index < cards.length) throw new RecallError("model_context_too_small", "A topic card cannot fit the current context.");
    return { topics, next_cursor: index < cards.length ? this.token("topics", { index }) : null };
  }

  private members(args: z.infer<typeof RepairMembersSchema>, id: string): unknown {
    if (!this.knownTopics.has(args.topic_ref)) invalid("Read a topic card before requesting its members.");
    let rawCursor: string | undefined;
    if (args.cursor) {
      try {
        rawCursor = this.cursor<{ topic: string; cursor: string }>("members", args.cursor, value => value.topic === args.topic_ref).cursor;
      } catch (error) {
        if (!(error instanceof RecallError && error.code === "invalid_cursor")) throw error;
        rawCursor = undefined; // a foreign or stale token restarts this topic's paging
      }
    }
    if (this.active?.proposal.drafts.some(draft => draft.ref === args.topic_ref)) {
      if (args.cursor) throw new RecallError("invalid_cursor", "A repair draft has no initial members or continuation.");
      return { members: [], next_cursor: null };
    }
    let page: MemberPage;
    try {
      page = this.registry.memberPage([args.topic_ref], this.incoming, this.selection, null, this.snapshot.revision, { cursor: rawCursor, limit: 64 });
    } catch (error) {
      if (error instanceof RecallError && error.code === "invalid_cursor") {
        rawCursor = undefined;
        page = this.registry.memberPage([args.topic_ref], this.incoming, this.selection, null, this.snapshot.revision, { cursor: undefined, limit: 64 });
      } else throw error;
    }
    const members: ModelMemberFacet[] = [];
    // Cursor tokens always occupy 64 ASCII bytes; reserve their complete envelope before minting one.
    let used = bytes({ members: [], next_cursor: "0".repeat(64) });
    for (const member of page.members) {
      const projected = modelMember(member);
      const size = bytes(projected) + (members.length ? 1 : 0);
      if (used + size > this.allowance(id)) break;
      members.push(projected); used += size;
    }
    if (!members.length && page.members.length) throw new RecallError("model_context_too_small", "A complete member card cannot fit the current context.");
    if (members.length < page.members.length) page = this.registry.memberPage([args.topic_ref], this.incoming, this.selection, null, this.snapshot.revision, { cursor: rawCursor, limit: members.length });
    for (const member of page.members) this.rememberMember(member);
    return { members, next_cursor: page.nextCursor ? this.token("members", { topic: args.topic_ref, cursor: page.nextCursor }) : null };
  }

  private async read(args: z.infer<typeof RepairReadSchema>, id: string, signal?: AbortSignal): Promise<unknown> {
    const facetKey = key({ conversationId: args.conversation_id, facetId: args.facet_id });
    const member = this.known.get(key({ conversationId: args.conversation_id, facetId: args.facet_id }));
    if (!member) invalid("Evidence may only be read for an incoming, audit, or delivered member facet.");
    if (args.action === "remember") {
      if (!this.progress.get(facetKey)?.size) invalid("A factual note requires previously delivered original evidence.");
      const summary = args.summary.trim().slice(0, 500);
      if (!summary) invalid("A factual note cannot be empty.");
      this.notes.set(facetKey, { summary, sequence: ++this.sequence });
      this.records.set(id, { name: "repair_read", facetKey });
      return { remembered: true, receipt: this.receipts.get(facetKey) ?? null };
    }
    if (this.allowance(id) < 1600) {
      this.records.set(id, { name: "repair_read", retry: true });
      return RETRY_READ;
    }
    const source = await this.healthy(member, signal);
    if (!source) return { unavailable: this.unavailable.get(member.conversationId) };
    await this.readOrder.get(id)?.before;
    checkSignal(signal);
    this.revision();
    // Resolve the entry: explicit and present wins; an in-flight continuation or the
    // facet's first cited evidence follows; a foreign reference falls back the same way.
    const belongs = (id: string | undefined) => !!id && source.entries.some(entry => entry.id === id);
    const entryId = belongs(args.entry_id) ? args.entry_id!
      : belongs(this.continuations.get(`${member.conversationId}\0${member.facetId}`)?.entry_id) ? this.continuations.get(`${member.conversationId}\0${member.facetId}`)!.entry_id!
      : member.evidence.find(evidence => belongs(evidence.id))?.id;
    if (!entryId) {
      invalid("The requested original entry does not belong to this conversation.");
    }
    const binding = { conversation: member.conversationId, source: member.sourceHash, facet: member.facetId, entry: entryId, before: args.before ?? 0, after: args.after ?? 0 };
    let rawCursor: string | undefined;
    if (args.cursor) {
      try {
        rawCursor = this.cursor<{ binding: typeof binding; cursor: string }>("read", args.cursor, value => JSON.stringify(value.binding) === JSON.stringify(binding)).cursor;
      } catch (error) {
        if (!(error instanceof RecallError && error.code === "invalid_cursor")) throw error;
        rawCursor = undefined; // restart from the resolved entry start
      }
    }
    let maximum = args.max_chars ?? 4000;
    let result: EvidenceReadResult;
    for (;;) {
      const { source_file: _file, session_id: _session, ...page } = readSourceEvidence(this.scope.id, source, {
        entry_id: binding.entry, before: binding.before, after: binding.after, cursor: rawCursor, maxChars: maximum,
      });
      result = { ...page, next_cursor: page.next_cursor ? this.token("read", { binding, cursor: page.next_cursor }) : null };
      if (bytes(result) <= this.allowance(id)) break;
      if (maximum === 1000) throw new RecallError("model_context_too_small", "The minimum original-evidence page cannot fit the current context.");
      maximum = Math.max(1000, Math.floor(maximum / 2));
    }
    const sequence = ++this.sequence;
    const entries: ReadRecord["entries"] = [];
    for (const fragment of result.fragments) {
      let entryMap = this.progress.get(facetKey);
      if (!entryMap) { entryMap = new Map(); this.progress.set(facetKey, entryMap); }
      let progress = entryMap.get(fragment.entry_id);
      if (!progress) { progress = { hash: fragment.sha256, total: fragment.total_chars, ranges: [] }; entryMap.set(fragment.entry_id, progress); }
      if (progress.hash !== fragment.sha256 || progress.total !== fragment.total_chars) throw new RecallError("stale_evidence", "Previously delivered original evidence changed.");
      progress.ranges.push([fragment.offset, fragment.offset + fragment.text.length]);
      progress.ranges.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const range of progress.ranges) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]);
      }
      progress.ranges = merged;
      const received = progress.ranges[0]?.[0] === 0 ? progress.ranges[0][1] : 0;
      entries.push({ entry_id: fragment.entry_id, sha256: fragment.sha256, received_through: received, total_chars: fragment.total_chars });
      if (received === fragment.total_chars && member.evidence.some(evidence => evidence.id === fragment.entry_id && evidence.hash === fragment.sha256) && !this.receipts.has(facetKey)) {
        this.receipts.set(facetKey, { ...ref(member), entryId: fragment.entry_id, entryHash: fragment.sha256, totalChars: fragment.total_chars });
      }
    }
    this.continuations.set(facetKey, { sequence, entry_id: args.entry_id, before: binding.before, after: binding.after, next_cursor: result.next_cursor, entries });
    this.records.set(id, { name: "repair_read", read: { facetKey, sequence, entries } });
    return result;
  }

  private deferredTopicIds(): Set<string> {
    const topics = new Set<string>();
    if (!this.unavailable.size) return topics;
    for (const card of this.cards) {
      let cursor: string | undefined;
      do {
        const page = this.registry.memberPage([card.id], this.incoming, this.selection, null, this.snapshot.revision, { cursor, limit: 64 });
        if (page.members.some(member => this.unavailable.has(member.conversationId))) { topics.add(card.id); break; }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    return topics;
  }

  private dependencies(proposal: RepairProposal): DeferredRepair[] {
    if (!this.unavailable.size) return [];
    const ids = new Set(proposal.moves.map(move => move.conversationId));
    const topics = new Set([...proposal.updates.map(update => update.topicId), ...(proposal.merge ? [proposal.merge.leftTopicId, proposal.merge.rightTopicId] : []),
      ...proposal.moves.map(move => move.targetRef).filter(targetRef => this.cards.some(card => card.id === targetRef))]);
    for (const topic of topics) {
      let cursor: string | undefined;
      do {
        const page = this.registry.memberPage([topic], this.incoming, this.selection, null, this.snapshot.revision, { cursor, limit: 64 });
        for (const member of page.members) if (this.unavailable.has(member.conversationId)) ids.add(member.conversationId);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    return this.deferred().filter(item => ids.has(item.conversation_id));
  }

  private propose(proposal: RepairProposal, id: string): unknown {
    for (const update of proposal.updates) if (!this.knownTopics.has(update.topicId)) invalid("An updated topic must first have been read.");
    if (proposal.merge && (!this.knownTopics.has(proposal.merge.leftTopicId) || !this.knownTopics.has(proposal.merge.rightTopicId))) invalid("Both merged topic cards must first have been read.");
    // Canonicalize draft refs by array order and remap move targets that cite them.
    const draftRefMap = new Map(proposal.drafts.map((draft, index) => [draft.ref ?? `repair:${index}`, `repair:${index}`]));
    for (const draft of proposal.drafts) draft.ref = draft.ref ?? draftRefMap.get(draft.ref!)!;
    for (const move of proposal.moves) {
      const mapped = move.targetRef.startsWith("repair:") ? draftRefMap.get(move.targetRef) : undefined;
      if (mapped) move.targetRef = mapped;
    }
    const drafts = new Set([...draftRefMap.values()]);
    for (const move of proposal.moves) {
      const member = this.known.get(key(move));
      if (!member) return { accepted: false, reason: `No delivered membership matches facet ${move.conversationId}/${move.facetId}. Read the topic members first.` };
      if (member.sourceHash !== move.sourceHash || member.topicId !== move.fromTopicRef) {
        return { accepted: false, reason: `Facet ${move.conversationId}/${move.facetId} was delivered with source ${member.sourceHash.slice(0, 8)} in ${member.topicId}, not ${move.sourceHash.slice(0, 8)} in ${move.fromTopicRef}.` };
      }
      if (!this.knownTopics.has(move.targetRef) && !drafts.has(move.targetRef)) return { accepted: false, reason: `Move target ${move.targetRef} was never read or declared as a draft.` };
    }
    let normalized;
    try {
      normalized = this.registry.normalizeRepairProposal(this.selection, this.incoming, proposal, this.snapshot.revision);
    } catch (error) {
      // Active-member violations are integrity failures and stay fatal; other malformed
      // proposal shapes are model mistakes the child can retry.
      if (error instanceof RecallError && error.code === "invalid_model_output" && !/active/i.test(error.message)) {
        return { accepted: false, reason: error.message };
      }
      throw error;
    }
    const unavailable = this.dependencies(normalized);
    if (unavailable.length) { this.active = undefined; return { accepted: false, unavailable }; }
    const proposalId = digest(JSON.stringify(["repair-plan-v1", this.viewId, normalized]));
    const targets = this.registry.repairCoverageTargets(this.selection, this.incoming, normalized, this.snapshot.revision).map(target => ({
      ...target, count: 0, digest: startCoverageDigest(this.viewId, proposalId, target.targetRef, target.descriptor),
      nextCursor: null, started: false, complete: false,
    }));
    const result = { accepted: true, proposal_id: proposalId, coverage_targets: targets.map(target => ({ target_ref: target.targetRef, descriptor: target.descriptor, all_members: target.allMembers })) };
    this.bounded(result, id);
    this.active = { id: proposalId, proposal: normalized, targets, rejected: false };
    this.finishedChecks.clear();
    for (const draft of normalized.drafts) this.knownTopics.add(draft.ref ?? `repair:${normalized.drafts.indexOf(draft)}`);
    return result;
  }

  private proposal(id: string): ActiveProposal {
    if (!this.active || this.active.id !== id) invalid("Only the latest accepted proposal can be checked.");
    return this.active;
  }

  private coverage(args: z.infer<typeof RepairCoverageSchema>, id: string): unknown {
    const active = this.proposal(args.proposal_id);
    const target = active.targets.find(item => item.targetRef === args.target_ref);
    if (!target) invalid("The requested target has no coverage obligation.");
    if (target.pending) {
      if (args.cursor !== target.pending.cursor) invalid("Confirm the current proof page before advancing coverage.");
      this.records.set(id, { name: "repair_coverage", pageId: target.pending.id });
      return this.bounded(this.coverageResult(active, target), id);
    }
    if (target.complete) return this.bounded({ proposal_id: active.id, target_ref: target.targetRef, descriptor: target.descriptor, members: [], page_id: "complete", next_cursor: null, complete: true, member_count: target.count, digest: target.digest }, id);
    if (target.started && args.cursor !== target.nextCursor) invalid("Coverage cursor skipped or repeated a confirmed page.");
    if (!target.started && args.cursor !== undefined) throw new RecallError("invalid_cursor", "Coverage starts without a cursor.");
    let rawCursor: string | undefined;
    if (args.cursor) rawCursor = this.cursor<{ proposal: string; target: string; cursor: string | null }>("coverage", args.cursor, value => value.proposal === active.id && value.target === target.targetRef).cursor ?? undefined;
    let member: MemberFacet | undefined;
    let next: string | null = null;
    // A null native continuation after a real member denotes the required explicit EOF page.
    const atEof = target.started && args.cursor && this.cursor<{ proposal: string; target: string; cursor: string | null }>("coverage", args.cursor, value => value.proposal === active.id && value.target === target.targetRef).cursor === null;
    if (!atEof) {
      do {
        const page = this.registry.memberPage([target.targetRef], this.incoming, this.selection, active.proposal, this.snapshot.revision, { cursor: rawCursor, limit: 1 });
        member = page.members[0]; next = page.nextCursor;
        if (!member || target.allMembers || target.moveKeys.includes(key(member))) break;
        member = undefined; rawCursor = next ?? undefined;
      } while (next);
    }
    const nextCursor = member ? this.token("coverage", { proposal: active.id, target: target.targetRef, cursor: next }) : null;
    const pageId = digest(JSON.stringify(["repair-page-v1", this.viewId, active.id, target.targetRef, args.cursor ?? null, member ? ref(member) : null]));
    target.pending = { id: pageId, member, receipt: member ? this.receipts.get(key(member)) : undefined, cursor: args.cursor, nextCursor, rawNext: next };
    target.started = true;
    if (member) this.rememberMember(this.known.has(key(member)) ? member : this.registry.initialMember(ref(member), this.incoming, this.selection, this.snapshot.revision));
    this.records.set(id, { name: "repair_coverage", pageId });
    return this.bounded(this.coverageResult(active, target), id);
  }

  private coverageResult(active: ActiveProposal, target: CoverageTarget): unknown {
    const page = target.pending!;
    return { proposal_id: active.id, target_ref: target.targetRef, descriptor: target.descriptor,
      members: page.member ? [modelMember(page.member)] : [], receipt: page.receipt ?? null, page_id: page.id, next_cursor: page.nextCursor };
  }

  private check(args: z.infer<typeof RepairCheckSchema>, id: string): unknown {
    const active = this.proposal(args.proposal_id);
    const previous = this.finishedChecks.get(args.page_id);
    if (previous) { return { ...previous.result, note: previous.fits !== JSON.stringify(args.fits) ? "This page was already confirmed; the original confirmation stands." : undefined }; }
    const target = active.targets.find(item => item.pending?.id === args.page_id);
    if (!target?.pending) {
      const anyTarget = args.target_ref ? active.targets.find(item => item.targetRef === args.target_ref) : undefined;
      if (args.page_id === "complete" && anyTarget?.complete) {
        return { checked: true, accepted: !active.rejected, member_count: anyTarget.count, digest: anyTarget.digest, complete: true, next_cursor: null };
      }
      invalid("The proof page is not pending in the active proposal.");
    }
    const page = target.pending;
    const member = page.member;
    if (member) {
      if (args.fits.length !== 1 || args.fits[0].conversation_id !== member.conversationId || args.fits[0].facet_id !== member.facetId) invalid("A fit check must name exactly the pending member.");
      const receipt = this.receipts.get(key(member));
      if (!receipt || receipt.sourceHash !== member.sourceHash) invalid("A fit check requires a complete, matching original evidence receipt.");
      if (this.unavailable.has(member.conversationId)) invalid("Unavailable original evidence cannot satisfy a fit check.");
      if (!args.fits[0].fits) active.rejected = true;
      else { target.count++; target.digest = extendCoverageDigest(target.digest, member, receipt, target.targetRef); }
      this.coveredThrough.set(key(member), this.sequence);
    } else {
      if (args.fits.length) invalid("An empty EOF page requires fits:[].");
      target.complete = true;
    }
    this.retiredPages.add(page.id);
    target.nextCursor = page.nextCursor;
    target.pending = undefined;
    const result = { checked: true, accepted: !active.rejected, next_cursor: target.nextCursor, member_count: target.count, digest: target.digest, complete: target.complete };
    this.bounded(result, id);
    this.records.set(id, { name: "repair_check", pageId: page.id });
    this.finishedChecks.set(page.id, { fits: JSON.stringify(args.fits), result: result as Record<string, unknown> });
    return result;
  }

  private auditPending(facetKey: string): boolean { return this.auditMembers.some(member => key(member) === facetKey) && !this.receipts.has(facetKey); }

  private compact(record: ToolRecord): unknown | undefined {
    if (record.retry) return RETRY_READ;
    if (record.read) {
      const read = record.read;
      if ((this.coveredThrough.get(read.facetKey) ?? -1) >= read.sequence && !this.auditPending(read.facetKey)) return { evidence_confirmed: true };
      const note = this.notes.get(read.facetKey);
      if (note && note.sequence >= read.sequence) return { fragments: read.entries.map(entry => ({ ...entry, summary: note.summary })) };
    }
    if (record.pageId && this.retiredPages.has(record.pageId)) return { proof_confirmed: true };
    if (record.facetKey && this.notes.has(record.facetKey)) return { remembered: true };
    return undefined;
  }

  private state(): unknown {
    const audited = new Set(this.auditMembers.map(key));
    return {
      protocol_state: REPAIR_VERSION, view_id: this.viewId,
      proposal: this.active ? { proposal_id: this.active.id, proposal: this.active.proposal } : null,
      audit: this.auditMembers.map(member => ({ conversation_id: member.conversationId, source_hash: member.sourceHash, facet_id: member.facetId, receipt: this.receipts.get(key(member)) ?? null })),
      receipts: [...this.receipts.entries()].filter(([facetKey]) => !audited.has(facetKey) && !this.coveredThrough.has(facetKey)).map(([, receipt]) => receipt),
      reads: [...this.continuations.entries()].filter(([facetKey, continuation]) => (continuation.next_cursor !== null || !this.receipts.has(facetKey)) && (continuation.sequence > (this.coveredThrough.get(facetKey) ?? -1) || this.auditPending(facetKey))).map(([facetKey, continuation]) => {
        const member = this.known.get(facetKey)!;
        return { conversation_id: member.conversationId, source_hash: member.sourceHash, facet_id: member.facetId,
          entry_id: continuation.entry_id, before: continuation.before, after: continuation.after, next_cursor: continuation.next_cursor, entries: continuation.entries };
      }),
      notes: [...this.notes.entries()].filter(([facetKey, note]) => note.sequence > (this.coveredThrough.get(facetKey) ?? -1) || this.auditPending(facetKey)).map(([facetKey, note]) => {
        const member = this.known.get(facetKey)!;
        return { conversation_id: member.conversationId, source_hash: member.sourceHash, facet_id: member.facetId, summary: note.summary };
      }),
      coverage: this.active?.targets.map(target => ({ target_ref: target.targetRef, member_count: target.count, digest: target.digest,
        next_cursor: target.nextCursor, complete: target.complete, pending: target.pending ? this.coverageResult(this.active!, target) : null })) ?? [],
      unavailable: this.deferred(),
    };
  }

  providerContext(context: Context): Context {
    this.input(); this.revision();
    const messages: Message[] = [];
    const initial = JSON.stringify(this.initialInput);
    const exchanges: { assistant: AssistantMessage; results: ToolResultMessage[]; end: number }[] = [];
    for (let index = 0; index < context.messages.length; index++) {
      const message = context.messages[index];
      if (message.role !== "assistant") continue;
      const calls = message.content.filter(part => part.type === "toolCall");
      if (!calls.length) continue;
      const results: ToolResultMessage[] = [];
      let end = index + 1;
      while (end < context.messages.length && context.messages[end].role === "toolResult") results.push(context.messages[end++] as ToolResultMessage);
      if (results.length === calls.length && calls.every(call => results.some(result => result.toolCallId === call.id))) exchanges.push({ assistant: message, results, end });
    }
    const last = exchanges.at(-1);
    const exchangeByAssistant = new Map(exchanges.map(exchange => [exchange.assistant, exchange]));
    for (let index = 0; index < context.messages.length; index++) {
      const message = context.messages[index];
      if (message.role === "developer" && typeof message.content === "string") {
        if (message.content === initial) {
          const input = this.initialInput as Record<string, unknown>;
          messages.push({ ...message, content: JSON.stringify({ ...input, audit: this.auditMembers.map(member => {
            const receipt = this.receipts.get(key(member)); const note = this.notes.get(key(member));
            return receipt && (note || this.coveredThrough.has(key(member))) ? { conversation_id: member.conversationId, source_hash: member.sourceHash, facet_id: member.facetId, receipt: true } : modelMember(member);
          }) }) });
          continue;
        }
        try { if (JSON.parse(message.content)?.protocol_state === REPAIR_VERSION) continue; } catch {}
      }
      const exchange = message.role === "assistant" ? exchangeByAssistant.get(message) : undefined;
      if (!exchange || exchange === last) { messages.push(message); continue; }
      const replacements = exchange.results.map(result => { const record = this.records.get(result.toolCallId); return record ? this.compact(record) : undefined; });
      if (replacements.every(value => value !== undefined)) { index = exchange.end - 1; continue; }
      messages.push(message);
      exchange.results.forEach((result, position) => messages.push(replacements[position] === undefined ? result : { ...result, content: [{ type: "text", text: JSON.stringify(replacements[position]) }], details: undefined }));
      index = exchange.end - 1;
    }
    messages.splice(Math.min(1, messages.length), 0, { role: "developer", content: JSON.stringify(this.state()), synthetic: true, timestamp: 0 });
    const result: Context = { ...context, messages, tools: context.tools?.map(tool => ({
      name: tool.name, description: tool.description, parameters: tool.parameters, strict: tool.strict,
      deferLoading: tool.deferLoading, customFormat: tool.customFormat, customWireName: tool.customWireName,
      native: tool.native, examples: tool.examples,
    })) };
    this.contextBytes = bytes(result);
    if (this.contextBytes > this.inputBytes) throw new RecallError("model_context_too_small", "Unacknowledged repair evidence and required protocol state exceed the model context. Remember evidence before continuing.");
    return result;
  }

  progressDigest(): string {
    return digest(JSON.stringify({ view: this.viewId,
      progress: [...this.progress.entries()].map(([facet, entries]) => [facet, [...entries.entries()]]),
      notes: [...this.notes.entries()].map(([facet, note]) => [facet, note.summary]),
      proposal: this.active ? [this.active.id, this.active.rejected, this.active.targets.map(target => [target.targetRef, target.count, target.digest, target.nextCursor, target.complete, target.pending?.id])] : null,
      cursors: [...this.issuedCursors.keys()], unavailable: this.deferred(),
    }));
  }

  finalize(completion: RepairCompletion): ValidatedRepair {
    parse(RepairCompletionSchema, completion); this.input(); this.revision();
    for (const member of this.auditMembers) if (!this.receipts.has(key(member))) {
      invalid("Every healthy mandatory audit facet requires a complete original evidence receipt.");
    }
    let proposal: RepairProposal;
    let proposalId: string;
    let coverage: CoverageProof[];
    if (completion.proposal_id === null) {
      proposal = this.registry.normalizeRepairProposal(this.selection, this.incoming, EMPTY_PROPOSAL, this.snapshot.revision);
      proposalId = digest(JSON.stringify(["repair-plan-v1", this.viewId, proposal])); coverage = [];
    } else {
      const active = this.proposal(completion.proposal_id);
      if (active.rejected || active.targets.some(target => !target.complete || target.pending)) invalid("The proposal has rejected, pending, or incomplete exhaustive coverage.");
      const unavailable = this.dependencies(active.proposal);
      if (unavailable.length) invalid("The proposal depends on unavailable historical sources.");
      proposal = active.proposal; proposalId = active.id;
      coverage = active.targets.map(target => ({ targetRef: target.targetRef, memberCount: target.count, digest: target.digest }));
    }
    const blocked = this.deferredTopicIds();
    const cursors = new Map<string, CursorUpdate>();
    for (const member of this.auditSelection) if (!blocked.has(member.topicId)) cursors.set(member.topicId, { topicId: member.topicId, afterFacetKey: key(member) });
    const result: ValidatedRepair = { proposal, proposalId, coverage, sourceGuards: [...this.guards.values()], receipts: [...this.receipts.values()], cursorUpdates: [...cursors.values()] };
    this.registry.assertRepairPlan(this.selection, this.incoming, result, this.snapshot.revision);
    return result;
  }
}
