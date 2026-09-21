import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyOmpPatch } from "../scripts/apply-omp-patch";

type Patch = { package: string; version: string; files: { file: string; beforeSha256: string; afterSha256: string; edits: { before: string; after: string }[] }[] };
const patches = (JSON.parse(await fs.readFile(new URL("../patches/omp-sdk-18.2.6.json", import.meta.url), "utf8")) as { packages: Patch[] }).packages;
const patchFiles = patches.flatMap(patch => patch.files.map(file => ({ ...file, package: patch.package })));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function originalSource(file: Patch["files"][number] & { package: string }) {
  let source = await fs.readFile(new URL(`../node_modules/${file.package}/${file.file}`, import.meta.url), "utf8");
  if (hash(source) === file.afterSha256) {
    for (const edit of [...file.edits].reverse()) source = source.replace(edit.after, edit.before);
  }
  expect(hash(source)).toBe(file.beforeSha256);
  return source;
}

async function fixture(version = patches[0].version, source?: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recall-sdk-patch-")));
  roots.push(root);
  const directory = path.join(root, "node_modules", patches[0].package);
  const files = patchFiles.map(file => path.join(root, "node_modules", file.package, file.file));
  for (const patch of patches) {
    const packageDir = path.join(root, "node_modules", patch.package);
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: patch.package, version }));
  }
  for (const [index, file] of files.entries()) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source !== undefined && index === files.length - 1 ? source : await originalSource(patchFiles[index]));
  }
  return { root, directory, files };
}

it("applies only the pinned SDK patch and remains idempotent", async () => {
  const target = await fixture();
  expect(await applyOmpPatch(target.root)).toBe("applied");
  const result = await Promise.all(target.files.map(file => fs.readFile(file, "utf8")));
  expect(result.map(hash)).toEqual(patchFiles.map(file => file.afterSha256));
  expect(await applyOmpPatch(target.root)).toBe("already_applied");
  expect(await Promise.all(target.files.map(file => fs.readFile(file, "utf8")))).toEqual(result);
});

it("leaves unsupported SDK versions and unexpected source revisions untouched", async () => {
  for (const target of [await fixture("19.0.0"), await fixture(patches[0].version, "An independently modified SDK source.\n")]) {
    const source = await Promise.all(target.files.map(file => fs.readFile(file, "utf8")));
    const metadata = await fs.readFile(path.join(target.directory, "package.json"), "utf8");
    await expect(applyOmpPatch(target.root)).rejects.toThrow();
    expect(await Promise.all(target.files.map(file => fs.readFile(file, "utf8")))).toEqual(source);
    expect(await fs.readFile(path.join(target.directory, "package.json"), "utf8")).toBe(metadata);
  }
});

it("refuses redirected SDK source files without modifying their targets", async () => {
  const target = await fixture();
  const external = await fixture();
  const source = await fs.readFile(external.files[0], "utf8");
  await fs.rm(target.files[0]);
  await fs.symlink(external.files[0], target.files[0]);
  await expect(applyOmpPatch(target.root)).rejects.toThrow();
  expect(await fs.readFile(external.files[0], "utf8")).toBe(source);
});
