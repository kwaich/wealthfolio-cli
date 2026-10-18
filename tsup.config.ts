import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";
import { shimAliases } from "./shims.config.ts";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: { wf: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  sourcemap: false,
  splitting: false,
  noExternal: [/.*/],
  banner: {
    // Bundled CommonJS dependencies (commander) call require() for Node built-ins.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __wfCreateRequire } from "node:module";',
      "const require = __wfCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { __WF_VERSION__: JSON.stringify(version) },
  esbuildOptions(options) {
    options.alias = shimAliases;
  },
});
