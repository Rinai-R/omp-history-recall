import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { digest, RecallError, type EvidenceRef } from "./source";
import type {
  ClusterPlan, IncomingConversation, MemberFacet, TopicCard, TopicChangeCounts, TopicSelection, TopicSnapshot,
} from "./topics";
import type { TopicDescriptor } from "./semantic";
import type { EvidenceReceipt, FacetRef, MemberPage, RepairProposal, RepairTopicCard, ValidatedRepair } from "./repair";

type Descriptor = Pick<TopicCard, "title" | "description" | "aliases">;
type Bind = string | number | null;
type TopicRow = { id: string; title: string; description: string; aliases: string; created_at: string; review_cursor: string | null };
type MemberRow = {
  conversation_id: string; source_hash: string; facet_id: string; title: string; description: string;
  aliases: string; evidence: string; topic_id: string; assigned_at: string; reason: string;
};
type StoredMember = MemberFacet & { reason: string };
type PreparedIncoming = {
  id: string; sourceHash: string; revision: number; oldSourceHash: string | null; members: StoredMember[];
};
type RepairMemberMove = { member: MemberFacet; targetRef: string; reason: string };
type RepairState = {
  cards: Map<string, TopicCard>; incoming: MemberFacet[]; moves: RepairMemberMove[];
  proposal: RepairProposal; merge: { survivor: string; source: string } | null;
};
export type RepairCoverageTarget = { targetRef: string; descriptor: TopicDescriptor; allMembers: boolean; moveKeys: string[] };
type MemberFilter = { after?: string; through?: string };

const MAX_REVIEW_FACETS = 8;
const MEMBER_SQL = `SELECT c.id AS conversation_id,c.source_hash,f.id AS facet_id,
  f.title,f.description,f.aliases,f.evidence,m.topic_id,m.assigned_at,m.reason
  FROM hr_memberships m
  JOIN hr_conversations c ON c.scope_id=m.scope_id AND c.id=m.conversation_id
  JOIN hr_facets f ON f.scope_id=m.scope_id AND f.conversation_id=m.conversation_id AND f.id=m.facet_id`;

function changed(message: string): never {
  throw new RecallError("topic_state_changed", message);
}

function key(member: Pick<MemberFacet, "conversationId" | "facetId">): string {
  return `${member.conversationId}\0${member.facetId}`;
}

function tuple(value: string): [string, string] {
  const at = value.indexOf("\0");
  if (at < 1 || at === value.length - 1 || value.indexOf("\0", at + 1) !== -1) changed("Invalid topic member key.");
  return [value.slice(0, at), value.slice(at + 1)];
}


function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCards(left: TopicCard, right: TopicCard): number {
  if (left.createdAt === null && right.createdAt !== null) return 1;
  if (left.createdAt !== null && right.createdAt === null) return -1;
  return compareText(left.createdAt ?? "", right.createdAt ?? "") || compareText(left.id, right.id);
}

function compareMembers(left: MemberFacet, right: MemberFacet): number {
  return compareText(left.conversationId, right.conversationId) || compareText(left.facetId, right.facetId);
}

function descriptor(card: Descriptor): Descriptor {
  return { title: card.title, description: card.description, aliases: [...card.aliases] };
}

function validateDescriptor(value: Descriptor): void {
  if (!value || typeof value.title !== "string" || value.title !== value.title.trim() || !value.title.length || value.title.length > 100
    || typeof value.description !== "string" || value.description !== value.description.trim() || !value.description.length || value.description.length > 500
    || !Array.isArray(value.aliases) || value.aliases.length > 24
    || value.aliases.some(alias => typeof alias !== "string" || alias !== alias.trim() || !alias.length || alias.length > 100)) {
    changed("A topic descriptor is outside the validated descriptor domain.");
  }
}

function sameDescriptor(left: Descriptor, right: Descriptor): boolean {
  return left.title === right.title && left.description === right.description && JSON.stringify(left.aliases) === JSON.stringify(right.aliases);
}


function topic(row: TopicRow): TopicCard {
  return { id: row.id, title: row.title, description: row.description, aliases: JSON.parse(row.aliases), createdAt: row.created_at };
}

function member(row: MemberRow): StoredMember {
  return {
    conversationId: row.conversation_id, sourceHash: row.source_hash, facetId: row.facet_id,
    descriptor: { title: row.title, description: row.description, aliases: JSON.parse(row.aliases) },
    evidence: JSON.parse(row.evidence), topicId: row.topic_id, assignedAt: row.assigned_at, reason: row.reason,
  };
}

function evidence(members: readonly MemberFacet[]): EvidenceRef[] {
  const refs = new Map<string, EvidenceRef>();
  for (const item of members) for (const ref of item.evidence) refs.set(`${ref.id}\0${ref.hash}`, ref);
  return [...refs.values()];
}
export function repairViewId(scopeId: string, revision: number, incoming: IncomingConversation, selection: TopicSelection): string {
  return digest(JSON.stringify([scopeId, revision, incoming.id, incoming.sourceHash, selection]));
}

export function startCoverageDigest(viewId: string, proposalId: string, targetRef: string, finalDescriptor: TopicDescriptor): string {
  return digest(JSON.stringify(["repair-coverage-v1", viewId, proposalId, targetRef, finalDescriptor]));
}

export function extendCoverageDigest(previous: string, value: MemberFacet, receipt: EvidenceReceipt, targetRef: string): string {
  return digest(JSON.stringify([previous, value.conversationId, value.sourceHash, value.facetId, targetRef,
    value.descriptor, value.evidence, receipt.entryId, receipt.entryHash, receipt.totalChars]));
}

function invalidRepair(message: string, code = "invalid_model_output"): never {
  throw new RecallError(code, message);
}

function repairReason(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500) invalidRepair("A repair reason must contain 1–500 characters.");
  return value.trim();
}

function repairDescriptor(value: Descriptor, previous: readonly Descriptor[] = []): Descriptor {
  validateDescriptor(value);
  const aliases: string[] = [];
  const seen = new Set<string>();
  const retained = [...previous.map(item => item.title), ...previous.flatMap(item => item.aliases)];
  for (const alias of [...retained, ...value.aliases]) {
    const normalized = alias.trim().normalize("NFKC").toLowerCase().replace(/\s+/gu, " ");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push(alias.trim());
    if (aliases.length === 24) break;
  }
  return { title: value.title, description: value.description, aliases };
}

function repairProposalId(viewId: string, proposal: RepairProposal): string {
  return digest(JSON.stringify(["repair-plan-v1", viewId, proposal]));
}

/** SQL-only clustering state. Model work is always performed outside this class's transactions. */
export class TopicRegistry {
  private prepared: PreparedIncoming | undefined;

  constructor(private readonly db: Database, private readonly scopeId: string, private readonly excludedSessionId?: string) {}

  private revision(): number {
    const row = this.db.query<{ revision: number }, [string]>("SELECT revision FROM hr_scopes WHERE scope_id=?").get(this.scopeId);
    if (!row) changed("The recall scope no longer exists.");
    return row.revision;
  }

  private checkRevision(expected: number): void {
    if (this.revision() !== expected) changed("Topic state changed while this conversation was being analyzed; retry indexing.");
  }

  assertRevision(expectedRevision: number): void {
    this.checkRevision(expectedRevision);
  }

  private readAt<T>(expected: number, read: () => T): T {
    return this.db.transaction(() => {
      this.checkRevision(expected);
      return read();
    })();
  }

  private topicRows(): TopicRow[] {
    return this.db.query<TopicRow, Bind[]>(`SELECT t.id,t.title,t.description,t.aliases,t.created_at,t.review_cursor
      FROM hr_topics t WHERE t.scope_id=? AND EXISTS (
        SELECT 1 FROM hr_memberships m JOIN hr_conversations c ON c.scope_id=m.scope_id AND c.id=m.conversation_id
        WHERE m.scope_id=t.scope_id AND m.topic_id=t.id AND (? IS NULL OR c.session_id<>?)
      ) ORDER BY t.created_at,t.id`).all(this.scopeId, this.excludedSessionId ?? null, this.excludedSessionId ?? null);
  }

  snapshot(): TopicSnapshot {
    return this.db.transaction(() => ({ revision: this.revision(), cards: this.topicRows().map(topic) }))();
  }

  private currentMember(conversationId: string, facetId: string): StoredMember | undefined {
    const row = this.db.query<MemberRow, [string, string, string]>(`${MEMBER_SQL}
      WHERE m.scope_id=? AND m.conversation_id=? AND m.facet_id=?`).get(this.scopeId, conversationId, facetId);
    return row ? member(row) : undefined;
  }

  private incomingMembers(incoming: IncomingConversation, selection: TopicSelection): MemberFacet[] {
    const assignments = new Map(selection.assignments.map(item => [item.facetId, item]));
    if (assignments.size !== selection.assignments.length || assignments.size !== incoming.analysis.facets.length) changed("Incoming facet assignments are incomplete or duplicated.");
    return incoming.analysis.facets.map(facet => {
      const assignment = assignments.get(facet.id);
      if (!assignment) changed("An incoming facet has no topic assignment.");
      validateDescriptor(facet);
      const seen = new Set<string>();
      const refs = facet.evidence_entry_ids.map(id => {
        const ref = incoming.evidenceById.get(id);
        if (!ref || ref.id !== id || !ref.hash || seen.has(id)) changed("An incoming facet has invalid source evidence.");
        seen.add(id);
        return { id: ref.id, hash: ref.hash };
      });
      if (refs.length < 1 || refs.length > 12) changed("An incoming facet must have validated source evidence.");
      return {
        conversationId: incoming.id, sourceHash: incoming.sourceHash, facetId: facet.id,
        descriptor: descriptor(facet), evidence: refs, topicId: assignment.topicRef, assignedAt: null,
      };
    });
  }

  initialMember(ref: FacetRef, incoming: IncomingConversation, selection: TopicSelection, expectedRevision: number): MemberFacet {
    return this.readAt(expectedRevision, () => {
      if (ref.conversationId === incoming.id) {
        const value = this.incomingMembers(incoming, selection).find(item => item.facetId === ref.facetId);
        if (!value || value.sourceHash !== ref.sourceHash) invalidRepair("An incoming facet reference does not match the initial prospective source version.");
        return value;
      }
      const row = this.db.query<MemberRow, Bind[]>(`${MEMBER_SQL}
        WHERE m.scope_id=? AND m.conversation_id=? AND m.facet_id=? AND c.source_hash=?
          AND (? IS NULL OR c.session_id<>?)`)
        .get(this.scopeId, ref.conversationId, ref.facetId, ref.sourceHash, this.excludedSessionId ?? null, this.excludedSessionId ?? null);
      if (!row) invalidRepair("A historical facet reference does not match an inactive member of this scoped source version.");
      return member(row);
    });
  }

  private selectedCards(selection: TopicSelection, incoming: IncomingConversation): Map<string, TopicCard> {
    const cards = new Map(this.topicRows().map(row => [row.id, topic(row)]));
    const facetIds = new Set(incoming.analysis.facets.map(facet => facet.id));
    if (facetIds.size !== incoming.analysis.facets.length) changed("Incoming facet IDs are duplicated.");
    const drafts = new Set<string>();
    for (const draft of selection.newTopics) {
      const facetId = draft.ref.startsWith("new:") ? draft.ref.slice(4) : "";
      const facet = incoming.analysis.facets.find(item => item.id === facetId);
      if (!facet || drafts.has(draft.ref) || cards.has(draft.ref) || !sameDescriptor(draft.descriptor, facet)) changed("A new topic draft does not match its incoming facet.");
      validateDescriptor(draft.descriptor);
      drafts.add(draft.ref);
      cards.set(draft.ref, { id: draft.ref, ...descriptor(draft.descriptor), createdAt: null });
    }
    for (const assignment of selection.assignments) {
      if (!facetIds.has(assignment.facetId) || !cards.has(assignment.topicRef)
        || !assignment.reason.trim() || assignment.reason.length > 500
        || assignment.candidateIds.length > 3 || new Set(assignment.candidateIds).size !== assignment.candidateIds.length
        || assignment.candidateIds.some(id => !cards.has(id) || drafts.has(id))
        || (!drafts.has(assignment.topicRef) && !assignment.candidateIds.includes(assignment.topicRef))
        || (drafts.has(assignment.topicRef) && assignment.topicRef !== `new:${assignment.facetId}`)) changed("A topic assignment references an unavailable topic or facet.");
    }
    if ([...drafts].some(ref => !selection.assignments.some(item => item.topicRef === ref))) changed("An unassigned new topic draft cannot be published.");
    const assigned = new Set(selection.assignments.map(item => item.topicRef));
    if (selection.neighborIds.length > 2 || new Set(selection.neighborIds).size !== selection.neighborIds.length
      || selection.neighborIds.some(id => !cards.has(id) || drafts.has(id) || assigned.has(id))) changed("The topic neighborhood is invalid.");
    return cards;
  }

  /** Fetch only a bounded prefix, overlaying incoming replacement and accepted historical moves. */
  private members(
    topicIds: readonly string[], incoming: IncomingConversation, moves: readonly RepairMemberMove[], limit: number,
    filter: MemberFilter = {},
  ): MemberFacet[] {
    if (!topicIds.length) return [];
    const args: Bind[] = [this.scopeId, ...topicIds, incoming.id, this.excludedSessionId ?? null, this.excludedSessionId ?? null];
    const clauses = ["m.scope_id=?", `m.topic_id IN (${topicIds.map(() => "?").join(",")})`, "m.conversation_id<>?", "(? IS NULL OR c.session_id<>?)"];
    for (const move of moves) {
      clauses.push("NOT (m.conversation_id=? AND m.facet_id=?)");
      args.push(move.member.conversationId, move.member.facetId);
    }
    const addBound = (value: string, op: ">" | "<=") => {
      const [conversationId, facetId] = tuple(value);
      clauses.push(`(m.conversation_id,m.facet_id) ${op} (?,?)`);
      args.push(conversationId, facetId);
    };
    if (filter.after) addBound(filter.after, ">");
    if (filter.through) addBound(filter.through, "<=");
    args.push(limit);
    const stored = this.db.query<MemberRow, Bind[]>(`${MEMBER_SQL} WHERE ${clauses.join(" AND ")} ORDER BY m.conversation_id,m.facet_id LIMIT ?`).all(...args).map(member);
    const extras: MemberFacet[] = moves.map(move => ({ ...move.member, topicId: move.targetRef, assignedAt: null }));
    const matches = (item: MemberFacet) => topicIds.includes(item.topicId)
      && (!filter.after || compareText(key(item), filter.after) > 0)
      && (!filter.through || compareText(key(item), filter.through) <= 0);
    return [...stored, ...extras.filter(matches)].sort(compareMembers).slice(0, limit);
  }

  private cursor(topicId: string): string | undefined {
    return this.db.query<{ review_cursor: string | null }, [string, string]>("SELECT review_cursor FROM hr_topics WHERE scope_id=? AND id=?").get(this.scopeId, topicId)?.review_cursor ?? undefined;
  }

  private ringMembers(topicId: string, incoming: IncomingConversation, limit: number): MemberFacet[] {
    const after = this.cursor(topicId);
    const first = this.members([topicId], incoming, [], limit, { after });
    return after && first.length < limit
      ? [...first, ...this.members([topicId], incoming, [], limit - first.length, { through: after })]
      : first;
  }


  repairCards(expectedRevision: number): RepairTopicCard[] {
    return this.readAt(expectedRevision, () => this.db.query<TopicRow & { member_count: number; active_count: number }, Bind[]>(`
      SELECT t.id,t.title,t.description,t.aliases,t.created_at,t.review_cursor,
        SUM(CASE WHEN ? IS NULL OR c.session_id<>? THEN 1 ELSE 0 END) AS member_count,
        SUM(CASE WHEN c.session_id=? THEN 1 ELSE 0 END) AS active_count
      FROM hr_topics t JOIN hr_memberships m ON m.scope_id=t.scope_id AND m.topic_id=t.id
      JOIN hr_conversations c ON c.scope_id=m.scope_id AND c.id=m.conversation_id
      WHERE t.scope_id=? GROUP BY t.id HAVING member_count>0 ORDER BY t.created_at,t.id`)
      .all(this.excludedSessionId ?? null, this.excludedSessionId ?? null, this.excludedSessionId ?? null, this.scopeId)
      .map(row => ({ ...topic(row), memberCount: row.member_count, hasActiveMembers: row.active_count > 0 })));
  }

  audit(selection: TopicSelection, incoming: IncomingConversation, expectedRevision: number): { topics: TopicCard[]; members: MemberFacet[] } {
    return this.readAt(expectedRevision, () => {
      const cards = this.selectedCards(selection, incoming);
      this.incomingMembers(incoming, selection);
      const ids = [...new Set([...selection.assignments.map(item => item.topicRef), ...selection.neighborIds])].sort(compareText);
      const queues = ids.map(id => ({ members: this.ringMembers(id, incoming, MAX_REVIEW_FACETS), offset: 0 }));
      const members: MemberFacet[] = [];
      while (members.length < MAX_REVIEW_FACETS) {
        let advanced = false;
        for (const queue of queues) {
          const value = queue.members[queue.offset++];
          if (!value) continue;
          members.push(value);
          advanced = true;
          if (members.length === MAX_REVIEW_FACETS) break;
        }
        if (!advanced) break;
      }
      return { topics: ids.map(id => cards.get(id)!), members };
    });
  }

  private hasActiveMembers(topicId: string): boolean {
    return !!this.excludedSessionId && !!this.db.query<{ found: number }, [string, string, string]>(`
      SELECT 1 AS found FROM hr_memberships m JOIN hr_conversations c ON c.scope_id=m.scope_id AND c.id=m.conversation_id
      WHERE m.scope_id=? AND m.topic_id=? AND c.session_id=? LIMIT 1`).get(this.scopeId, topicId, this.excludedSessionId);
  }

  private repairState(selection: TopicSelection, incoming: IncomingConversation, proposal: RepairProposal | null): RepairState {
    const cards = this.selectedCards(selection, incoming);
    const initial = this.incomingMembers(incoming, selection);
    const empty: RepairProposal = { drafts: [], updates: [], moves: [], merge: null, reason: "No repair changes." };
    if (proposal === null) return { cards, incoming: initial, moves: [], proposal: empty, merge: null };
    if (!proposal || !Array.isArray(proposal.drafts) || !Array.isArray(proposal.updates) || !Array.isArray(proposal.moves)
      || proposal.drafts.length > 5 || proposal.updates.length > 5) invalidRepair("A repair proposal exceeds its draft or update limit.");
    const reason = repairReason(proposal.reason);
    const drafts = proposal.drafts.map((draft, index) => {
      // Canonicalize model-chosen draft refs by array order; uniqueness via collision check.
      const canonicalRef = `repair:${index}`;
      if (cards.has(canonicalRef)) invalidRepair("Repair draft references must be unique.");
      const finalDescriptor = repairDescriptor(draft.descriptor);
      cards.set(canonicalRef, { id: canonicalRef, ...finalDescriptor, createdAt: null });
      return { ref: canonicalRef, descriptor: finalDescriptor };
    });
    let merge: RepairState["merge"] = null;
    let merged: RepairProposal["merge"] = null;
    if (proposal.merge !== null) {
      const requested = proposal.merge;
      const left = requested && cards.get(requested.leftTopicId);
      const right = requested && cards.get(requested.rightTopicId);
      if (!left || !right || left.id === right.id || left.createdAt === null || right.createdAt === null
        || this.hasActiveMembers(left.id) || this.hasActiveMembers(right.id)) invalidRepair("A merge requires two distinct persistent topics without active members.");
      const [target, source] = compareCards(left, right) < 0 ? [left, right] : [right, left];
      merge = { survivor: target.id, source: source.id };
      merged = { leftTopicId: target.id, rightTopicId: source.id,
        descriptor: repairDescriptor(requested.descriptor, [target, source]), reason: repairReason(requested.reason) };
      cards.set(target.id, { ...target, ...merged.descriptor });
    }
    const resolve = (ref: string): string => ref === merge?.source ? merge.survivor : ref;
    const updateIds = new Set<string>();
    const updates: RepairProposal["updates"] = [];
    for (const update of proposal.updates) {
      const current = cards.get(update.topicId);
      if (!current || current.createdAt === null || updateIds.has(current.id)
        || current.id === merge?.survivor || current.id === merge?.source || this.hasActiveMembers(current.id)) {
        invalidRepair("A topic update must name a unique persistent topic outside the merge pair and without active members.");
      }
      updateIds.add(current.id);
      const updateReason = repairReason(update.reason);
      validateDescriptor(update.descriptor);
      if (sameDescriptor(current, update.descriptor)) continue;
      const finalDescriptor = repairDescriptor(update.descriptor, [current]);
      if (sameDescriptor(current, finalDescriptor)) continue;
      updates.push({ topicId: current.id, descriptor: finalDescriptor, reason: updateReason });
      cards.set(current.id, { ...current, ...finalDescriptor });
    }
    const moveIds = new Set<string>();
    const moves: RepairMemberMove[] = [];
    const normalizedMoves: RepairProposal["moves"] = [];
    let historicalCount = 0;
    let incomingCount = 0;
    for (const move of proposal.moves) {
      const moveKey = key(move);
      if (moveIds.has(moveKey)) invalidRepair("A facet may occur only once in repair moves.");
      moveIds.add(moveKey);
      const current = move.conversationId === incoming.id
        ? initial.find(item => item.facetId === move.facetId) : this.currentMember(move.conversationId, move.facetId);
      if (!current || current.sourceHash !== move.sourceHash || current.topicId !== move.fromTopicRef || !cards.has(move.targetRef)) {
        invalidRepair("A repair move does not match its source version, initial membership, or destination.");
      }
      if (move.conversationId !== incoming.id && this.excludedSessionId && this.db.query<{ found: number }, [string, string, string]>(`
        SELECT 1 AS found FROM hr_conversations WHERE scope_id=? AND id=? AND session_id=?`).get(this.scopeId, move.conversationId, this.excludedSessionId)) {
        invalidRepair("An active conversation facet cannot be moved.");
      }
      const moveReason = repairReason(move.reason);
      const targetRef = resolve(move.targetRef);
      if (resolve(current.topicId) === targetRef) continue;
      if (move.conversationId === incoming.id) incomingCount++;
      else historicalCount++;
      normalizedMoves.push({ conversationId: current.conversationId, sourceHash: current.sourceHash, facetId: current.facetId,
        fromTopicRef: current.topicId, targetRef, reason: moveReason });
      moves.push({ member: current, targetRef, reason: moveReason });
    }
    if (historicalCount > 8 || incomingCount > 5) invalidRepair("A repair may move at most eight historical and five incoming facets.");
    const byKey = new Map(moves.map(move => [key(move.member), move]));
    const state: RepairState = {
      cards, merge, moves: moves.filter(move => move.member.conversationId !== incoming.id),
      incoming: initial.map(item => ({ ...item, topicId: byKey.get(key(item))?.targetRef ?? resolve(item.topicId) })),
      proposal: { drafts, updates, moves: normalizedMoves, merge: merged, reason },
    };
    for (const draft of drafts) {
      if (!this.repairMembers(state, incoming, [draft.ref], 1).length) invalidRepair("Every repair draft must have a final member.");
    }
    if (!drafts.length && !updates.length && !normalizedMoves.length && !merged) state.proposal = empty;
    return state;
  }

  normalizeRepairProposal(selection: TopicSelection, incoming: IncomingConversation, proposal: RepairProposal, expectedRevision: number): RepairProposal {
    return this.readAt(expectedRevision, () => this.repairState(selection, incoming, proposal).proposal);
  }

  private repairMembers(state: RepairState, incoming: IncomingConversation, refs: readonly string[], limit: number, after?: string): MemberFacet[] {
    const resolve = (ref: string): string => ref === state.merge?.source ? state.merge.survivor : ref;
    const canonical = [...new Set(refs.map(resolve))];
    const physical = state.merge && canonical.includes(state.merge.survivor) ? [...canonical, state.merge.source] : canonical;
    const stored = this.members(physical, incoming, state.moves, limit, { after })
      .map(value => value.topicId === resolve(value.topicId) ? value : { ...value, topicId: resolve(value.topicId) });
    const additions = state.incoming.filter(value => canonical.includes(value.topicId) && (!after || compareText(key(value), after) > 0));
    return [...stored, ...additions].sort(compareMembers).slice(0, limit);
  }

  memberPage(topicRefs: readonly string[], incoming: IncomingConversation, selection: TopicSelection, proposal: RepairProposal | null,
    expectedRevision: number, options: { cursor?: string; limit: number }): MemberPage {
    return this.readAt(expectedRevision, () => {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 64) invalidRepair("Member pages require a limit from 1 to 64.");
      const state = this.repairState(selection, incoming, proposal);
      const refs = [...new Set(topicRefs)].sort(compareText);
      if (!refs.length || refs.some(ref => !state.cards.has(ref))) invalidRepair("A member page references an unavailable topic.");
      const binding = digest(JSON.stringify(["repair-members-v1", repairViewId(this.scopeId, expectedRevision, incoming, selection), state.proposal, refs]));
      let after: string | undefined;
      if (options.cursor !== undefined) {
        try {
          const parsed: unknown = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
          if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== binding
            || typeof parsed[1] !== "string" || typeof parsed[2] !== "string" || !parsed[1] || !parsed[2]
            || parsed[1].includes("\0") || parsed[2].includes("\0")
            || Buffer.from(JSON.stringify(parsed)).toString("base64url") !== options.cursor) throw new Error("cursor");
          after = `${parsed[1]}\0${parsed[2]}`;
        } catch { throw new RecallError("invalid_cursor", "The member cursor does not match this repair view."); }
      }
      const members = this.repairMembers(state, incoming, refs, options.limit, after);
      const last = members.at(-1);
      return { members, nextCursor: members.length === options.limit && last
        ? Buffer.from(JSON.stringify([binding, last.conversationId, last.facetId])).toString("base64url") : null };
    });
  }

  private coverageTargets(state: RepairState): RepairCoverageTarget[] {
    const targets = new Map<string, RepairCoverageTarget>();
    const add = (targetRef: string, allMembers: boolean, moveKey?: string) => {
      const target = targets.get(targetRef) ?? { targetRef, descriptor: descriptor(state.cards.get(targetRef)!), allMembers: false, moveKeys: [] };
      target.allMembers ||= allMembers;
      if (moveKey !== undefined) target.moveKeys.push(moveKey);
      targets.set(targetRef, target);
    };
    for (const update of state.proposal.updates) add(update.topicId, true);
    for (const [index, draft] of state.proposal.drafts.entries()) add(draft.ref ?? `repair:${index}`, true);
    if (state.merge) add(state.merge.survivor, true);
    for (const move of state.proposal.moves) add(move.targetRef, state.cards.get(move.targetRef)!.createdAt === null, key(move));
    return [...targets.values()].sort((left, right) => compareText(left.targetRef, right.targetRef));
  }

  repairCoverageTargets(selection: TopicSelection, incoming: IncomingConversation, proposal: RepairProposal, expectedRevision: number): RepairCoverageTarget[] {
    return this.readAt(expectedRevision, () => this.coverageTargets(this.repairState(selection, incoming, proposal)));
  }

  assertRepairPlan(selection: TopicSelection, incoming: IncomingConversation, repair: ValidatedRepair, expectedRevision: number): void {
    this.readAt(expectedRevision, () => {
      let state: RepairState;
      try { state = this.repairState(selection, incoming, repair.proposal); }
      catch (error) {
        if (error instanceof RecallError && error.code === "invalid_model_output") changed(error.message);
        throw error;
      }
      const viewId = repairViewId(this.scopeId, expectedRevision, incoming, selection);
      if (JSON.stringify(state.proposal) !== JSON.stringify(repair.proposal)
        || repair.proposalId !== repairProposalId(viewId, state.proposal)) changed("The repair proposal is not the normalized plan bound to this view.");
      const guards = new Map<string, ValidatedRepair["sourceGuards"][number]>();
      for (const guard of repair.sourceGuards) {
        if (guards.has(guard.conversationId) || guard.conversationId === incoming.id) changed("Repair source guards must uniquely identify historical conversations.");
        const row = this.db.query<{ session_id: string; source_hash: string; file: string }, [string, string]>(`
          SELECT session_id,source_hash,file FROM hr_conversations WHERE scope_id=? AND id=?`).get(this.scopeId, guard.conversationId);
        if (!row || row.session_id !== guard.sessionId || row.source_hash !== guard.sourceHash || row.file !== guard.file
          || row.session_id === this.excludedSessionId) changed("A repair source guard no longer matches its scoped, inactive conversation.");
        guards.set(guard.conversationId, guard);
      }
      const initial = new Map(this.incomingMembers(incoming, selection).map(value => [key(value), value]));
      const receipts = new Map<string, EvidenceReceipt>();
      for (const receipt of repair.receipts) {
        const receiptKey = key(receipt);
        const current = receipt.conversationId === incoming.id ? initial.get(receiptKey)
          : this.currentMember(receipt.conversationId, receipt.facetId);
        if (receipts.has(receiptKey) || !current || current.sourceHash !== receipt.sourceHash
          || !Number.isSafeInteger(receipt.totalChars) || receipt.totalChars < 1
          || !current.evidence.some(ref => ref.id === receipt.entryId && ref.hash === receipt.entryHash)) {
          changed("A repair receipt does not identify a complete, current facet evidence entry.");
        }
        if (receipt.conversationId !== incoming.id) {
          const guard = guards.get(receipt.conversationId);
          const entry = this.db.query<{ hash: string }, [string, string, string]>(`
            SELECT hash FROM hr_entries WHERE scope_id=? AND conversation_id=? AND entry_id=?`)
            .get(this.scopeId, receipt.conversationId, receipt.entryId);
          if (!guard || guard.sourceHash !== receipt.sourceHash || entry?.hash !== receipt.entryHash) {
            changed("A historical repair receipt has no matching source guard or stored evidence hash.");
          }
        } else if (incoming.evidenceById.get(receipt.entryId)?.hash !== receipt.entryHash) {
          changed("An incoming repair receipt does not match the analyzed source evidence.");
        }
        receipts.set(receiptKey, receipt);
      }
      const targets = this.coverageTargets(state);
      const proofs = new Map(repair.coverage.map(proof => [proof.targetRef, proof]));
      if (proofs.size !== repair.coverage.length || proofs.size !== targets.length
        || [...proofs.keys()].some(ref => !targets.some(target => target.targetRef === ref))) changed("The repair coverage targets are incomplete or duplicated.");
      for (const target of targets) {
        const proof = proofs.get(target.targetRef);
        if (!proof || !Number.isSafeInteger(proof.memberCount) || proof.memberCount < 0) changed("A repair coverage count is invalid.");
        let count = 0;
        let rolling = startCoverageDigest(viewId, repair.proposalId, target.targetRef, target.descriptor);
        const consume = (value: MemberFacet) => {
          const receipt = receipts.get(key(value));
          if (!receipt || receipt.sourceHash !== value.sourceHash) changed("Repair coverage omitted a member's complete source evidence.");
          rolling = extendCoverageDigest(rolling, value, receipt, target.targetRef);
          count++;
        };
        if (target.allMembers) {
          let after: string | undefined;
          while (true) {
            const page = this.repairMembers(state, incoming, [target.targetRef], 64, after);
            for (const value of page) consume(value);
            if (page.length < 64) break;
            after = key(page[page.length - 1]);
          }
        } else {
          const moved = [...state.incoming, ...state.moves.map(move => ({ ...move.member, topicId: move.targetRef }))]
            .filter(value => target.moveKeys.includes(key(value))).sort(compareMembers);
          if (moved.length !== target.moveKeys.length) changed("Repair destination coverage lost a moved facet.");
          for (const value of moved) consume(value);
        }
        if (count !== proof.memberCount || rolling !== proof.digest) changed("The repair coverage digest does not match the complete prospective membership.");
      }
      const audited = this.audit(selection, incoming, expectedRevision).members;
      const last = new Map<string, string>();
      for (const value of audited) last.set(value.topicId, key(value));
      const seen = new Set<string>();
      for (const cursor of repair.cursorUpdates) {
        if (seen.has(cursor.topicId) || last.get(cursor.topicId) !== cursor.afterFacetKey
          || audited.some(value => value.topicId === cursor.topicId && !receipts.has(key(value)))) {
          changed("A repair cursor must follow the fully evidenced host-selected audit for that topic.");
        }
        tuple(cursor.afterFacetKey);
        seen.add(cursor.topicId);
      }
    });
  }


  /** Must be called inside publish's transaction, before its conversation UPSERT. */
  captureIncoming(incoming: IncomingConversation, expectedRevision: number): void {
    if (!this.db.inTransaction) changed("Incoming state must be captured inside the publication transaction.");
    this.checkRevision(expectedRevision);
    const old = this.db.query<{ source_hash: string; session_id: string }, [string, string]>("SELECT source_hash,session_id FROM hr_conversations WHERE scope_id=? AND id=?").get(this.scopeId, incoming.id);
    if (this.excludedSessionId && old?.session_id === this.excludedSessionId) changed("The active conversation cannot be indexed.");
    const members = this.db.query<MemberRow, [string, string]>(`${MEMBER_SQL} WHERE m.scope_id=? AND m.conversation_id=? ORDER BY m.facet_id`).all(this.scopeId, incoming.id).map(member);
    this.prepared = { id: incoming.id, sourceHash: incoming.sourceHash, revision: expectedRevision, oldSourceHash: old?.source_hash ?? null, members };
  }

  private event(revision: number, kind: "create" | "update" | "merge" | "move" | "retire", topicId: string, conversationId: string | null, payload: unknown, now: string): void {
    this.db.query(`INSERT INTO hr_topic_events(scope_id,revision,kind,topic_id,conversation_id,payload,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(this.scopeId, revision, kind, topicId, conversationId, JSON.stringify(payload), now);
  }


  /** The caller owns the immediate transaction, conversation/entry writes, revision increment and job deletion. */
  apply(plan: ClusterPlan, incoming: IncomingConversation, now: string): TopicChangeCounts {
    if (!this.db.inTransaction) changed("Topic publication requires an enclosing transaction.");
    this.checkRevision(plan.expectedRevision);
    const prepared = this.prepared;
    this.prepared = undefined;
    if (!prepared || prepared.id !== incoming.id || prepared.sourceHash !== incoming.sourceHash || prepared.revision !== plan.expectedRevision) changed("Incoming state was not captured before publication.");
    const current = this.db.query<{ source_hash: string; session_id: string }, [string, string]>("SELECT source_hash,session_id FROM hr_conversations WHERE scope_id=? AND id=?").get(this.scopeId, incoming.id);
    if (!current || current.source_hash !== incoming.sourceHash || current.session_id === this.excludedSessionId) changed("The incoming conversation is not the source version being published.");
    this.assertRepairPlan(plan.selection, incoming, plan.repair, plan.expectedRevision);
    const beforeCards = this.selectedCards(plan.selection, incoming);
    const state = this.repairState(plan.selection, incoming, plan.repair.proposal);
    const counts: TopicChangeCounts = { created: 0, updated: 0, merged: 0, reassigned: 0 };
    const revision = plan.expectedRevision + 1;
    const repairId = plan.repair.proposalId;
    const refs = new Map<string, string>();
    const canonical = (ref: string): string => ref === state.merge?.source ? state.merge.survivor : ref;
    const resolve = (ref: string): string => {
      if (!state.cards.has(ref)) changed("A repair plan contains an unknown topic reference.");
      const target = canonical(ref);
      return refs.get(target) ?? target;
    };
    const proofs = new Map(plan.repair.coverage.map(proof => [proof.targetRef, proof]));
    const receipts = new Map(plan.repair.receipts.map(receipt => [key(receipt), receipt]));
    const proofReceipts = new Map<string, EvidenceReceipt[]>();
    for (const target of this.coverageTargets(state)) {
      const selected: EvidenceReceipt[] = [];
      if (target.allMembers) {
        let after: string | undefined;
        while (true) {
          const page = this.repairMembers(state, incoming, [target.targetRef], 64, after);
          for (const value of page) selected.push(receipts.get(key(value))!);
          if (page.length < 64) break;
          after = key(page[page.length - 1]);
        }
      } else {
        for (const moveKey of [...target.moveKeys].sort(compareText)) selected.push(receipts.get(moveKey)!);
      }
      proofReceipts.set(target.targetRef, selected);
    }
    const proofPayload = (ref: string) => ({ coverage: proofs.get(canonical(ref)) ?? null, receipts: proofReceipts.get(canonical(ref)) ?? [] });
    const proofEvidence = (ref: string): EvidenceRef[] => (proofReceipts.get(canonical(ref)) ?? []).map(receipt => ({ id: receipt.entryId, hash: receipt.entryHash }));
    for (const [draftIndex, draft] of [...plan.selection.newTopics, ...state.proposal.drafts].entries()) {
      const draftRef = draft.ref ?? `repair:${draftIndex}`;
      if (!this.repairMembers(state, incoming, [draftRef], 1).length) continue;
      const id = `t_${randomUUID()}`;
      refs.set(draftRef, id);
      this.db.query("INSERT INTO hr_topics(scope_id,id,title,description,aliases,created_at,updated_at,review_cursor) VALUES (?,?,?,?,?,?,?,NULL)")
        .run(this.scopeId, id, draft.descriptor.title, draft.descriptor.description, JSON.stringify(draft.descriptor.aliases), now, now);
      this.event(revision, "create", id, incoming.id, {
        repair_id: repairId, draft_ref: draftRef, before: null, after: { id, ...draft.descriptor }, reason: state.proposal.reason,
        evidence: proofs.has(draftRef) ? proofEvidence(draftRef) : evidence(state.incoming.filter(value => value.topicId === draftRef)),
        ...proofPayload(draftRef),
      }, now);
      counts.created++;
    }
    const oldMembers = new Map(prepared.members.map(value => [value.facetId, value]));
    const incomingMoves = new Map(state.proposal.moves.filter(move => move.conversationId === incoming.id).map(move => [move.facetId, move]));
    const assignments = new Map(plan.selection.assignments.map(assignment => [assignment.facetId, assignment]));
    const newFacetIds = new Set(state.incoming.map(value => value.facetId));
    for (const old of prepared.members) {
      if (!newFacetIds.has(old.facetId)) {
        this.event(revision, "move", old.topicId, incoming.id, {
          repair_id: repairId, before: old, after: null, reason: "The explicitly indexed conversation no longer contains this facet.", evidence: old.evidence,
        }, now);
      }
    }
    if (prepared.oldSourceHash !== incoming.sourceHash) {
      this.db.query("DELETE FROM hr_facets WHERE scope_id=? AND conversation_id=?").run(this.scopeId, incoming.id);
    } else {
      this.db.query(`DELETE FROM hr_facets WHERE scope_id=? AND conversation_id=? ${newFacetIds.size ? `AND id NOT IN (${[...newFacetIds].map(() => "?").join(",")})` : ""}`)
        .run(this.scopeId, incoming.id, ...newFacetIds);
    }
    for (const value of state.incoming) {
      this.db.query(`INSERT INTO hr_facets(scope_id,conversation_id,id,title,description,aliases,evidence) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(scope_id,conversation_id,id) DO UPDATE SET title=excluded.title,description=excluded.description,aliases=excluded.aliases,evidence=excluded.evidence
        WHERE title<>excluded.title OR description<>excluded.description OR aliases<>excluded.aliases OR evidence<>excluded.evidence`)
        .run(this.scopeId, incoming.id, value.facetId, value.descriptor.title, value.descriptor.description, JSON.stringify(value.descriptor.aliases), JSON.stringify(value.evidence));
      const old = oldMembers.get(value.facetId);
      const topicId = resolve(value.topicId);
      const move = incomingMoves.get(value.facetId);
      const unchanged = old !== undefined && resolve(old.topicId) === topicId;
      const assignedAt = unchanged ? old.assignedAt! : now;
      const reason = move?.reason ?? (unchanged ? old.reason : assignments.get(value.facetId)!.reason);
      this.db.query(`INSERT INTO hr_memberships(scope_id,conversation_id,facet_id,topic_id,reason,assigned_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(scope_id,conversation_id,facet_id) DO UPDATE SET topic_id=excluded.topic_id,reason=excluded.reason,assigned_at=excluded.assigned_at
        WHERE topic_id<>excluded.topic_id OR reason<>excluded.reason OR assigned_at<>excluded.assigned_at`)
        .run(this.scopeId, incoming.id, value.facetId, topicId, reason, assignedAt);
      if ((old && !unchanged) || move) {
        this.event(revision, "move", topicId, incoming.id, {
          repair_id: repairId, before: old ?? null, after: { ...value, topicId, assignedAt, reason }, reason,
          initial_topic_ref: assignments.get(value.facetId)!.topicRef, evidence: value.evidence, ...proofPayload(value.topicId),
        }, now);
      }
      if (old && !unchanged) counts.reassigned++;
    }
    for (const move of state.moves) {
      const before = this.currentMember(move.member.conversationId, move.member.facetId);
      if (!before || before.sourceHash !== move.member.sourceHash || before.topicId !== move.member.topicId) changed("A historical move changed after repair validation.");
      const topicId = resolve(move.targetRef);
      const result = this.db.query("UPDATE hr_memberships SET topic_id=?,reason=?,assigned_at=? WHERE scope_id=? AND conversation_id=? AND facet_id=? AND topic_id=?")
        .run(topicId, move.reason, now, this.scopeId, before.conversationId, before.facetId, before.topicId);
      if (result.changes !== 1) changed("A historical repair move did not update exactly one membership.");
      this.event(revision, "move", topicId, before.conversationId, {
        repair_id: repairId, before, after: { ...before, topicId, assignedAt: now, reason: move.reason }, reason: move.reason,
        evidence: before.evidence, ...proofPayload(move.targetRef),
      }, now);
      counts.reassigned++;
    }
    for (const update of state.proposal.updates) {
      const before = beforeCards.get(update.topicId)!;
      const result = this.db.query("UPDATE hr_topics SET title=?,description=?,aliases=?,updated_at=? WHERE scope_id=? AND id=?")
        .run(update.descriptor.title, update.descriptor.description, JSON.stringify(update.descriptor.aliases), now, this.scopeId, update.topicId);
      if (result.changes !== 1) changed("An updated topic disappeared after repair validation.");
      this.event(revision, "update", update.topicId, incoming.id, {
        repair_id: repairId, before: descriptor(before), after: update.descriptor, reason: update.reason,
        evidence: proofEvidence(update.topicId), ...proofPayload(update.topicId),
      }, now);
      counts.updated++;
    }
    if (state.merge) {
      const source = beforeCards.get(state.merge.source)!;
      const target = beforeCards.get(state.merge.survivor)!;
      const merged = state.proposal.merge!;
      this.db.query("UPDATE hr_memberships SET topic_id=? WHERE scope_id=? AND topic_id=?").run(target.id, this.scopeId, source.id);
      this.db.query("UPDATE hr_topics SET title=?,description=?,aliases=?,updated_at=? WHERE scope_id=? AND id=?")
        .run(merged.descriptor.title, merged.descriptor.description, JSON.stringify(merged.descriptor.aliases), now, this.scopeId, target.id);
      this.event(revision, "merge", target.id, incoming.id, {
        repair_id: repairId, source_id: source.id, target_id: target.id, before: { source, target }, after: { id: target.id, ...merged.descriptor },
        reason: merged.reason, evidence: proofEvidence(target.id), ...proofPayload(target.id),
      }, now);
      this.db.query("DELETE FROM hr_topics WHERE scope_id=? AND id=?").run(this.scopeId, source.id);
      counts.merged++;
    }
    for (const cursor of plan.repair.cursorUpdates) {
      this.db.query("UPDATE hr_topics SET review_cursor=? WHERE scope_id=? AND id=?").run(cursor.afterFacetKey, this.scopeId, resolve(cursor.topicId));
    }
    const empty = this.db.query<TopicRow, [string]>(`SELECT id,title,description,aliases,created_at,review_cursor FROM hr_topics t WHERE t.scope_id=?
      AND NOT EXISTS (SELECT 1 FROM hr_memberships m WHERE m.scope_id=t.scope_id AND m.topic_id=t.id)`).all(this.scopeId);
    for (const row of empty) {
      this.event(revision, "retire", row.id, null, {
        repair_id: repairId, before: topic(row), after: null, reason: "No indexed facets remain assigned to this topic.", evidence: [],
      }, now);
      this.db.query("DELETE FROM hr_topics WHERE scope_id=? AND id=?").run(this.scopeId, row.id);
    }
    const inconsistent = this.db.query<{ found: number }, [string]>(`SELECT 1 AS found FROM hr_memberships m
      LEFT JOIN hr_topics t ON t.scope_id=m.scope_id AND t.id=m.topic_id
      LEFT JOIN hr_facets f ON f.scope_id=m.scope_id AND f.conversation_id=m.conversation_id AND f.id=m.facet_id
      WHERE m.scope_id=? AND (t.id IS NULL OR f.id IS NULL) LIMIT 1`).get(this.scopeId);
    if (inconsistent) changed("Topic publication produced an invalid scoped membership reference.");
    return counts;
  }

}
