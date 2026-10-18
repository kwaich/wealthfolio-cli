import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { shimAliases } from "./shims.config.ts";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

// Runs the built binary against a live server. Needs WF_TEST_URL and WF_TEST_PASSWORD.
export default defineConfig({
  resolve: { alias: shimAliases },
  define: { __WF_VERSION__: JSON.stringify(version) },
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
