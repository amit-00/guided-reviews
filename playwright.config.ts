import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
export default defineConfig({
  testDir: "./test",
  testMatch: "viewer.spec.ts",
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath: existsSync("/usr/bin/google-chrome")
        ? "/usr/bin/google-chrome"
        : undefined,
      args: ["--no-sandbox"],
    },
  },
});
