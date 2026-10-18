# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`wf` is a Node CLI (TypeScript, ESM, Node 20+) for a self-hosted Wealthfolio server. It calls the same REST API as the web app, using the web app's own adapter code, vendored unchanged.

## Commands

Use pnpm (`packageManager` pins the version).

```sh
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test   # what CI runs, plus build
pnpm build                              # tsup -> dist/wf.js, one bundled file
node dist/wf.js --version

pnpm vitest run test/unit/curated.test.ts      # one test file
pnpm vitest run -t "syncs every asset"         # tests by name

# Integration tests run the built binary against the official server image (Docker).
# The image tag comes from UPSTREAM_TAG.
pnpm build
eval "$(WF_TEST_TTL_MINUTES=1 scripts/test-server.sh up)"
WF_TEST_REFRESH=1 pnpm test:integration
scripts/test-server.sh down
```

CI also fails if `vendor/`, `src/contract.ts` or `UPSTREAM_TAG` differ from what is committed (`git diff --exit-code`).

## Architecture

**The vendored contract.** `vendor/upstream/<tag>/adapters/web/core.ts` is upstream's web adapter: a `COMMANDS` map (command name -> method and path) and an `invoke(command, payload)` switch that builds each request. Never edit files in `vendor/`, `src/contract.ts` or `UPSTREAM_TAG` by hand. `scripts/vendor.sh <tag>` regenerates them, and a unit test checks the files against the hashes in `SOURCE.json`. `src/contract.ts` re-exports `COMMANDS`, `invoke`, `PAYLOADS` and `SCHEMAS` from the current tag. To fix how the CLI uses the contract, change the CLI code or the shims, never the vendored code.

**Shims replace upstream's browser imports.** `core.ts` imports `@/features/profiles/session` and `@/lib/auth-token`. These resolve to `src/shims/*`, and the aliases are in two places that must stay in sync: `tsconfig.json` `paths` (for `tsc`) and `shims.config.ts` (for tsup and vitest). `vendor.sh` stops if `core.ts` gets a new import; that needs a new shim in both places and an update to `EXPECTED_IMPORTS` in the script. The `profileFetch` shim sends every request through `src/transport.ts`.

**Request flow.** `Client.open()` (`src/client.ts`) resolves the URL (`--url` > `WF_URL` > config file), loads the cached session from `src/store.ts`, and installs a module-level transport (`setTransport`). `Client.invoke()` checks the command against `COMMANDS` and calls the upstream `invoke`, which calls `profileFetch`, which calls `transport.send()`. `send()` adds the Bearer token, the profile scope header and the owner cookie. It saves a refreshed `wf_session` token from `Set-Cookie` through `onChange` (not when the token comes from `WF_TOKEN`). It also refuses URLs that contain `undefined`/`null`, because a missing payload key in the vendored template strings produces such URLs, and the server can answer 200 to them.

**Commands.** `src/program.ts` builds the commander tree: login/logout/status, config, the generic `commands`/`schema`/`call`, and profile. It then calls the `register*` functions in `src/commands/` for the curated subcommands (reads, activity, agent-token, sync/rebalance/spending/alt-asset). Curated commands are thin wrappers that call `client.invoke(...)` and print through `output()` in `src/context.ts`. Output is JSON on stdout, or a table with `--table`. Agents pay for every byte, so the big reads are trimmed: `wf holdings` drops `instrument.classifications`, `instrument.notes` and `metadata` unless `--full`, and `wf activity search --brief` keeps only `BRIEF_FIELDS`.
**The exception: `wf activity update`** does not use `invoke`. It calls the server's MCP tools (`prepare/commit_activity_updates`) through the minimal Streamable HTTP client in `src/mcp.ts`. It authenticates with a personal access token (`wf agent-token`), not the login session. `src/events.ts` reads the server's SSE event stream, and `src/wait.ts` uses it so that commands can wait for the background portfolio recalculation.

**Errors and exit codes.** Throw `UsageError` (2), `AuthError` (3) or `ServerError` (1) from `src/errors.ts`, with an optional hint. `src/main.ts` turns them into `error:`/`hint:` lines on stderr and the exit code. Other errors exit with 1. Agents depend on these codes (see README and the skill).

**Payload/schema metadata.** `vendor/.../payloads.json` (from `scripts/extract-payloads.mjs`) lists the keys the `invoke` switch reads. `schemas.json` (from `scripts/extract-schemas.mjs`) holds the payload and result types that the web app passes, expanded by the TypeScript checker. `src/payloads.ts` serves both to `wf schema` and `wf commands`.

## Tests

Unit tests (`test/unit`) run the CLI in-process with `run(...args)` from `test/helpers.ts`, which captures stdout, stderr and the exit code. The same file replaces global `fetch` with `mockFetch(handler)`, which records each request, and `useTempConfig()` points `WF_CONFIG_DIR` at a temp directory. Assert on the recorded requests and the captured output. Integration tests (`test/integration`) run `dist/wf.js` against a real server, so build first.

## Related files to keep in sync

- `skills/wealthfolio/SKILL.md` is shipped in the package and teaches agents how to use `wf`. Update it when command behaviour, flags or exit codes change.
- `README.md` documents every command, environment variable and exit code.
- The version is injected at build time as `__WF_VERSION__` from `package.json`, by both `tsup.config.ts` and the vitest configs.

## Releases

The CLI has its own semver version, independent of the Wealthfolio version. `npm version X.Y.Z && git push --follow-tags` starts `.github/workflows/release.yml`. It checks that the tag matches `package.json`, then attaches the npm tarball and `wf.js` to a GitHub release named with the Wealthfolio version from `UPSTREAM_TAG`. `commander` is a devDependency on purpose: tsup bundles everything into `dist/wf.js`, so the package has no runtime dependencies. `.github/workflows/upstream-drift.yml` re-vendors newer upstream releases every week and opens a PR.
