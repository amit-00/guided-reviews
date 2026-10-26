import { Command, Option } from "commander";
import { spawn } from "node:child_process";
import path from "node:path";
import { collect, git } from "./core/git.js";
import { generate, DEFAULT_MODEL, type Provider } from "./core/provider.js";
import { saveTour, loadTour, atomicWrite, markdown } from "./core/storage.js";
import { serve } from "./server.js";
import { demoTour } from "./demo.js";
import type { Tour } from "./core/schema.js";

function openBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () =>
    console.error(
      "Could not open a browser automatically. Open the URL above.",
    ),
  );
  child.unref();
}
interface ViewerOptions {
  port: string;
  open: boolean;
  repo?: string;
  provider?: Provider;
  model?: string;
}
async function launch(tour: Tour, file: string, options: ViewerOptions) {
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Port must be an integer from 0 to 65535.");
  const modelOptions =
    tour.provider === "demo"
      ? undefined
      : {
          provider: options.provider ?? tour.provider,
          model: options.model ?? tour.model,
        };
  const { server, url } = await serve(tour, file, {
    port,
    repo: options.repo,
    modelOptions,
  });
  console.log(
    `\nGuided review: ${url}\nLocal viewer running. Press Ctrl+C to stop. Progress is saved beside the tour.`,
  );
  if (options.open) openBrowser(url);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
}
function viewerOptions(command: Command) {
  return command
    .option(
      "--port <port>",
      "localhost port (0 chooses an available port)",
      "0",
    )
    .option("--no-open", "print the viewer URL without opening a browser");
}
function modelOptions(command: Command, defaults = true) {
  command.addOption(
    new Option("--provider <provider>", "AI backend")
      .choices(["codex", "openai"])
      .default(defaults ? "codex" : undefined),
  );
  command.option(
    "--model <model>",
    "model identifier",
    defaults ? DEFAULT_MODEL : undefined,
  );
  return command;
}
const program = new Command()
  .name("guided-review")
  .description("Turn a local Git change into an evidence-linked review tour.")
  .version("0.1.0");
const create = viewerOptions(
  modelOptions(
    program
      .command("create", { isDefault: true })
      .description(
        "Generate a tour of committed changes and open the local viewer",
      ),
  ),
)
  .option("--base <ref>", "base branch or commit", "main")
  .option("--head <ref>", "head branch or commit", "HEAD")
  .option("--repo <path>", "local repository", ".")
  .option(
    "--output <file>",
    "tour JSON destination (default: .guided-reviews/<revisions>-<time>.json)",
  )
  .option("--no-serve", "generate the saved tour without starting a viewer");
create.action(async (options) => {
  const root = (
    await git(path.resolve(options.repo), ["rev-parse", "--show-toplevel"])
  ).trim();
  console.log("Collecting committed changes and repository context…");
  const inventory = await collect(root, options.base, options.head);
  console.log(
    `${inventory.hunks.length} change units, ${inventory.snapshots.length} source snapshots. Analyzing with ${options.provider} / ${options.model}…`,
  );
  console.log(
    "Selected source context is sent to the configured model provider. Tour and review progress stay local.",
  );
  const tour = await generate(inventory, options);
  const file = path.resolve(
    options.output ??
      path.join(
        root,
        ".guided-reviews",
        `${inventory.mergeBase.slice(0, 7)}-${inventory.headCommit.slice(0, 7)}-${Date.now()}.json`,
      ),
  );
  await saveTour(file, tour);
  console.log(
    `Saved ${file}\n${tour.plan.steps.length} tour stops · ${tour.unanalyzed.length} changes not analyzed`,
  );
  if (options.serve) await launch(tour, file, { ...options, repo: root });
});
viewerOptions(
  modelOptions(
    program
      .command("view <file>")
      .description("Reopen a saved tour and its review progress"),
    false,
  ),
)
  .option("--repo <path>", "repository to check for stale revisions")
  .action(async (file, options) => {
    const full = path.resolve(file);
    await launch(await loadTour(full), full, options);
  });
program
  .command("export <file>")
  .description("Export a saved tour as Markdown or JSON")
  .addOption(
    new Option("--format <format>", "export format")
      .choices(["markdown", "json"])
      .default("markdown"),
  )
  .option("--output <file>", "write to a file instead of stdout")
  .action(async (file, options) => {
    const tour = await loadTour(path.resolve(file));
    const output =
      options.format === "json"
        ? JSON.stringify(tour, null, 2) + "\n"
        : markdown(tour);
    if (options.output) await atomicWrite(path.resolve(options.output), output);
    else process.stdout.write(output);
  });
viewerOptions(
  program
    .command("demo")
    .description("Explore a hand-authored example without a model account"),
)
  .option(
    "--output <file>",
    "where to save the example",
    ".guided-reviews/demo.json",
  )
  .action(async (options) => {
    const tour = demoTour();
    const file = path.resolve(options.output);
    await saveTour(file, tour);
    await launch(tour, file, options);
  });
program.parseAsync().catch((error) => {
  console.error(`\nError: ${error.message}`);
  process.exitCode = 1;
});
