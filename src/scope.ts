import { getAgentDir, getCustomSessionFilesDir, getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { digest, RecallError } from "./source";

export type RecallScope = {
  id: string;
  agentDir: string;
  sessionsRoot: string;
  customFilesRoot: string;
};
export type SourceAccess = {
  sessionDir?: string;
  activeFile?: string;
  activeSessionId: string;
};
export type SourceWarning = {
  path: string;
  code: "source_missing" | "source_unreadable" | "invalid_registry_entry";
};
export type SourceFileInfo = {
  source_file: string;
  directory: string;
  size_bytes: number;
  mtime_ms: number;
  source_kind: "managed" | "current" | "registered" | "remembered";
};

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

// Resolve the existing ancestor too: /tmp aliases must not change a new profile's identity.
async function canonicalRoot(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await fs.realpath(resolved);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(await canonicalRoot(parent), path.basename(resolved));
  }
}

export async function resolveRecallScope(): Promise<RecallScope> {
  const [agentDir, sessionsRoot, customFilesRoot] = await Promise.all([
    canonicalRoot(getAgentDir()), canonicalRoot(getSessionsDir()), canonicalRoot(getCustomSessionFilesDir()),
  ]);
  return { id: `scope_${digest(agentDir).slice(0, 24)}`, agentDir, sessionsRoot, customFilesRoot };
}

async function inspectFile(file: string, sourceKind: SourceFileInfo["source_kind"], signal?: AbortSignal): Promise<SourceFileInfo> {
  signal?.throwIfAborted();
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) {
    throw new RecallError("invalid_file", "Session source must remain a canonical regular, non-symlink file.");
  }
  await fs.access(file, constants.R_OK);
  signal?.throwIfAborted();
  return {
    source_file: file, directory: path.dirname(file), size_bytes: stat.size,
    mtime_ms: stat.mtimeMs, source_kind: sourceKind,
  };
}

const MAX_MARKER_BYTES = 8192;

async function readMarker(file: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MARKER_BYTES) {
    throw new RecallError("invalid_registry_entry", "Custom session marker must be a small regular, non-symlink file.");
  }
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_MARKER_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino || await fs.realpath(file) !== file) {
      throw new RecallError("invalid_registry_entry", "Custom session marker changed while opening.");
    }
    // A bounded read remains safe if the marker grows after stat.
    const buffer = Buffer.alloc(MAX_MARKER_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    signal?.throwIfAborted();
    if (bytes > MAX_MARKER_BYTES) throw new RecallError("invalid_registry_entry", "Custom session marker exceeds its byte limit.");
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
    } catch {
      throw new RecallError("invalid_registry_entry", "Custom session marker is not UTF-8.");
    }
    if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) {
      throw new RecallError("invalid_registry_entry", "Custom session marker must contain one absolute file path.");
    }
    return value;
  } finally {
    await handle.close();
  }
}

export async function enumerateSources(
  scope: RecallScope,
  access: SourceAccess,
  rememberedFiles: readonly string[],
  signal?: AbortSignal,
): Promise<{ files: SourceFileInfo[]; warnings: SourceWarning[] }> {
  signal?.throwIfAborted();
  const files = new Map<string, SourceFileInfo>();
  const warnings: SourceWarning[] = [];
  const warningKeys = new Set<string>();
  const activeFiles = new Set<string>();
  function warn(file: string, code: SourceWarning["code"]) {
    const key = `${code}\0${file}`;
    if (!warningKeys.has(key)) {
      warningKeys.add(key);
      warnings.push({ path: file, code });
    }
  }
  function failed(file: string, error: unknown) {
    signal?.throwIfAborted();
    warn(file, hasCode(error, "ENOENT") ? "source_missing" : "source_unreadable");
  }
  if (access.activeFile) {
    const active = path.resolve(access.activeFile);
    activeFiles.add(active);
    try { activeFiles.add(await canonicalRoot(active)); } catch (error) { failed(active, error); }
  }

  async function addFile(value: string, kind: SourceFileInfo["source_kind"], expectedDirectory?: string) {
    signal?.throwIfAborted();
    if (!path.isAbsolute(value)) {
      warn(value, "source_unreadable");
      return;
    }
    const resolved = path.resolve(value);
    if (activeFiles.has(resolved)) return;
    try {
      const directory = await fs.realpath(path.dirname(resolved));
      const file = path.join(directory, path.basename(resolved));
      if (expectedDirectory !== undefined && directory !== expectedDirectory) {
        throw new RecallError("invalid_file", "Session directory changed during discovery.");
      }
      if (activeFiles.has(file) || files.has(file)) return;
      files.set(file, await inspectFile(file, kind, signal));
    } catch (error) { failed(resolved, error); }
  }

  async function scanDirectory(value: string, kind: "managed" | "current", buckets: boolean, isBucket = false) {
    signal?.throwIfAborted();
    let directory = path.resolve(value);
    try {
      if (isBucket) {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        if (await fs.realpath(directory) !== directory) {
          throw new RecallError("invalid_file", "Session bucket changed during discovery.");
        }
      } else {
        directory = await fs.realpath(directory);
      }
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const entry of entries) {
        signal?.throwIfAborted();
        const file = path.join(directory, entry.name);
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          await addFile(file, kind, directory);
        } else if (buckets && entry.isDirectory() && !entry.isSymbolicLink()) {
          await scanDirectory(file, kind, false, true);
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      // Absent managed roots are normal on first use, not authorization to scan their parent.
      if (!(kind === "managed" && !isBucket && hasCode(error, "ENOENT"))) failed(directory, error);
    }
  }

  // First discovery wins, establishing managed > current > registered > remembered.
  await scanDirectory(scope.sessionsRoot, "managed", true);
  if (access.sessionDir) await scanDirectory(access.sessionDir, "current", false);

  let registry: string | undefined;
  try { registry = await fs.realpath(scope.customFilesRoot); } catch (error) {
    signal?.throwIfAborted();
    if (!hasCode(error, "ENOENT")) failed(scope.customFilesRoot, error);
  }
  if (registry) {
    try {
      const entries = await fs.readdir(registry);
      for (const name of entries.sort()) {
        signal?.throwIfAborted();
        const marker = path.join(registry, name);
        let registered: string;
        try { registered = await readMarker(marker, signal); } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof RecallError && error.code === "invalid_registry_entry" || hasCode(error, "ELOOP")) {
            warn(marker, "invalid_registry_entry");
          } else { failed(marker, error); }
          continue;
        }
        await addFile(registered, "registered");
      }
    } catch (error) { failed(registry, error); }
  }
  for (const file of rememberedFiles) await addFile(file, "remembered");
  signal?.throwIfAborted();
  return { files: [...files.values()], warnings };
}

export async function validateSourceFile(
  file: string,
  allowed: readonly SourceFileInfo[],
  signal?: AbortSignal,
): Promise<SourceFileInfo> {
  signal?.throwIfAborted();
  const selected = path.isAbsolute(file) ? allowed.find(info => info.source_file === file) : undefined;
  if (!selected) throw new RecallError("invalid_file", "Select an absolute source_file from the current history catalog.");
  try {
    return await inspectFile(file, selected.source_kind, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new RecallError("invalid_file", `Selected session source is missing, unreadable, or no longer canonical: ${file}`);
  }
}
