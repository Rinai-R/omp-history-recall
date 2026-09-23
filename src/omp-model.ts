import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { completeSimple, type Model } from "@oh-my-pi/pi-ai";
import type { JsonModel } from "./semantic";
import { RecallError } from "./source";

export type ModelMetric = { model: string; elapsed_ms: number; outcome: string; input: number; output: number; cache_read: number; cache_write: number; cost: number | null };

/** Resolve once at the runtime boundary so analysis and repair share an exact model. */
export function resolveRecallModel(ctx: ExtensionContext): Model {
  const spec = process.env.OMP_HISTORY_RECALL_MODEL;
  const model = spec ? ctx.models.resolve(spec) : ctx.models.current() ?? ctx.model;
  if (!model) throw new RecallError("model_unavailable", "Select an OMP model or configure OMP_HISTORY_RECALL_MODEL.");
  return model;
}

export function ompModel(ctx: ExtensionContext, observe?: (metric: ModelMetric) => void, model = resolveRecallModel(ctx)): JsonModel {
  const identity = `${model.provider}/${model.id}`;
  const maxOutputTokens = Math.min(8192, model.maxTokens ?? 8192);
  return {
    identity,
    contextWindow: model.contextWindow ?? undefined,
    maxOutputTokens,
    async generate(system, input, signal) {
      const start = performance.now();
      const metric: ModelMetric = { model: identity, elapsed_ms: 0, outcome: "failed", input: 0, output: 0, cache_read: 0, cache_write: 0, cost: null };
      try {
        const timeout = AbortSignal.timeout(90_000);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const apiKey = await ctx.modelRegistry.getApiKey(model, ctx.sessionManager.getSessionId(), { signal: combined });
        if (!apiKey) throw new RecallError("auth_unavailable", "The selected indexing model has no configured authentication.");
        const result = await completeSimple(model, {
          systemPrompt: [system],
          messages: [{ role: "user", content: JSON.stringify(input), timestamp: Date.now() }],
        }, {
          apiKey, signal: combined, temperature: 0, maxTokens: maxOutputTokens, disableReasoning: true,
          maxRetryDelayMs: 5000,
        });
        Object.assign(metric, { outcome: result.stopReason, input: result.usage.input, output: result.usage.output,
          cache_read: result.usage.cacheRead, cache_write: result.usage.cacheWrite, cost: result.usage.cost.total });
        if (result.stopReason === "error" || result.stopReason === "aborted") {
          // Provider error strings can contain request data; expose only a stable code.
          throw new RecallError("model_request_failed", `Indexing model request failed: ${String((result as { errorMessage?: string }).errorMessage ?? "unknown").slice(0, 200)}`);
        }
        if (result.stopReason === "length") throw new RecallError("model_output_truncated", "Indexing model output hit its token limit.");
        return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      } finally {
        metric.elapsed_ms = performance.now() - start;
        try { observe?.(metric); } catch { /* Diagnostics must not fail a successful retrieval. */ }
      }
    },
  };
}
