import { build } from "esbuild";
import { mkdir, copyFile, chmod } from "node:fs/promises";
await mkdir("dist/viewer", { recursive: true });
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
});
await build({
  entryPoints: ["src/viewer/app.tsx"],
  outfile: "dist/viewer/app.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
});
await copyFile("src/viewer/index.html", "dist/viewer/index.html");
await chmod("dist/cli.js", 0o755);
