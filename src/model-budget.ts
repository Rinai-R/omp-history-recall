import type { Database } from "bun:sqlite";
import type { JsonModel } from "./semantic";
import { digest, RecallError, redactJson } from "./source";

/** One scope's accounting and cache shared by every job and native turn in a work batch. */
export class ModelBudget {
  #calls = 0;

  constructor(
    private readonly db: Database,
    private readonly scopeId: string,
    private readonly limits: { maxCalls: number },
  ) {
    for (const value of [limits.maxCalls]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
        throw new RecallError("invalid_budget", "Work budgets must be integers between 1 and 10000.");
      }
    }
  }

  get calls(): number { return this.#calls; }

  reserve(): void {
    if (this.#calls >= this.limits.maxCalls) throw new RecallError("work_budget", "Batch indexing model-call budget reached.");
    // Metering only (usage visibility in /history-recall status); never a hard cap.
    const day = new Date().toISOString().slice(0, 10);
    this.db.run(`
      INSERT INTO hr_budget(scope_id,day,calls) VALUES (?,?,1)
      ON CONFLICT(scope_id,day) DO UPDATE SET calls=calls+1`, [this.scopeId, day]);
    this.#calls++;
  }

  read(key: string): string | undefined {
    return this.db.query<{ payload: string }, [string, string]>(
      "SELECT payload FROM hr_cache WHERE scope_id=? AND key=?").get(this.scopeId, key)?.payload;
  }

  write(key: string, payload: string): void {
    this.db.run("INSERT OR REPLACE INTO hr_cache VALUES (?,?,?,?)", [this.scopeId, key, payload, Date.now()]);
  }

  invalidate(key: string): void {
    this.db.run("DELETE FROM hr_cache WHERE scope_id=? AND key=?", [this.scopeId, key]);
  }

  wrapJson(model: JsonModel, versionFor: (input: unknown) => string): JsonModel {
    const binding = [model.identity, model.contextWindow, model.maxOutputTokens];
    const requestKey = (system: string, input: unknown) =>
      digest(JSON.stringify([this.scopeId, "request", versionFor(input), binding, system, input]));
    return {
      identity: model.identity, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
      generate: async (system, input, signal) => {
        signal?.throwIfAborted();
        const key = requestKey(system, input);
        const cached = this.read(key);
        if (cached !== undefined) {
          try {
            const value: unknown = JSON.parse(cached);
            if (typeof value !== "string") throw new Error();
            return value;
          } catch {
            this.invalidate(key);
            throw new RecallError("invalid_model_output", "Cached model response is invalid.");
          }
        }
        this.reserve();
        let result = await model.generate(system, input, signal);
        signal?.throwIfAborted();
        try { result = redactJson(result); } catch { return result; }
        this.write(key, JSON.stringify(result));
        return result;
      },
      invalidateCachedResponse: (system, input) => this.invalidate(requestKey(system, input)),
    };
  }
}
