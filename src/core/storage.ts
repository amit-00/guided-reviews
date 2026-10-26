import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  validateTour,
  progressSchema,
  type Tour,
  type Progress,
} from "./schema.js";

export async function atomicWrite(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function saveTour(file: string, tour: Tour) {
  await atomicWrite(file, JSON.stringify(validateTour(tour), null, 2) + "\n");
}
export async function loadTour(file: string) {
  return validateTour(JSON.parse(await readFile(file, "utf8")));
}
export async function loadProgress(
  file: string,
  tour: Tour,
): Promise<Progress> {
  try {
    const progress = progressSchema.parse(
      JSON.parse(await readFile(file + ".progress.json", "utf8")),
    );
    return progress.tourId === tour.id
      ? progress
      : { tourId: tour.id, steps: {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { tourId: tour.id, steps: {} };
    throw new Error(
      `Cannot read saved review progress: ${(error as Error).message}`,
    );
  }
}
export function markdown(tour: Tour): string {
  const i = tour.inventory;
  const lines = [
    `# ${tour.plan.title}`,
    "",
    tour.plan.summary,
    "",
    `Repository: ${i.repoName}`,
    `Base: ${i.mergeBase}`,
    `Head: ${i.headCommit}`,
    `Generated: ${tour.createdAt} (${tour.provider}, ${tour.model})`,
    "",
    "## Architecture",
    "",
    tour.plan.architecture,
  ];
  for (const [index, step] of tour.plan.steps.entries()) {
    lines.push(
      "",
      `## ${index + 1}. ${step.title}`,
      "",
      `**Before:** ${step.before}`,
      "",
      `**After:** ${step.after}`,
      "",
      `**Why it matters:** ${step.why}`,
      "",
      "**Review questions**",
      "",
      ...step.questions.map((q) => `- ${q}`),
      "",
      "**Evidence**",
      "",
      ...step.evidence.map(
        (e) =>
          `- ${e.side === "base" ? i.mergeBase : i.headCommit}:${e.path}:${e.startLine}-${e.endLine} — ${e.explanation}`,
      ),
      "",
      ...step.uncertainties.map((u) => `- Uncertainty: ${u}`),
    );
  }
  lines.push(
    "",
    "## Supporting changes",
    "",
    ...tour.plan.supporting.map(
      (g) => `- ${g.title}: ${g.reason} (${g.hunkIds.join(", ")})`,
    ),
    "",
    "## Not analyzed",
    "",
    ...tour.unanalyzed.map(
      (h) =>
        `- ${h.hunkId} (${i.hunks.find((x) => x.id === h.hunkId)?.path}): ${h.reason}`,
    ),
    "",
    "## Limitations",
    "",
    ...[...i.limitations, ...tour.plan.limitations].map((l) => `- ${l}`),
    "",
    "Completing a tour records review progress; it does not establish correctness or approve a PR.",
    "",
  );
  return lines.join("\n");
}
