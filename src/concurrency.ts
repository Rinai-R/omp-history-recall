import { RecallError } from "./source";

export const DEFAULT_INDEX_CONCURRENCY = 1;

export function validateConcurrency(value: number = DEFAULT_INDEX_CONCURRENCY): number {
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    throw new RecallError("invalid_concurrency", "Index concurrency must be an integer between 1 and 32.");
  }
  return value;
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const limit = validateConcurrency(concurrency);
  signal?.throwIfAborted();
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  const stop = (error: unknown) => {
    if (failed) return;
    failed = true;
    failure = error;
  };
  const onAbort = () => stop(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        stop(error);
      }
    }
  };
  try {
    // Only workers, never the entire queue, are started eagerly. Failed workers
    // stop the queue without aborting peers, so every started request can settle.
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (failed) throw failure;
  return results;
}
