import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { shimAliases } from "./shims.config.ts";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  resolve: { alias: shimAliases },
  define: { __WF_VERSION__: JSON.stringify(version) },
  test: {
    include: ["test/unit/**/*.test.ts"],
  },
});
