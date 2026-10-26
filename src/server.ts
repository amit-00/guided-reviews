import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { progressSchema, type Tour } from "./core/schema.js";
import { atomicWrite, loadProgress } from "./core/storage.js";
import { ask, type ModelOptions } from "./core/provider.js";
import { resolveCommit } from "./core/git.js";

export async function serve(
  tour: Tour,
  file: string,
  options: {
    port?: number;
    repo?: string;
    modelOptions?: ModelOptions;
    assets?: string;
  } = {},
) {
  const token = randomBytes(24).toString("hex");
  const assets =
    options.assets ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "viewer");
  let progress = await loadProgress(file, tour);
  let busy = false;
  let saving: Promise<void> = Promise.resolve();
  let origin = "";
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.host !== new URL(origin).host)
        return json(403, { error: "Invalid host" });
      const url = new URL(req.url ?? "/", origin);
      if (url.pathname.startsWith("/api/")) {
        if (req.headers.authorization !== `Bearer ${token}`)
          return json(401, {
            error: "Open the viewer using the full URL printed by the CLI.",
          });
        if (req.headers.origin && req.headers.origin !== origin)
          return json(403, { error: "Invalid origin" });
        if (req.method === "GET" && url.pathname === "/api/tour") {
          let freshness = "unknown";
          if (options.repo) {
            try {
              const [head, base] = await Promise.all([
                resolveCommit(options.repo, tour.inventory.headRef),
                resolveCommit(options.repo, tour.inventory.baseRef),
              ]);
              freshness =
                head === tour.inventory.headCommit &&
                base === tour.inventory.baseCommit
                  ? "current"
                  : "stale";
            } catch {
              /* Saved tour can still be read outside its original repository. */
            }
          }
          return json(200, {
            tour,
            progress,
            freshness,
            canAsk: Boolean(options.modelOptions),
          });
        }
        if (req.method !== "POST")
          return json(405, { error: "Method not allowed" });
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(415, { error: "Expected JSON" });
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 32_768) {
            json(413, { error: "Request too large" });
            return;
          }
        }
        const input = JSON.parse(body);
        if (url.pathname === "/api/progress") {
          const next = progressSchema.parse(input);
          if (
            next.tourId !== tour.id ||
            Object.keys(next.steps).some(
              (id) => !tour.plan.steps.some((s) => s.id === id),
            )
          )
            return json(400, { error: "Progress does not match this tour" });
          saving = saving
            .catch(() => {})
            .then(async () => {
              await atomicWrite(
                file + ".progress.json",
                JSON.stringify(next, null, 2),
              );
              progress = next;
            });
          await saving;
          return json(200, progress);
        }
        if (url.pathname === "/api/ask") {
          if (!options.modelOptions)
            return json(400, {
              error: "Questions are unavailable for this demo.",
            });
          if (
            typeof input.question !== "string" ||
            !input.question.trim() ||
            input.question.length > 4000 ||
            typeof input.stepId !== "string"
          )
            return json(400, {
              error: "Enter a question of 1–4000 characters and a valid step.",
            });
          if (busy)
            return json(429, {
              error: "A question is already being answered.",
            });
          busy = true;
          try {
            return json(
              200,
              await ask(
                tour,
                input.stepId,
                input.question,
                options.modelOptions,
              ),
            );
          } finally {
            busy = false;
          }
        }
        return json(404, { error: "Not found" });
      }
      if (req.method !== "GET")
        return json(405, { error: "Method not allowed" });
      const files: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/app.css": ["app.css", "text/css"],
      };
      const asset = files[url.pathname];
      if (!asset) return json(404, { error: "Not found" });
      res.writeHead(200, { "Content-Type": asset[1] });
      res.end(await readFile(path.join(assets, asset[0])));
    } catch (error) {
      if (!res.headersSent) json(400, { error: (error as Error).message });
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not bind viewer server");
  origin = `http://127.0.0.1:${address.port}`;
  return { server, url: `${origin}/#${token}` };
}
