# Vendored upstream files

`upstream/<tag>/adapters/` holds files copied unchanged from
[wealthfolio/wealthfolio](https://github.com/wealthfolio/wealthfolio) at the tag
in `../UPSTREAM_TAG`, by `scripts/vendor.sh`. Do not edit them; re-run the
script. They are licensed under the upstream AGPL-3.0 license.

Generated, not upstream: `adapters/types.ts` (re-exports the CLI's `Logger`
shim), `SOURCE.json` (commit and file hashes), `payloads.json` (payload types
extracted from the `invoke` switch).
