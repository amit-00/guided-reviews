import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect, git, parseHunks } from "../src/core/git.js";
import { demoTour } from "../src/demo.js";
import { validatePlan, validateTour, unaccounted } from "../src/core/schema.js";
import {
  loadProgress,
  saveTour,
  loadTour,
  atomicWrite,
  markdown,
} from "../src/core/storage.js";
import { analysisContext } from "../src/core/provider.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), "guided-review-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  return root;
}
async function commit(root: string, message: string) {
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", message]);
}

test("collects from merge-base, handles renames/deletions/binary/unusual paths, excludes sensitive files", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src/original.ts"),
    "export const value = 1;\n".repeat(20),
  );
  await writeFile(path.join(root, "gone.ts"), "export const removed = true;\n");
  await writeFile(path.join(root, "base-only.ts"), "export const base = 1;\n");
  await commit(root, "base");
  const base = (await git(root, ["rev-parse", "HEAD"])).trim();
  await git(root, ["checkout", "-b", "feature"]);
  await git(root, ["mv", "src/original.ts", "src/renamed.ts"]);
  await writeFile(
    path.join(root, "src/renamed.ts"),
    "export const value = 2;\n" + "export const value = 1;\n".repeat(19),
  );
  await rm(path.join(root, "gone.ts"));
  await writeFile(
    path.join(root, "odd [name]\nfile.ts"),
    "export const odd = true;\n",
  );
  await writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 0, 255]));
  await writeFile(path.join(root, ".env"), "SECRET=never-send-this\n");
  await commit(root, "feature");
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  await git(root, ["checkout", "main"]);
  await writeFile(path.join(root, "base-only.ts"), "export const base = 2;\n");
  await commit(root, "main moved");
  const result = await collect(root, "main", "feature");
  assert.equal(result.mergeBase, base);
  assert.equal(result.headCommit, head);
  assert.notEqual(result.baseCommit, base);
  assert.ok(
    result.hunks.some(
      (h) => h.path === "src/renamed.ts" && h.oldPath === "src/original.ts",
    ),
  );
  assert.ok(
    result.hunks.some(
      (h) => h.path === "gone.ts" && h.status === "D" && h.newCount === 0,
    ),
  );
  assert.ok(result.hunks.some((h) => h.path === "odd [name]\nfile.ts"));
  assert.ok(
    result.hunks.some((h) => h.path === "image.bin" && h.kind === "binary"),
  );
  assert.ok(!result.hunks.some((h) => h.path === "base-only.ts"));
  assert.ok(
    result.hunks.some((h) => h.path === ".env" && h.kind === "excluded"),
  );
  assert.ok(!JSON.stringify(result).includes("never-send-this"));
  assert.ok(!analysisContext(result).includes("never-send-this"));
});

test("includes bounded unchanged import and test context; ignores dirty worktree", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "logic.ts"), "export const count = 1;\n");
  await writeFile(
    path.join(root, "logic.test.ts"),
    'test("count", () => {});\n',
  );
  await writeFile(path.join(root, "helper.ts"), "export const helper = 2;\n");
  await commit(root, "base");
  await git(root, ["checkout", "-b", "feature"]);
  await writeFile(
    path.join(root, "logic.ts"),
    'import { helper } from "./helper.js";\nexport const count = helper;\n',
  );
  await commit(root, "update");
  await writeFile(path.join(root, "logic.ts"), "UNCOMMITTED_MARKER");
  const result = await collect(root, "main", "HEAD");
  assert.ok(result.snapshots.some((s) => s.path === "helper.ts"));
  assert.ok(result.snapshots.some((s) => s.path === "logic.test.ts"));
  assert.ok(!JSON.stringify(result).includes("UNCOMMITTED_MARKER"));
  assert.ok(result.limitations.some((l) => l.includes("Uncommitted")));
});

test("oversized source is explicitly left unanalyzed and not sent to the model", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "large.ts"), "a\n");
  await commit(root, "base");
  await git(root, ["checkout", "-b", "feature"]);
  await writeFile(path.join(root, "large.ts"), "BIG_MARKER\n".repeat(7000));
  await commit(root, "large");
  const result = await collect(root, "main", "HEAD");
  assert.ok(result.hunks.every((h) => h.limitation));
  assert.ok(!analysisContext(result).includes("BIG_MARKER"));
});

test("handles metadata-only mode changes and empty file additions", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "script.sh"), "#!/bin/sh\necho hello\n");
  await commit(root, "base");
  await git(root, ["checkout", "-b", "feature"]);
  await git(root, ["update-index", "--chmod=+x", "script.sh"]);
  await writeFile(path.join(root, "empty.txt"), "");
  await git(root, ["add", "empty.txt"]);
  await git(root, ["commit", "-m", "metadata"]);
  const result = await collect(root, "main", "HEAD");
  assert.equal(result.hunks.length, 2);
  assert.ok(result.hunks.every((h) => h.kind === "metadata"));
});

test("errors clearly on no changes and invalid revisions", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "a"), "a");
  await commit(root, "base");
  await assert.rejects(collect(root, "main", "HEAD"), /No committed changes/);
  await assert.rejects(collect(root, "--help", "HEAD"), /Git:/);
});

test("parses zero line counts and multiple hunks", () => {
  const h = parseHunks(
    "@@ -1 +0,0 @@\n-a\n@@ -8,2 +7,3 @@\n x\n+y\n z\n",
    { path: "a", oldPath: "a", status: "M" },
    4,
  );
  assert.equal(h[0].id, "h5");
  assert.equal(h[0].oldCount, 1);
  assert.equal(h[0].newCount, 0);
  assert.equal(h[1].newCount, 3);
  assert.ok(!h[0].diff.includes("@@ -8"));
});

test("rejects invented/out-of-range/wrong-side anchors and duplicate coverage", () => {
  const tour = demoTour();
  const bad = structuredClone(tour.plan);
  bad.steps[0].evidence[0].endLine = 999;
  assert.throws(() => validatePlan(bad, tour.inventory), /Invalid evidence/);
  bad.steps[0].evidence[0].endLine = 6;
  bad.steps[0].evidence[0].path = "imaginary.ts";
  assert.throws(() => validatePlan(bad, tour.inventory), /Invalid evidence/);
  const duplicate = structuredClone(tour.plan);
  duplicate.supporting.push({ title: "a", reason: "b", hunkIds: ["h1"] });
  assert.throws(
    () => validatePlan(duplicate, tour.inventory),
    /more than once/,
  );
  const unknown = structuredClone(tour.plan);
  unknown.steps[0].hunkIds.push("h99");
  assert.throws(() => validatePlan(unknown, tour.inventory), /Unknown hunk/);
  const disconnected = structuredClone(tour.plan);
  disconnected.steps[0].evidence = [disconnected.steps[1].evidence[0]];
  assert.throws(
    () => validatePlan(disconnected, tour.inventory),
    /no evidence overlapping/,
  );
});

test("accounts for omitted hunks and rejects false complete coverage", () => {
  const tour = demoTour();
  tour.plan.steps.pop();
  assert.equal(unaccounted(tour.plan, tour.inventory)[0].hunkId, "h2");
  assert.throws(() => validateTour(tour), /coverage inventory/);
  tour.unanalyzed = unaccounted(tour.plan, tour.inventory);
  assert.equal(validateTour(tour).unanalyzed.length, 1);
  tour.inventory.hunks[0].limitation = "not analyzed";
  assert.throws(
    () => validatePlan(tour.plan, tour.inventory),
    /Cannot mark unanalyzed/,
  );
});

test("tour/progress round trips and a new tour never inherits old progress", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "tour.json");
  const tour = demoTour();
  await saveTour(file, tour);
  assert.deepEqual(await loadTour(file), tour);
  await atomicWrite(
    file + ".progress.json",
    JSON.stringify({
      tourId: tour.id,
      steps: { "payment-boundary": "reviewed" },
    }),
  );
  assert.equal(
    (await loadProgress(file, tour)).steps["payment-boundary"],
    "reviewed",
  );
  assert.deepEqual((await loadProgress(file, demoTour())).steps, {});
  assert.match(markdown(tour), /Questions|Review questions/);
  assert.match(markdown(tour), /src\/charge.ts:1-6/);
  assert.ok((await readFile(file, "utf8")).includes('"version": 1'));
});
