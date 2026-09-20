import { RecallError, type SourceEntry } from "./source";

const FALLBACK_CONTEXT_TOKENS = 32_768;
const DEFAULT_OUTPUT_TOKENS = 8192;
const FRAMING_TOKENS = 256;

export function inputBudget(contextWindow = FALLBACK_CONTEXT_TOKENS, maxOutputTokens = DEFAULT_OUTPUT_TOKENS): number {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new RecallError("model_context_too_small", "Model context and output limits must be positive integers.");
  }
  // Estimate at most one token per serialized UTF-8 byte, reserving output and
  // chat framing separately. This is deliberately conservative, not a tokenizer
  // guarantee: providers with unusual tokenization/framing need exact accounting.
  const bytes = contextWindow - maxOutputTokens - FRAMING_TOKENS;
  if (bytes <= 0) {
    throw new RecallError("model_context_too_small", "The advertised model context cannot accommodate its output and framing reserves.");
  }
  return bytes;
}

export function requestBytes(system: string, input: unknown): number {
  return Buffer.byteLength(system, "utf8") + Buffer.byteLength(JSON.stringify(input), "utf8");
}

export type IndexedEntry = {
  id: string;
  parent_id: string | null;
  time: string;
  role: string;
  text: string;
  // Fragment offsets and original text length are UTF-16 code units, as in JS
  // String.slice. Boundaries never split a Unicode surrogate pair.
  text_offset?: number;
  text_length?: number;
};

function serializedCodePointBytes(point: number): number {
  if (point === 0x22 || point === 0x5c) return 2;
  if (point < 0x20) return point === 8 || point === 9 || point === 10 || point === 12 || point === 13 ? 2 : 6;
  if (point < 0x80) return 1;
  if (point < 0x800) return 2;
  if (point >= 0xd800 && point <= 0xdfff) return 6; // JSON escapes unpaired surrogates.
  return point <= 0xffff ? 3 : 4;
}

/** Budget includes the system prompt and the serialized input with entries:[]. */
export function planChunks(
  source: readonly SourceEntry[],
  budget: { maximumBytes: number; overheadBytes: number; finalOverheadBytes: number },
): IndexedEntry[][] {
  const targetBytes = Math.floor(budget.maximumBytes / 2);
  const chunks: IndexedEntry[][] = [];
  let entries: IndexedEntry[] = [];
  let bytes = budget.overheadBytes;
  const flush = () => {
    if (entries.length === 0) return;
    chunks.push(entries);
    entries = [];
    bytes = budget.overheadBytes;
  };
  const append = (entry: IndexedEntry, size: number) => {
    if (entries.length && bytes + 1 + size > targetBytes) flush();
    bytes += size + (entries.length ? 1 : 0);
    entries.push(entry);
  };

  for (const raw of source) {
    if (raw.text.length === 0) continue;
    const entry: IndexedEntry = {
      id: raw.id, parent_id: raw.parentId, time: raw.timestamp, role: raw.role || raw.type, text: raw.text,
    };
    // Avoid serializing an entire oversized entry just to discover it needs splitting.
    if (Buffer.byteLength(raw.text, "utf8") <= targetBytes - budget.overheadBytes) {
      const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (budget.overheadBytes + size <= targetBytes) {
        append(entry, size);
        continue;
      }
    }

    flush();
    let start = 0;
    while (start < raw.text.length) {
      const fragment: IndexedEntry = { ...entry, text: "", text_offset: start, text_length: raw.text.length };
      const overhead = Buffer.byteLength(JSON.stringify(fragment), "utf8");
      const available = targetBytes - budget.overheadBytes - overhead;
      let end = start;
      let textBytes = 0;
      while (end < raw.text.length) {
        const point = raw.text.codePointAt(end)!;
        const nextBytes = serializedCodePointBytes(point);
        if (textBytes + nextBytes > available) break;
        textBytes += nextBytes;
        end += point > 0xffff ? 2 : 1;
      }
      if (end === start) {
        throw new RecallError("model_context_too_small", "The chunk target cannot fit the prompt, metadata and one Unicode text character.");
      }
      fragment.text = raw.text.slice(start, end);
      append(fragment, overhead + textBytes);
      start = end;
    }
  }
  flush();

  const tail = chunks.at(-1);
  if (chunks.length > 1 && tail && new Set(tail.map(entry => entry.id)).size < 10) {
    const combined = [...chunks[chunks.length - 2], ...tail];
    const overhead = chunks.length === 2
      ? Math.max(budget.overheadBytes, budget.finalOverheadBytes) : budget.overheadBytes;
    // Both empty-array brackets are already included in the request envelope.
    const combinedBytes = overhead + Buffer.byteLength(JSON.stringify(combined), "utf8") - 2;
    if (combinedBytes <= budget.maximumBytes) chunks.splice(chunks.length - 2, 2, combined);
  }
  return chunks;
}
