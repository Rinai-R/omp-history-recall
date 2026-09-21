import { afterEach, describe, expect, it } from "bun:test";
import { __resetDirsFromEnvForTests, getCustomSessionFilesDir, getSessionsDir, setAgentDir, setProfile } from "@oh-my-pi/pi-utils/dirs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { enumerateSources, resolveRecallScope, validateSourceFile, type RecallScope } from "../src/scope";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recall-scope-")));
  roots.push(root);
  const scope: RecallScope = {
    id: "scope_fixture", agentDir: path.join(root, "agent"),
    sessionsRoot: path.join(root, "agent", "sessions"), customFilesRoot: path.join(root, "agent", "custom-session-files"),
  };
  return { root, scope };
}

async function session(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: path.basename(file), cwd: path.dirname(file), timestamp: "2026-09-20T00:00:00Z" })}\n`);
  return file;
}

async function marker(scope: RecallScope, name: string, content: string | Buffer) {
  await fs.mkdir(scope.customFilesRoot, { recursive: true });
  const file = path.join(scope.customFilesRoot, name);
  await fs.writeFile(file, content);
  return file;
}

async function isolatedResolver(root: string, run: () => Promise<void>) {
  const keys = ["HOME", "OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
  const original = new Map(keys.map(key => [key, process.env[key]]));
  try {
    process.env.HOME = root;
    delete process.env.OMP_PROFILE;
    delete process.env.PI_PROFILE;
    delete process.env.PI_CODING_AGENT_DIR;
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
      process.env[key] = path.join(root, key.toLowerCase());
    }
    __resetDirsFromEnvForTests();
    await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetDirsFromEnvForTests();
  }
}

const access = { activeSessionId: "active" };

describe("profile source authorization", () => {
  it("discovers shallow managed buckets, a flat current directory, and only exact custom files", async () => {
    const { root, scope } = await fixture();
    const managed = await session(path.join(scope.sessionsRoot, "top.jsonl"));
    const bucket = await session(path.join(scope.sessionsRoot, "bucket", "past.jsonl"));
    await session(path.join(scope.sessionsRoot, "bucket", "artifacts", "hidden.jsonl"));
    await session(path.join(scope.sessionsRoot, "bucket", "agents", "worker", "hidden.jsonl"));
    const currentDir = path.join(root, "current");
    const current = await session(path.join(currentDir, "current-past.jsonl"));
    await session(path.join(currentDir, "nested", "hidden.jsonl"));
    await session(path.join(root, "current-sibling", "hidden.jsonl"));
    const registered = await session(path.join(root, "custom", "exact.jsonl"));
    const sibling = await session(path.join(root, "custom", "not-registered.jsonl"));
    const remembered = await session(path.join(root, "remembered", "exact.jsonl"));
    await session(path.join(root, "remembered", "not-remembered.jsonl"));
    await session(path.join(root, "other-profile", "sessions", "foreign.jsonl"));
    await marker(scope, "exact", registered);
    const result = await enumerateSources(scope, { ...access, sessionDir: currentDir }, [remembered]);
    expect(result.warnings).toEqual([]);
    expect(result.files.map(file => file.source_file).sort()).toEqual([managed, bucket, current, registered, remembered].sort());
    expect(Object.fromEntries(result.files.map(file => [file.source_file, file.source_kind]))).toEqual({
      [managed]: "managed", [bucket]: "managed", [current]: "current", [registered]: "registered", [remembered]: "remembered",
    });
    await expect(validateSourceFile(sibling, result.files)).rejects.toMatchObject({ code: "invalid_file" });
    for (const file of result.files) {
      const stat = await fs.stat(file.source_file);
      expect(file.size_bytes).toBe(stat.size);
      expect(file.mtime_ms).toBe(stat.mtimeMs);
      expect(file.directory).toBe(path.dirname(file.source_file));
    }
  });

  it("deduplicates canonical aliases with managed, current, registered, remembered precedence", async () => {
    const { root, scope } = await fixture();
    const managed = await session(path.join(scope.sessionsRoot, "bucket", "managed.jsonl"));
    const currentDir = path.join(root, "custom");
    const current = await session(path.join(currentDir, "current.jsonl"));
    const registered = await session(path.join(root, "registered", "registered.jsonl"));
    const alias = path.join(root, "alias");
    await fs.symlink(currentDir, alias);
    await marker(scope, "managed", managed);
    await marker(scope, "current", path.join(alias, "current.jsonl"));
    await marker(scope, "registered", registered);
    const result = await enumerateSources(scope, { ...access, sessionDir: alias }, [current, registered, managed]);
    expect(result.files.map(file => [file.source_file, file.source_kind]).sort()).toEqual([
      [managed, "managed"], [current, "current"], [registered, "registered"],
    ].sort());
    const overlapping = await enumerateSources(scope, { ...access, sessionDir: path.dirname(managed) }, [managed]);
    expect(overlapping.files.find(file => file.source_file === managed)?.source_kind).toBe("managed");
    await expect(validateSourceFile(path.join(alias, "current.jsonl"), result.files)).rejects.toMatchObject({ code: "invalid_file" });
  });

  it("allows explicitly registered extensionless transcripts without authorizing siblings", async () => {
    const { root, scope } = await fixture();
    const selected = await session(path.join(root, "custom", "selected"));
    await session(path.join(root, "custom", "sibling.jsonl"));
    await marker(scope, "selected", selected);
    const result = await enumerateSources(scope, access, []);
    expect(result.files.map(file => file.source_file)).toEqual([selected]);
    expect((await validateSourceFile(selected, result.files)).source_file).toBe(selected);
  });

  it("excludes active paths through directory and file aliases from every source kind", async () => {
    const { root, scope } = await fixture();
    const active = await session(path.join(scope.sessionsRoot, "bucket", "active.jsonl"));
    const past = await session(path.join(scope.sessionsRoot, "bucket", "past.jsonl"));
    const directoryAlias = path.join(root, "bucket-alias");
    const fileAlias = path.join(root, "active-alias.jsonl");
    await fs.symlink(path.dirname(active), directoryAlias);
    await fs.symlink(active, fileAlias);
    await marker(scope, "active", active);
    for (const activeFile of [path.join(directoryAlias, "active.jsonl"), fileAlias]) {
      const result = await enumerateSources(scope, { ...access, activeFile, sessionDir: directoryAlias }, [active]);
      expect(result.files.map(file => file.source_file)).toEqual([past]);
    }
  });

  it("does not traverse symlink buckets or accept symlink leaves, even when registered", async () => {
    const { root, scope } = await fixture();
    const kept = await session(path.join(scope.sessionsRoot, "kept.jsonl"));
    const foreign = await session(path.join(root, "foreign", "foreign.jsonl"));
    await fs.symlink(path.dirname(foreign), path.join(scope.sessionsRoot, "linked-bucket"));
    const leaf = path.join(scope.sessionsRoot, "linked.jsonl");
    await fs.symlink(foreign, leaf);
    await marker(scope, "linked", leaf);
    const result = await enumerateSources(scope, access, [leaf]);
    expect(result.files.map(file => file.source_file)).toEqual([kept]);
    expect(result.warnings).toContainEqual({ path: leaf, code: "source_unreadable" });
  });

  it("rejects unsafe registry markers while returning valid and missing-source diagnostics", async () => {
    const { root, scope } = await fixture();
    const kept = await session(path.join(root, "custom", "kept.jsonl"));
    await marker(scope, "valid", kept);
    const invalid = [
      await marker(scope, "relative", "relative.jsonl"),
      await marker(scope, "empty", ""),
      await marker(scope, "multiline", `${kept}\n${kept}`),
      await marker(scope, "nul", `${kept}\0`),
      await marker(scope, "large", `/${"x".repeat(8192)}`),
      await marker(scope, "invalid-utf8", Buffer.from([0xff, 0xfe])),
    ];
    const linked = path.join(scope.customFilesRoot, "linked");
    await fs.symlink(path.join(scope.customFilesRoot, "valid"), linked);
    invalid.push(linked);
    const directory = path.join(scope.customFilesRoot, "directory");
    await fs.mkdir(directory);
    invalid.push(directory);
    const missing = path.join(root, "missing", "gone.jsonl");
    await marker(scope, "missing", missing);
    const result = await enumerateSources(scope, access, []);
    expect(result.files.map(file => file.source_file)).toEqual([kept]);
    for (const file of invalid) expect(result.warnings).toContainEqual({ path: file, code: "invalid_registry_entry" });
    expect(result.warnings).toContainEqual({ path: missing, code: "source_missing" });
  });

  it("does not create missing roots or scan their parents or an empty current directory", async () => {
    const { root, scope } = await fixture();
    await session(path.join(root, "cwd-must-not-be-scanned.jsonl"));
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      expect(await enumerateSources(scope, { ...access, sessionDir: "" }, [])).toEqual({ files: [], warnings: [] });
    } finally { process.chdir(originalCwd); }
    await expect(fs.stat(scope.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
    const missing = path.join(root, "missing-current");
    const result = await enumerateSources(scope, { ...access, sessionDir: missing }, [path.join(root, "missing.jsonl")]);
    expect(result.files).toEqual([]);
    expect(result.warnings).toEqual([
      { path: missing, code: "source_missing" },
      { path: path.join(root, "missing.jsonl"), code: "source_missing" },
    ]);
  });

  it("revalidates selected files against deletion, leaf symlinks, and parent redirection", async () => {
    const { root, scope } = await fixture();
    const selected = await session(path.join(scope.sessionsRoot, "bucket", "selected.jsonl"));
    const foreign = await session(path.join(root, "foreign", "selected.jsonl"));
    const { files } = await enumerateSources(scope, access, []);
    await expect(validateSourceFile("selected.jsonl", files)).rejects.toMatchObject({ code: "invalid_file" });
    await fs.unlink(selected);
    await expect(validateSourceFile(selected, files)).rejects.toMatchObject({ code: "invalid_file" });
    await fs.symlink(foreign, selected);
    await expect(validateSourceFile(selected, files)).rejects.toMatchObject({ code: "invalid_file" });
    await fs.unlink(selected);
    await session(selected);
    const bucket = path.dirname(selected);
    await fs.rename(bucket, `${bucket}-original`);
    await fs.symlink(path.dirname(foreign), bucket);
    await expect(validateSourceFile(selected, files)).rejects.toMatchObject({ code: "invalid_file" });
  });

  it.skipIf(process.getuid?.() === 0)("reports unreadable sources without suppressing readable history", async () => {
    const { root, scope } = await fixture();
    const kept = await session(path.join(scope.sessionsRoot, "kept.jsonl"));
    const blocked = await session(path.join(scope.sessionsRoot, "blocked", "past.jsonl"));
    const remembered = await session(path.join(root, "remembered.jsonl"));
    const unreadableMarker = await marker(scope, "blocked-marker", remembered);
    const before = await enumerateSources(scope, access, [remembered]);
    await fs.chmod(path.dirname(blocked), 0);
    await fs.chmod(remembered, 0);
    await fs.chmod(unreadableMarker, 0);
    try {
      const result = await enumerateSources(scope, access, [remembered]);
      expect(result.files.map(file => file.source_file)).toEqual([kept]);
      expect(result.warnings).toContainEqual({ path: path.dirname(blocked), code: "source_unreadable" });
      expect(result.warnings).toContainEqual({ path: remembered, code: "source_unreadable" });
      expect(result.warnings).toContainEqual({ path: unreadableMarker, code: "source_unreadable" });
      await expect(validateSourceFile(remembered, before.files)).rejects.toMatchObject({ code: "invalid_file" });
    } finally {
      await fs.chmod(path.dirname(blocked), 0o700);
      await fs.chmod(remembered, 0o600);
      await fs.chmod(unreadableMarker, 0o600);
    }
  });

  it("propagates cancellation rather than returning a partial successful catalog", async () => {
    const { scope } = await fixture();
    const selected = await session(path.join(scope.sessionsRoot, "past.jsonl"));
    const { files } = await enumerateSources(scope, access, []);
    const reason = new Error("cancel discovery");
    await expect(enumerateSources(scope, access, [], AbortSignal.abort(reason))).rejects.toBe(reason);
    await expect(validateSourceFile(selected, files, AbortSignal.abort(reason))).rejects.toBe(reason);
    const controller = new AbortController();
    const pending = enumerateSources(scope, access, [], controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

describe("profile scope resolution", () => {
  it("keeps a missing profile's identity stable across alias resolution and directory creation", async () => {
    const { root } = await fixture();
    await isolatedResolver(root, async () => {
      const real = path.join(root, "real");
      const alias = path.join(root, "alias");
      await fs.mkdir(real);
      await fs.symlink(real, alias);
      setAgentDir(path.join(alias, "not-created", "agent"));
      const before = await resolveRecallScope();
      expect(before.agentDir).toBe(path.join(real, "not-created", "agent"));
      expect(before.id).toMatch(/^scope_[a-f0-9]{24}$/);
      await expect(fs.stat(before.agentDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await enumerateSources(before, access, [])).files).toEqual([]);
      await fs.mkdir(before.sessionsRoot, { recursive: true });
      await fs.mkdir(before.customFilesRoot, { recursive: true });
      expect(await resolveRecallScope()).toEqual(before);
      setAgentDir(before.agentDir);
      expect(await resolveRecallScope()).toEqual(before);
    });
  });

  it("does not treat non-directory ancestors as missing roots", async () => {
    const { root } = await fixture();
    await isolatedResolver(root, async () => {
      const file = path.join(root, "not-a-directory");
      await fs.writeFile(file, "occupied");
      setAgentDir(path.join(file, "agent"));
      await expect(resolveRecallScope()).rejects.toMatchObject({ code: "ENOTDIR" });
    });
  });

  it.skipIf(process.getuid?.() === 0)("preserves root permission errors instead of inventing a scope", async () => {
    const { root } = await fixture();
    await isolatedResolver(root, async () => {
      const blocked = path.join(root, "blocked");
      await fs.mkdir(blocked);
      setAgentDir(path.join(blocked, "agent"));
      await fs.chmod(blocked, 0);
      try { await expect(resolveRecallScope()).rejects.toMatchObject({ code: "EACCES" }); }
      finally { await fs.chmod(blocked, 0o700); }
    });
  });

  it("uses the active profile's separate data and registry resolvers, including XDG roots", async () => {
    const { root } = await fixture();
    await isolatedResolver(root, async () => {
      for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
        for (const profile of ["first", "second"]) {
          await fs.mkdir(path.join(process.env[key]!, "omp", "profiles", profile), { recursive: true });
        }
      }
      setProfile("first");
      const first = await resolveRecallScope();
      const firstFile = await session(path.join(first.sessionsRoot, "bucket", "first.jsonl"));
      const custom = await session(path.join(root, "external", "registered.jsonl"));
      await marker(first, "registered", custom);
      expect(first.sessionsRoot).toBe(await fs.realpath(getSessionsDir()));
      expect(first.customFilesRoot).toBe(await fs.realpath(getCustomSessionFilesDir()));
      if (process.platform === "linux" || process.platform === "darwin") {
        expect(first.sessionsRoot).toBe(path.join(process.env.XDG_DATA_HOME!, "omp", "profiles", "first", "sessions"));
        expect(first.customFilesRoot).toBe(path.join(process.env.XDG_STATE_HOME!, "omp", "profiles", "first", "custom-session-files"));
      }
      setProfile("second");
      const second = await resolveRecallScope();
      const secondFile = await session(path.join(second.sessionsRoot, "bucket", "second.jsonl"));
      expect(second.id).not.toBe(first.id);
      expect((await enumerateSources(second, access, [])).files.map(file => file.source_file)).toEqual([secondFile]);
      expect((await enumerateSources(first, access, [])).files.map(file => file.source_file).sort()).toEqual([firstFile, custom].sort());
    });
  });
});
