import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { Hunk, Inventory, Snapshot } from "./schema.js";
const exec = promisify(execFile);
const MAX_FILE = 60_000;
const MAX_CONTEXT = 240_000;
const MAX_DIFF = 2_000_000;

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(
      "git",
      [
        "--literal-pathspecs",
        "-c",
        "core.quotePath=false",
        "-c",
        "color.ui=false",
        ...args,
      ],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    return stdout;
  } catch (error) {
    const e = error as Error & { stderr?: string };
    throw new Error(`Git: ${e.stderr?.trim() || e.message}`);
  }
}
export async function resolveCommit(cwd: string, ref: string) {
  return (
    await git(cwd, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ])
  ).trim();
}
export function excluded(file: string) {
  return /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\.json)?|id_rsa|id_ed25519)$|\.(pem|key|p12|pfx)$/i.test(
    file,
  );
}
export function parseHunks(
  diff: string,
  file: { path: string; oldPath: string; status: string },
  offset: number,
): Hunk[] {
  const matches = [
    ...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm),
  ];
  return matches.map((m, index) => ({
    ...file,
    id: `h${offset + index + 1}`,
    kind: "text",
    limitation: null,
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
    diff: diff.slice(m.index, matches[index + 1]?.index ?? diff.length),
  }));
}

export async function collect(
  cwd: string,
  baseRef: string,
  headRef: string,
): Promise<Inventory> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const [baseCommit, headCommit] = await Promise.all([
    resolveCommit(root, baseRef),
    resolveCommit(root, headRef),
  ]);
  const mergeBase = (
    await git(root, ["merge-base", baseCommit, headCommit])
  ).trim();
  const raw = (
    await git(root, [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      mergeBase,
      headCommit,
      "--",
    ])
  ).split("\0");
  const files: { path: string; oldPath: string; status: string }[] = [];
  for (let i = 0; i < raw.length && raw[i];) {
    const status = raw[i++];
    const oldPath = raw[i++];
    const newPath = /^[RC]/.test(status) ? raw[i++] : oldPath;
    files.push({ status, path: newPath, oldPath });
  }
  const inventory: Inventory = {
    repoName: path.basename(root),
    baseRef,
    headRef,
    baseCommit,
    mergeBase,
    headCommit,
    hunks: [],
    snapshots: [],
    limitations: [],
  };
  if ((await git(root, ["status", "--porcelain"])).trim())
    inventory.limitations.push(
      "Uncommitted and untracked changes are not included. This tour reviews committed revisions only.",
    );
  if (!files.length)
    throw new Error(
      "No committed changes between the merge-base and head. Commit your changes or select different revisions.",
    );
  let budget = MAX_CONTEXT;
  let diffBudget = MAX_DIFF;
  const read = async (
    file: string,
    side: "base" | "head",
  ): Promise<Snapshot | undefined> => {
    const sha = side === "base" ? mergeBase : headCommit;
    try {
      const size = Number(
        (await git(root, ["cat-file", "-s", `${sha}:${file}`])).trim(),
      );
      if (size > MAX_FILE || size > budget) return;
      const content = await git(root, ["show", `${sha}:${file}`]);
      if (content.includes("\0")) return;
      budget -= content.length;
      const snapshot = { path: file, side, content };
      inventory.snapshots.push(snapshot);
      return snapshot;
    } catch {
      return;
    }
  };
  for (const file of files) {
    const omitted = excluded(file.path) || excluded(file.oldPath);
    const empty: Hunk = {
      ...file,
      id: `h${inventory.hunks.length + 1}`,
      oldStart: 0,
      oldCount: 0,
      newStart: 0,
      newCount: 0,
      diff: "",
      kind: "excluded",
      limitation: null,
    };
    if (omitted || diffBudget <= 0) {
      empty.limitation = omitted
        ? "Sensitive filename excluded from analysis and saved source."
        : "Diff budget exhausted; file not analyzed.";
      inventory.hunks.push(empty);
      continue;
    }
    // Never execute repository diff drivers or text conversion commands.
    let diff: string;
    try {
      diff = await git(root, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--unified=3",
        mergeBase,
        headCommit,
        "--",
        ...new Set([file.oldPath, file.path]),
      ]);
    } catch (e) {
      empty.limitation = `Diff unavailable: ${(e as Error).message}`;
      inventory.hunks.push(empty);
      continue;
    }
    if (diff.length > diffBudget) {
      empty.limitation =
        "File diff exceeds the remaining diff budget; not analyzed.";
      inventory.hunks.push(empty);
      continue;
    }
    diffBudget -= diff.length;
    const binary = /^Binary files /m.test(diff) || /^Submodule /m.test(diff);
    if (binary) {
      inventory.hunks.push({
        ...empty,
        kind: "binary",
        diff,
        limitation: "Binary or submodule content is not analyzed.",
      });
      continue;
    }
    const before = file.status.startsWith("A")
      ? undefined
      : await read(file.oldPath, "base");
    const after = file.status.startsWith("D")
      ? undefined
      : await read(file.path, "head");
    const incomplete =
      (!before && !file.status.startsWith("A")) ||
      (!after && !file.status.startsWith("D"));
    const hunks = parseHunks(diff, file, inventory.hunks.length);
    if (!hunks.length) hunks.push({ ...empty, kind: "metadata", diff });
    if (incomplete)
      for (const h of hunks)
        h.limitation =
          "Source unavailable, binary, or exceeds the source/context budget; inspect the local diff.";
    inventory.hunks.push(...hunks);
  }
  // Bounded neighboring context: local imports, matching tests, and repository overview.
  const tracked = (
    await git(root, ["ls-tree", "-r", "--name-only", "-z", headCommit])
  )
    .split("\0")
    .filter(Boolean);
  const trackedSet = new Set(tracked);
  const candidates = new Set<string>();
  for (const s of inventory.snapshots.filter((s) => s.side === "head")) {
    for (const match of s.content.matchAll(
      /(?:from\s*|require\s*\(|import\s*)['"](\.[^'"]+)['"]/g,
    )) {
      const stem = path.posix.normalize(
        path.posix.join(path.posix.dirname(s.path), match[1]),
      );
      const bare = stem.replace(/\.[cm]?js$/, "");
      for (const name of [
        stem,
        `${stem}.ts`,
        `${stem}.tsx`,
        `${stem}.js`,
        `${bare}.ts`,
        `${bare}.tsx`,
        `${stem}/index.ts`,
        `${stem}/index.js`,
      ])
        if (trackedSet.has(name)) candidates.add(name);
    }
    const stem = path.posix.basename(s.path).replace(/\.[^.]+$/, "");
    for (const name of tracked)
      if (
        path.posix.basename(name).startsWith(stem + ".") &&
        /\.(test|spec)\./.test(name)
      )
        candidates.add(name);
  }
  for (const name of tracked.filter((n) => /^readme\.(md|txt)$/i.test(n)))
    candidates.add(name);
  let added = 0;
  for (const name of candidates) {
    if (added >= 12) break;
    if (
      excluded(name) ||
      inventory.snapshots.some((s) => s.path === name && s.side === "head")
    )
      continue;
    if (await read(name, "head")) added++;
  }
  inventory.limitations.push(
    "Context uses changed files plus bounded local imports, matching tests, and README files. Dynamic calls, external systems, and whole-repository behavior may be missing.",
  );
  return inventory;
}
