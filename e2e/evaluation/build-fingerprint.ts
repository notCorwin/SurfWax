import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface BuildFingerprint {
  sha256: string;
  files: number;
  manifestVersion: number | null;
  extensionVersion: string | null;
}

/** Hash the files Chrome will load; reject links rather than overlook their targets. */
export async function buildFingerprint(directory: string): Promise<BuildFingerprint> {
  const paths: string[] = [];
  const walk = async (parent: string): Promise<void> => {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const path = join(parent, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Extension build contains a symbolic link");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error("Extension build contains a non-file entry");
    }
  };
  await walk(directory);
  const items = await Promise.all(paths.map(async (path) => {
    const bytes = await readFile(path);
    return { path: relative(directory, path).split(sep).join("/"), bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  items.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const manifest = items.find((item) => item.path === "manifest.json");
  if (!manifest) throw new Error("Extension manifest missing");
  const parsed: unknown = JSON.parse(manifest.bytes.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid extension manifest");
  const data = parsed as Record<string, unknown>;
  const sha256 = createHash("sha256").update(JSON.stringify(items.map(({ path, bytes, sha256: hash }) => [path, bytes.length, hash]))).digest("hex");
  return { sha256, files: items.length, manifestVersion: typeof data.manifest_version === "number" ? data.manifest_version : null,
    extensionVersion: typeof data.version === "string" ? data.version : null };
}

export async function fileFingerprint(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Hash the evaluator sources, separately from the extension under test. */
export async function evaluationFingerprint(root: string): Promise<{ sha256: string; files: number }> {
  const paths = ["e2e/real-model-evaluation.spec.ts", "e2e/fixtures.ts", "playwright.config.ts",
    "src/logging.ts", "src/log-graph.ts", "src/artifact-graph.ts"];
  const walk = async (parent: string): Promise<void> => {
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      const path = `${parent}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Evaluation sources contain a symbolic link");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".spec.ts")) paths.push(path);
      else if (!entry.isFile()) throw new Error("Evaluation sources contain a non-file entry");
    }
  };
  await walk("e2e/evaluation");
  if (paths.length === 6) throw new Error("Evaluation sources missing");
  paths.sort();
  const items = await Promise.all(paths.map(async (path) => {
    const file = join(root, path);
    if (!(await lstat(file)).isFile()) throw new Error("Evaluation source is not a regular file");
    const bytes = await readFile(file);
    return [path, bytes.length, createHash("sha256").update(bytes).digest("hex")];
  }));
  return { sha256: createHash("sha256").update(JSON.stringify(items)).digest("hex"), files: items.length };
}
