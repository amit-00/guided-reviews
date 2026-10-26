import { test } from "node:test";
import { request } from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "../src/server.js";
import { demoTour } from "../src/demo.js";
import { loadProgress } from "../src/core/storage.js";
import { git } from "../src/core/git.js";

test("localhost server authenticates, blocks cross-origin writes, persists progress and limits routes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "guided-server-"));
  const tour = demoTour();
  const file = path.join(root, "tour.json");
  const { server, url } = await serve(tour, file, {
    assets: path.resolve("src/viewer"),
  });
  t.after(async () => {
    server.close();
    server.closeAllConnections();
    await rm(root, { recursive: true, force: true });
  });
  const parsed = new URL(url);
  const base = parsed.origin;
  const headers = {
    Authorization: `Bearer ${parsed.hash.slice(1)}`,
    "Content-Type": "application/json",
  };
  assert.equal((await fetch(base + "/api/tour")).status, 401);
  assert.equal(
    (
      await fetch(base + "/api/tour", {
        headers: { ...headers, Origin: "https://evil.invalid" },
      })
    ).status,
    403,
  );
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      base + "/api/tour",
      { headers: { ...headers, Host: "evil.invalid" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(wrongHost, 403);
  const response = await fetch(base + "/api/tour", { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tour.id, tour.id);
  const progress = {
    tourId: tour.id,
    steps: { "payment-boundary": "reviewed" },
  };
  assert.equal(
    (
      await fetch(base + "/api/progress", {
        method: "POST",
        headers,
        body: JSON.stringify(progress),
      })
    ).status,
    200,
  );
  assert.deepEqual(await loadProgress(file, tour), progress);
  assert.equal(
    (
      await fetch(base + "/api/progress", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...progress, tourId: "other" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/api/progress", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...progress, steps: { unknown: "reviewed" } }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/api/progress", {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "x".repeat(40_000) }),
      })
    ).status,
    413,
  );
  assert.equal(
    (await fetch(base + "/api/ask", { method: "POST", headers, body: "{}" }))
      .status,
    400,
  );
  assert.equal((await fetch(base + "/package.json")).status, 404);
  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(
    index.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );
});

test("reports stale revisions without changing the saved tour or progress", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "guided-stale-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["commit", "--allow-empty", "-m", "first"]);
  const sha = (await git(root, ["rev-parse", "HEAD"])).trim();
  const tour = demoTour();
  tour.inventory.headRef = "HEAD";
  tour.inventory.headCommit = sha;
  tour.inventory.baseCommit = sha;
  const { server, url } = await serve(tour, path.join(root, "tour.json"), {
    repo: root,
  });
  t.after(async () => {
    server.close();
    server.closeAllConnections();
    await rm(root, { recursive: true, force: true });
  });
  const parsed = new URL(url);
  const headers = { Authorization: `Bearer ${parsed.hash.slice(1)}` };
  assert.equal(
    (await (await fetch(parsed.origin + "/api/tour", { headers })).json())
      .freshness,
    "current",
  );
  await git(root, ["commit", "--allow-empty", "-m", "next"]);
  const data = await (
    await fetch(parsed.origin + "/api/tour", { headers })
  ).json();
  assert.equal(data.freshness, "stale");
  assert.equal(data.tour.inventory.headCommit, sha);
});
