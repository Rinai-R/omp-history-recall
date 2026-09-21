import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type SdkPatch = {
  package: string;
  version: string;
  files: {
    file: string;
    beforeSha256: string;
    afterSha256: string;
    edits: { before: string; after: string }[];
  }[];
};
const patchFile = new URL("../patches/omp-sdk-18.2.6.json", import.meta.url);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Development-only patch: never searches for or changes a global OMP installation. */
export async function applyOmpPatch(root = projectRoot): Promise<"applied" | "already_applied"> {
  const patches = (JSON.parse(await fs.readFile(patchFile, "utf8")) as { packages: SdkPatch[] }).packages;
  const canonicalRoot = await fs.realpath(root);
  const changes: { target: string; source: string; patched: string }[] = [];
  // Validate every package and file before modifying any; accept interrupted prior applications.
  for (const patch of patches) {
    const packageDir = await fs.realpath(path.join(canonicalRoot, "node_modules", patch.package));
    if (!packageDir.startsWith(path.join(canonicalRoot, "node_modules") + path.sep)) {
      throw new Error("Refusing to patch an SDK outside this project's node_modules.");
    }
    const metadata = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8")) as { name?: string; version?: string };
    if (metadata.name !== patch.package || metadata.version !== patch.version) {
      throw new Error(`Unsupported SDK for settlement patch: expected ${patch.package}@${patch.version}.`);
    }
    for (const file of patch.files) {
      const target = path.resolve(packageDir, file.file);
      if (!target.startsWith(packageDir + path.sep) || await fs.realpath(target) !== target) {
        throw new Error("Refusing to patch a redirected SDK source file.");
      }
      const source = await fs.readFile(target, "utf8");
      const currentHash = sha256(source);
      if (currentHash === file.afterSha256) continue;
      if (currentHash !== file.beforeSha256) throw new Error("SDK source differs from the pinned patch preimage; no files changed.");
      let patched = source;
      for (const edit of file.edits) {
        const at = patched.indexOf(edit.before);
        if (!edit.before || at < 0 || patched.indexOf(edit.before, at + edit.before.length) !== -1) {
          throw new Error("SDK patch hunk is missing or ambiguous; no files changed.");
        }
        patched = patched.slice(0, at) + edit.after + patched.slice(at + edit.before.length);
      }
      if (sha256(patched) !== file.afterSha256) throw new Error("SDK patch postimage verification failed; no files changed.");
      changes.push({ target, source, patched });
    }
  }
  if (!changes.length) return "already_applied";
  // Manifest order publishes the shared iterator fix before the capability marker.
  for (const { target, source, patched } of changes) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const stat = await fs.stat(target);
      await fs.writeFile(temporary, patched, { mode: stat.mode & 0o777 });
      if (await fs.readFile(target, "utf8") !== source) throw new Error("SDK source changed during patch preparation; this file was not changed.");
      // Atomic replacement also prevents mutating a package-cache hard link.
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  return "applied";
}

if (import.meta.main) {
  try { console.log(`OMP SDK 18.2.6 settlement patch: ${await applyOmpPatch()}.`); }
  catch (error) { console.error(error instanceof Error ? error.message : "SDK settlement patch failed."); process.exitCode = 1; }
}
