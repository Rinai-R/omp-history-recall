import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";

export class RecallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RecallError";
  }
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  return fs.realpath(resolved).catch(() => resolved);
}

export type SourceEntry = {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
  role: string;
  text: string;
  line: number;
  hash: string;
  raw: string;
};

export type SessionSource = {
  sessionId: string;
  cwd: string;
  file: string;
  sizeBytes: number;
  stamp: string;
  title: string;
  timestamp: string;
  fingerprint: string;
  entries: SourceEntry[];
};

export type EvidenceRef = Pick<SourceEntry, "id" | "hash">;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new RecallError("invalid_source", "Session entry has no valid timestamp.");
  }
  return new Date(value).toISOString();
}

// This is defense in depth, not a promise of complete secret detection. Raw files
// remain local; neither index preparation nor retrieval sends these values as-is.
export function redact(text: string): string {
  return text
    .replace(/\b(?:glpat-|ghp_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)\b["']?\s*[:=]\s*["']?)([^\s,"'\]}]{8,})/gi, "$1[REDACTED_SECRET]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1[REDACTED_TOKEN]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

export function redactStructured<T>(value: T): T {
  function visit(value: unknown, key = ""): unknown {
    if (typeof value === "string") {
      if (/^(?:api[_-]?key|access[_-]?token|authorization|password|secret|client[_-]?secret|private[_-]?key)$/i.test(key)) return "[REDACTED_SECRET]";
      return redact(value);
    }
    if (Array.isArray(value)) return value.map(item => visit(item));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, key)]));
    return value;
  }
  return visit(value) as T;
}

export function redactJson(raw: string): string {
  const parsed = JSON.parse(raw);
  const encoded = JSON.stringify(redactStructured(parsed));
  return encoded === JSON.stringify(parsed) ? raw : encoded;
}

function entryText(record: Record<string, unknown>): { role: string; text: string } {
  if (record.type !== "message") return { role: "", text: "" };
  const message = object(record.message);
  if (!message) return { role: "", text: "" };
  const role = typeof message.role === "string" ? message.role : "";
  if (!["user", "assistant", "toolResult", "bashExecution", "pythonExecution"].includes(role)) {
    return { role, text: "" };
  }
  const parts: string[] = [];
  if (typeof message.toolName === "string" || typeof message.isError === "boolean" || typeof message.exitCode === "number") {
    parts.push(JSON.stringify({ tool: message.toolName, is_error: message.isError, exit_code: message.exitCode }));
  }
  if (typeof message.command === "string") parts.push(`Command attempted: ${message.command}`);
  if (typeof message.code === "string") parts.push(`Code attempted: ${message.code}`);
  if (typeof message.content === "string") parts.push(message.content);
  if (Array.isArray(message.content)) {
    for (const value of message.content) {
      const block = object(value);
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
      if (block?.type === "toolCall") {
        parts.push(JSON.stringify({ tool: block.name, arguments: block.arguments }));
      }
      // Deliberately do not index reasoning, image data, or provider signatures.
    }
  }
  if (typeof message.output === "string") parts.push(message.output);
  return { role, text: redact(parts.join("\n")) };
}

export async function loadSource(
  file: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<SessionSource> {
  options.signal?.throwIfAborted();
  const resolved = path.resolve(file);
  const stat = await fs.lstat(resolved);
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new RecallError("invalid_source", "Session source must be a regular, non-symlink file.");
  }
  if (stat.size > maxBytes) throw new RecallError("source_too_large", `Session exceeds ${maxBytes} bytes.`);
  const stream = createReadStream(resolved, { signal: options.signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let header: Record<string, unknown> | undefined;
  let title: string | undefined;
  let line = 0;
  let bytes = 0;
  const entries: SourceEntry[] = [];
  const ids = new Set<string>();
  const fileHash = createHash("sha256");
  try {
    for await (const raw of lines) {
      options.signal?.throwIfAborted();
      line++;
      bytes += Buffer.byteLength(raw) + 1;
      if (bytes > maxBytes + 1) throw new RecallError("source_too_large", "Session grew beyond the read budget.");
      fileHash.update(raw).update("\n");
      if (!raw.trim()) continue;
      let record: Record<string, unknown> | undefined;
      try { record = object(JSON.parse(raw)); } catch {
        throw new RecallError("invalid_source", `Invalid JSON at line ${line}; retain the previous index and retry later.`);
      }
      if (!record || typeof record.type !== "string") {
        throw new RecallError("invalid_source", `Invalid session record at line ${line}.`);
      }
      if (record.type === "title") {
        if (typeof record.title === "string") title = record.title;
        continue;
      }
      if (record.type === "session") {
        if (header) throw new RecallError("invalid_source", "Multiple session headers.");
        header = record;
        continue;
      }
      if (!header) throw new RecallError("invalid_source", "Session header must precede entries.");
      if (typeof record.id !== "string" || !record.id || ids.has(record.id)) {
        throw new RecallError("invalid_source", `Missing or duplicate entry ID at line ${line}.`);
      }
      if (record.parentId !== null && (typeof record.parentId !== "string" || !ids.has(record.parentId))) {
        throw new RecallError("invalid_ancestry", `Missing or forward parent at line ${line}.`);
      }
      ids.add(record.id);
      entries.push({
        id: record.id, parentId: record.parentId as string | null,
        timestamp: timestamp(record.timestamp), type: record.type, ...entryText(record),
        line, hash: digest(raw), raw,
      });
      if (record.type === "title_change" && typeof record.title === "string") title = record.title;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!header || typeof header.id !== "string" || !header.id || typeof header.cwd !== "string") {
    throw new RecallError("invalid_source", "Missing session identity or working directory.");
  }
  if (typeof header.version !== "number" || header.version !== 3) {
    throw new RecallError("unsupported_source", "Only OMP session format version 3 is supported.");
  }
  const after = await fs.lstat(resolved);
  if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
    throw new RecallError("source_busy", "Session changed while being read; retry when stable.");
  }
  const cwd = await canonicalPath(header.cwd);
  options.signal?.throwIfAborted();
  return {
    sessionId: header.id, cwd, file: resolved, sizeBytes: stat.size, stamp: `${stat.mtimeMs}:${stat.size}`,
    title: redact(title ?? (typeof header.title === "string" ? header.title : "Untitled session")),
    timestamp: timestamp(header.timestamp), fingerprint: fileHash.digest("hex"), entries,
  };
}


export type EvidencePage = {
  source_file: string;
  session_id: string;
  evidence_id: string;
  content_kind: "redacted_original_json_fragments";
  fragments: { entry_id: string; line: number; sha256: string; offset: number; total_chars: number; text: string }[];
  next_cursor: string | null;
};

export function evidencePage(
  scopeId: string, source: SessionSource, refs: EvidenceRef[],
  options: { cursor?: string; maxChars?: number } = {},
): EvidencePage {
  const evidenceId = digest(JSON.stringify([scopeId, source.sessionId, refs.map(({ id, hash }) => ({ id, hash }))]));
  const map = new Map(source.entries.map(entry => [entry.id, entry]));
  const selected = refs.map(ref => {
    const entry = map.get(ref.id);
    if (!entry || entry.hash !== ref.hash) {
      throw new RecallError("stale_evidence", `Original entry ${ref.id} changed or disappeared; rebuild before citing it.`);
    }
    return entry;
  });
  for (let i = 1; i < selected.length; i++) {
    if (selected[i].parentId !== selected[i - 1].id) {
      throw new RecallError("invalid_ancestry", "Evidence range crosses branches or skips source entries.");
    }
  }
  let index = 0;
  let offset = 0;
  if (options.cursor !== undefined) {
    if (selected.length === 0) throw new RecallError("invalid_cursor", "Cursor is outside the empty evidence range.");
    if (options.cursor.length > 512) throw new RecallError("invalid_cursor", "Cursor is too long.");
    let cursor: Record<string, unknown> | undefined;
    try { cursor = object(JSON.parse(Buffer.from(options.cursor, "base64url").toString())); } catch {}
    if (!cursor || cursor.e !== evidenceId || !Number.isSafeInteger(cursor.i) || !Number.isSafeInteger(cursor.o)) {
      throw new RecallError("invalid_cursor", "Cursor does not match this evidence revision.");
    }
    index = cursor.i as number;
    offset = cursor.o as number;
  }
  if (index < 0 || (selected.length > 0 && index >= selected.length) || offset < 0) {
    throw new RecallError("invalid_cursor", "Cursor is outside the evidence range.");
  }
  let remaining = options.maxChars ?? 12_000;
  if (!Number.isSafeInteger(remaining) || remaining < 1000 || remaining > 48_000) {
    throw new RecallError("invalid_budget", "max_chars must be an integer from 1000 to 48000.");
  }
  const fragments: EvidencePage["fragments"] = [];
  while (index < selected.length && remaining > 0) {
    const entry = selected[index];
    const raw = redactJson(entry.raw);
    if (offset >= raw.length) throw new RecallError("invalid_cursor", "Cursor offset is outside the entry.");
    const text = raw.slice(offset, offset + remaining);
    fragments.push({ entry_id: entry.id, line: entry.line, sha256: entry.hash, offset, total_chars: raw.length, text });
    remaining -= text.length;
    offset += text.length;
    if (offset === raw.length) { index++; offset = 0; }
  }
  return {
    source_file: source.file, session_id: source.sessionId, evidence_id: evidenceId,
    content_kind: "redacted_original_json_fragments", fragments,
    next_cursor: index < selected.length
      ? Buffer.from(JSON.stringify({ e: evidenceId, i: index, o: offset })).toString("base64url") : null,
  };
}

export function readSourceEvidence(scopeId: string, source: SessionSource, options: {
  entry_id?: string; before?: number; after?: number; cursor?: string; maxChars?: number;
} = {}): EvidencePage & { context?: { entry_id: string; before: number; after: number; alternate_children: string[] } } {
  const byId = new Map(source.entries.map(entry => [entry.id, entry]));
  let chain: SourceEntry[];
  let context: { entry_id: string; before: number; after: number; alternate_children: string[] } | undefined;
  if (options.entry_id !== undefined) {
    const before = options.before ?? 3;
    const after = options.after ?? 3;
    for (const value of [before, after]) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 50) throw new RecallError("invalid_context", "before and after must be integers from 0 to 50.");
    }
    const target = byId.get(options.entry_id);
    if (!target) throw new RecallError("not_found", "Entry does not belong to this conversation revision.");
    const ancestors: SourceEntry[] = [];
    for (let current: SourceEntry | undefined = target; current; current = current.parentId ? byId.get(current.parentId) : undefined) ancestors.unshift(current);
    const prefix = ancestors.slice(Math.max(0, ancestors.length - before - 1));
    const children = new Map<string, SourceEntry[]>();
    for (const entry of source.entries) {
      if (!entry.parentId) continue;
      const list = children.get(entry.parentId) ?? [];
      list.push(entry);
      children.set(entry.parentId, list);
    }
    const descendants: SourceEntry[] = [];
    const alternateChildren: string[] = [];
    let current: SourceEntry | undefined = target;
    while (descendants.length < after && current) {
      const branches = [...(children.get(current.id) ?? [])].sort((left, right) =>
        right.timestamp.localeCompare(left.timestamp) || right.line - left.line);
      if (branches.length === 0) break;
      if (branches.length > 1) alternateChildren.push(...branches.slice(1).map(entry => entry.id));
      current = branches[0];
      descendants.push(current);
    }
    chain = [...prefix, ...descendants];
    context = { entry_id: target.id, before, after, alternate_children: alternateChildren };
  } else {
    const leaf = source.entries.at(-1);
    chain = [];
    for (let current: SourceEntry | undefined = leaf; current; current = current.parentId ? byId.get(current.parentId) : undefined) chain.unshift(current);
  }
  return { ...evidencePage(scopeId, source, chain.map(({ id, hash }) => ({ id, hash })), options), context };
}
