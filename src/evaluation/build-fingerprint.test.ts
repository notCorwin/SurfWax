// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildFingerprint, evaluationFingerprint, fileFingerprint } from "../../e2e/evaluation/build-fingerprint";

it("fingerprints build paths and contents independently of creation order", async () => {
  const root = await mkdtemp(join(tmpdir(), "surfwax-fingerprint-")), first = join(root, "first"), second = join(root, "second");
  try {
    await Promise.all([mkdir(first), mkdir(second)]);
    const manifest = '{"manifest_version":3,"version":"1.2.3"}';
    await writeFile(join(first, "manifest.json"), manifest);
    await writeFile(join(first, "app.js"), "content");
    await writeFile(join(second, "app.js"), "content");
    await writeFile(join(second, "manifest.json"), manifest);
    const initial = await buildFingerprint(first);
    expect(initial).toMatchObject({ files: 2, manifestVersion: 3, extensionVersion: "1.2.3", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await buildFingerprint(second)).toEqual(initial);
    expect(await fileFingerprint(join(first, "app.js"))).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(second, "app.js"), "modified");
    expect((await buildFingerprint(second)).sha256).not.toBe(initial.sha256);
    await writeFile(join(second, "app.js"), await readFile(join(first, "app.js")));
    await writeFile(join(second, "extra.js"), "content");
    expect((await buildFingerprint(second)).sha256).not.toBe(initial.sha256);
    await symlink(join(first, "app.js"), join(second, "link.js"));
    await expect(buildFingerprint(second)).rejects.toThrow(/symbolic link/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("fingerprints evaluator and scoring sources separately, and fails closed when evidence is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "surfwax-evaluation-fingerprint-"));
  try {
    await mkdir(join(root, "e2e/evaluation"), { recursive: true });
    await mkdir(join(root, "src"));
    for (const file of ["e2e/real-model-evaluation.spec.ts", "e2e/fixtures.ts", "playwright.config.ts", "src/logging.ts", "src/log-graph.ts", "src/artifact-graph.ts", "e2e/evaluation/network-level-fixture.ts"]) {
      await writeFile(join(root, file), file);
    }
    const first = await evaluationFingerprint(root);
    expect(first).toMatchObject({ files: 7, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await writeFile(join(root, "e2e/evaluation/network-level-fixture.spec.ts"), "test only");
    expect(await evaluationFingerprint(root)).toEqual(first);
    await writeFile(join(root, "e2e/evaluation/network-level-fixture.ts"), "changed score");
    expect((await evaluationFingerprint(root)).sha256).not.toBe(first.sha256);
    await rm(join(root, "src/logging.ts"));
    await expect(evaluationFingerprint(root)).rejects.toThrow();
    await symlink(join(root, "src/log-graph.ts"), join(root, "src/logging.ts"));
    await expect(evaluationFingerprint(root)).rejects.toThrow(/regular file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
