import { z } from "zod";

export const evidenceSchema = z.object({
  path: z.string(),
  side: z.enum(["base", "head"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  explanation: z.string(),
});
export const planSchema = z.object({
  title: z.string().min(1),
  summary: z.string(),
  architecture: z.string(),
  steps: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
      title: z.string().min(1),
      category: z.enum([
        "architecture",
        "integration",
        "abstraction",
        "data-flow",
        "logic",
        "tests",
        "rollout",
      ]),
      before: z.string(),
      after: z.string(),
      why: z.string(),
      questions: z.array(z.string()),
      uncertainties: z.array(z.string()),
      evidence: z.array(evidenceSchema).min(1),
      hunkIds: z.array(z.string()),
    }),
  ),
  supporting: z.array(
    z.object({
      title: z.string(),
      reason: z.string().min(1),
      hunkIds: z.array(z.string()).min(1),
    }),
  ),
  limitations: z.array(z.string()),
});
export type Plan = z.infer<typeof planSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;

export const snapshotSchema = z.object({
  path: z.string(),
  side: z.enum(["base", "head"]),
  content: z.string(),
});
export const hunkSchema = z.object({
  id: z.string(),
  path: z.string(),
  oldPath: z.string(),
  status: z.string(),
  oldStart: z.number(),
  oldCount: z.number(),
  newStart: z.number(),
  newCount: z.number(),
  diff: z.string(),
  kind: z.enum(["text", "metadata", "binary", "excluded"]),
  limitation: z.string().nullable(),
});
export const inventorySchema = z.object({
  repoName: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  baseCommit: z.string(),
  mergeBase: z.string(),
  headCommit: z.string(),
  hunks: z.array(hunkSchema),
  snapshots: z.array(snapshotSchema),
  limitations: z.array(z.string()),
});
export type Inventory = z.infer<typeof inventorySchema>;
export type Hunk = z.infer<typeof hunkSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export const tourSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  createdAt: z.string(),
  provider: z.enum(["codex", "openai", "demo"]),
  model: z.string(),
  inventory: inventorySchema,
  plan: planSchema,
  unanalyzed: z.array(z.object({ hunkId: z.string(), reason: z.string() })),
});
export type Tour = z.infer<typeof tourSchema>;
export const progressSchema = z.object({
  tourId: z.string(),
  steps: z.record(z.string(), z.enum(["reviewed", "follow-up"])),
});
export type Progress = z.infer<typeof progressSchema>;

export function lineCount(content: string): number {
  return content === ""
    ? 0
    : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

export function validateEvidence(
  evidence: Evidence,
  inventory: Inventory,
): void {
  const snapshot = inventory.snapshots.find(
    (s) => s.path === evidence.path && s.side === evidence.side,
  );
  if (
    !snapshot ||
    evidence.endLine < evidence.startLine ||
    evidence.endLine > lineCount(snapshot.content)
  ) {
    throw new Error(
      `Invalid evidence: ${evidence.side}:${evidence.path}:${evidence.startLine}-${evidence.endLine}`,
    );
  }
}

export function validatePlan(input: unknown, inventory: Inventory): Plan {
  const plan = planSchema.parse(input);
  const hunkMap = new Map(inventory.hunks.map((h) => [h.id, h]));
  const assigned = new Set<string>();
  const ids = new Set<string>();
  const claim = (id: string) => {
    const h = hunkMap.get(id);
    if (!h) throw new Error(`Unknown hunk: ${id}`);
    if (h.limitation)
      throw new Error(`Cannot mark unanalyzed hunk as covered: ${id}`);
    if (assigned.has(id))
      throw new Error(`Hunk assigned more than once: ${id}`);
    assigned.add(id);
  };
  for (const step of plan.steps) {
    if (ids.has(step.id)) throw new Error(`Duplicate step ID: ${step.id}`);
    ids.add(step.id);
    step.evidence.forEach((e) => validateEvidence(e, inventory));
    for (const id of step.hunkIds) {
      claim(id);
      const h = hunkMap.get(id)!;
      const anchored = step.evidence.some((e) => {
        const path = e.side === "head" ? h.path : h.oldPath;
        const start = e.side === "head" ? h.newStart : h.oldStart;
        const count = e.side === "head" ? h.newCount : h.oldCount;
        return (
          e.path === path &&
          (h.kind === "metadata" ||
            (count > 0 && e.endLine >= start && e.startLine < start + count))
        );
      });
      if (!anchored)
        throw new Error(`Step ${step.id} has no evidence overlapping ${id}`);
    }
  }
  for (const group of plan.supporting) group.hunkIds.forEach(claim);
  return plan;
}

export function validateTour(input: unknown): Tour {
  const tour = tourSchema.parse(input);
  validatePlan(tour.plan, tour.inventory);
  const expected = unaccounted(tour.plan, tour.inventory)
    .map((h) => h.hunkId)
    .sort();
  const actual = tour.unanalyzed.map((h) => h.hunkId).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("Tour coverage inventory is inconsistent");
  return tour;
}

export function unaccounted(plan: Plan, inventory: Inventory) {
  const covered = new Set([
    ...plan.steps.flatMap((s) => s.hunkIds),
    ...plan.supporting.flatMap((g) => g.hunkIds),
  ]);
  return inventory.hunks
    .filter((h) => !covered.has(h.id))
    .map((h) => ({
      hunkId: h.id,
      reason:
        h.limitation ??
        "The model did not include this change in the tour. Inspect it in the full inventory.",
    }));
}
