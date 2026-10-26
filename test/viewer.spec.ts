import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
let child: ChildProcess;
let directory: string;
let viewerUrl: string;
test.beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "guided-viewer-"));
  child = spawn(
    process.execPath,
    [
      "dist/cli.js",
      "demo",
      "--no-open",
      "--output",
      path.join(directory, "demo.json"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  viewerUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#\w+/);
      if (match) resolve(match[0]);
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Viewer exited: ${code}`)));
  });
});
test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const closed = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await closed;
  }
  await rm(directory, { recursive: true, force: true });
});
test("navigates evidence, saves progress, expands code, inspects complete diff, and fits mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(viewerUrl);
  await expect(
    page.getByRole("heading", { name: "Make payment retries safe" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/guided-review-overview.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Begin the review" }).click();
  await expect(
    page.getByRole("heading", { name: "Follow the payment boundary" }),
  ).toBeVisible();
  await expect(
    page.getByText("Is order.id stable and unique across every tenant?"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(
    page.getByRole("button", { name: "✓ Reviewed", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /Follow the payment boundary/ })
    .click();
  await expect(
    page.getByRole("button", { name: "✓ Reviewed", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Expand full file · 6 lines" })
    .click();
  await expect(
    page.getByRole("button", { name: "Focus on cited lines" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/guided-review-step.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Next stop" }).click();
  await expect(
    page.getByRole("heading", { name: "Check the retry guarantee" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Follow up", exact: false })
    .last()
    .click();
  await expect(page.getByText(/1 flagged for follow-up/)).toBeVisible();
  await page.getByRole("button", { name: "Review coverage" }).click();
  await expect(
    page.getByRole("heading", { name: "Nothing disappears." }),
  ).toBeVisible();
  await page.locator("summary").filter({ hasText: "src/charge.ts" }).click();
  await expect(page.getByLabel("Diff for src/charge.ts")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /The big picture/ }).click();
  await expect(
    page.getByRole("heading", { name: "Make payment retries safe" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
