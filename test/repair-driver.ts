import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import type { RepairCompletion, RepairProposal, RepairProtocol, RepairRunner } from "../src/repair";
import type { ConversationAnalysis, TopicDescriptor } from "../src/semantic";
import type { EvidencePage } from "../src/source";
import type { ModelMemberFacet, ModelTopicCard, TopicSelection } from "../src/topics";

export type AcceptedProposal = {
  accepted: true;
  proposal_id: string;
  coverage_targets: { target_ref: string; descriptor: TopicDescriptor; all_members: boolean }[];
};
export type CoveragePage = {
  proposal_id: string; target_ref: string; descriptor: TopicDescriptor;
  members: ModelMemberFacet[]; page_id: string; next_cursor: string | null;
};
type RepairInput = {
  incoming: { id: string; source_hash: string; analysis: ConversationAnalysis };
  selection: Pick<TopicSelection, "assignments" | "newTopics">;
  topics: ModelTopicCard[];
  audit: ModelMemberFacet[];
  unavailable: { conversation_id: string; code: string }[];
};
type AcceptMember = (member: ModelMemberFacet, targetRef: string) => boolean | Promise<boolean>;

/** Unit-only scripted consumer of the actual protocol tools; it never constructs a repair proof. */
export class RepairDriver {
  readonly input: RepairInput;
  private readonly definitions;
  private readonly context: Context;
  private readonly readFacets = new Set<string>();
  private sequence = 0;

  constructor(readonly protocol: RepairProtocol, private readonly signal?: AbortSignal) {
    this.input = protocol.input() as RepairInput;
    this.definitions = protocol.tools();
    this.context = {
      messages: [{ role: "developer", content: JSON.stringify(protocol.input()), synthetic: true, timestamp: 0 }],
      tools: this.definitions.map(({ name, description, parameters }) => ({ name, description, parameters })),
    };
  }

  async call<T>(name: string, args: unknown): Promise<T> {
    const definition = this.definitions.find(tool => tool.name === name);
    if (!definition) throw new Error(`Unknown repair tool ${name}`);
    this.protocol.providerContext(this.context);
    const id = `unit-repair-${++this.sequence}`;
    const message: AssistantMessage = {
      role: "assistant", api: "openai-completions", provider: "unit-repair", model: "unit-repair", timestamp: 0,
      content: [{ type: "toolCall", id, name, arguments: args as Record<string, unknown> }], stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    this.protocol.prepareToolBatch(message);
    const result = await definition.execute(id, args, this.signal, undefined, undefined as never);
    this.context.messages.push(message, { role: "toolResult", toolCallId: id, toolName: name,
      content: result.content, details: result.details, isError: false, timestamp: 0 });
    const text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
    return JSON.parse(text) as T;
  }

  async audit(): Promise<void> {
    for (const member of this.input.audit) await this.read(member);
  }

  async topics(): Promise<(ModelTopicCard & { member_count: number; repairable: boolean })[]> {
    const result: (ModelTopicCard & { member_count: number; repairable: boolean })[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call<{ topics: typeof result; next_cursor: string | null }>("repair_topics", cursor ? { cursor } : {});
      result.push(...page.topics);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return result;
  }

  async members(topicRef: string): Promise<ModelMemberFacet[]> {
    const result: ModelMemberFacet[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call<{ members: ModelMemberFacet[]; next_cursor: string | null }>("repair_members",
        { topic_ref: topicRef, ...(cursor ? { cursor } : {}) });
      result.push(...page.members);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return result;
  }

  async read(member: ModelMemberFacet): Promise<void> {
    const key = JSON.stringify([member.conversation_id, member.source_hash, member.facet_id]);
    if (this.readFacets.has(key)) return;
    const evidence = member.evidence[0];
    if (!evidence) throw new Error("A repair member needs original evidence");
    let cursor: string | undefined;
    do {
      const page = await this.call<Omit<EvidencePage, "source_file" | "session_id"> | { unavailable: unknown } | { retry_after_remember: true }>("repair_read", {
        action: "read", conversation_id: member.conversation_id, facet_id: member.facet_id,
        entry_id: evidence.id, max_chars: 1000, ...(cursor ? { cursor } : {}),
      });
      if ("unavailable" in page) throw new Error("Scripted repair depended on unavailable original evidence");
      if ("retry_after_remember" in page) throw new Error("Scripted repair exhausted context despite acknowledging every evidence page");
      if (!page.fragments.length) throw new Error("Original evidence page was empty");
      let summary = page.fragments.map(fragment => fragment.text).join("\n");
      if (page.fragments.length === 1 && page.fragments[0].offset === 0 && summary.length === page.fragments[0].total_chars) {
        const original = JSON.parse(summary) as { message?: { content?: unknown } };
        const content = original.message?.content;
        if (typeof content === "string") summary = content;
        else if (Array.isArray(content)) {
          const text = content.filter((part): part is { type: "text"; text: string } =>
            !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
            .map(part => part.text).join("\n");
          if (text.trim()) summary = text;
        }
      }
      await this.call("repair_read", { action: "remember", conversation_id: member.conversation_id, facet_id: member.facet_id,
        summary: summary.slice(-500).trim() || "The returned original fragment contains whitespace only." });
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    this.readFacets.add(key);
  }

  async propose(proposal: RepairProposal): Promise<AcceptedProposal> {
    const result = await this.call<AcceptedProposal | { accepted: false; unavailable: unknown[] }>("repair_propose", proposal);
    if (!result.accepted) throw new Error("Scripted repair proposal depends on unavailable sources");
    return result;
  }

  async complete(staged: AcceptedProposal, accept: AcceptMember = () => true): Promise<RepairCompletion> {
    for (const target of staged.coverage_targets) {
      let cursor: string | undefined;
      for (;;) {
        const page = await this.call<CoveragePage>("repair_coverage", {
          proposal_id: staged.proposal_id, target_ref: target.target_ref, ...(cursor ? { cursor } : {}),
        });
        if (page.members.length > 1) throw new Error("Repair coverage must deliver singleton members");
        const fits: { conversation_id: string; facet_id: string; fits: boolean }[] = [];
        for (const member of page.members) {
          await this.read(member);
          fits.push({ conversation_id: member.conversation_id, facet_id: member.facet_id, fits: await accept(member, target.target_ref) });
        }
        await this.call("repair_check", { proposal_id: staged.proposal_id, page_id: page.page_id, fits });
        if (!page.members.length) break;
        if (!page.next_cursor) throw new Error("Coverage member page must permit explicit EOF confirmation");
        cursor = page.next_cursor;
      }
    }
    return { proposal_id: staged.proposal_id, reason: "Completed the original-evidence audit and every final-member proof page." };
  }

  async commit(proposal: RepairProposal, accept?: AcceptMember): Promise<RepairCompletion> {
    return this.complete(await this.propose(proposal), accept);
  }
}

export function repairRunner(script?: (driver: RepairDriver) => Promise<RepairCompletion>): RepairRunner {
  return async ({ protocol, signal }) => {
    const driver = new RepairDriver(protocol, signal);
    await driver.audit();
    return script ? script(driver) : { proposal_id: null, reason: "Read every mandatory original-evidence entry and retain the existing scope." };
  };
}

export const keepRepair = repairRunner();
