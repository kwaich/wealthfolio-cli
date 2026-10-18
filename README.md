# wf: Wealthfolio command line client

`wf` talks to a self-hosted [Wealthfolio](https://github.com/wealthfolio/wealthfolio)
server (the official Docker image) through the same REST API the web app uses.
It reaches every app feature, including the ones the MCP endpoint does not
expose yet. It is for people in a terminal and for AI agents (Claude Code)
that work through a shell.

- `wf call <command>` runs any of the 322 commands in the web app's contract.
- Curated subcommands (`wf sync`, `wf rebalance`, ...) cover common tasks.
- Output is JSON on stdout (pipe it to `jq`). Errors go to stderr.

The contract is vendored unchanged from the upstream tag in
[`UPSTREAM_TAG`](UPSTREAM_TAG) (now `v3.10.0`). A weekly workflow opens a PR when
upstream releases a new version.

## Install

Needs Node.js 20 or later.

```sh
# From git (builds on install)
npm install -g github:kwaich/wealthfolio-cli

# Or from a clone
git clone https://github.com/kwaich/wealthfolio-cli && cd wealthfolio-cli
pnpm install && pnpm build && npm link
```

## Log in

```sh
wf login --url https://wealthfolio.example.com   # prompts for the password
WF_PASSWORD=... wf login                          # non-interactive
printf '%s' "$PW" | wf login --password-stdin
wf login --token <jwt>                            # paste a wf_session cookie (OIDC servers)
wf status
```

`wf login --url` saves the URL to `~/.config/wf/config.json`. The session token
goes to `~/.config/wf/session.json` (mode 0600). The password is never written
to disk. The server sends a refreshed token after half of its lifetime
(`WF_AUTH_TOKEN_TTL_MINUTES`, 60 by default) and `wf` stores it, so a session
that is used at least once per TTL stays alive. After that, run `wf login`
again.

The server allows 5 logins per minute per IP address. Scripts should log in
once, not before each command.

### Profiles

Wealthfolio 3.x can hold several profiles. If the server has exactly one
profile without a password, `wf login` opens it and nothing else is needed.
Otherwise:

```sh
wf profile list
wf profile use Work                 # id or name; prompts if the profile has a password
WF_PROFILE_PASSWORD=... wf profile use Work --save   # --save: unlock it after each login
wf profile lock
```

A profile with a password locks again after 5 minutes without use (a server
rule). Then commands exit with code 3 and `PROFILE_LOCKED`; run
`wf profile use` again.

### Environment and config

| Variable              | Use                                                                 |
| --------------------- | ------------------------------------------------------------------- |
| `WF_URL`              | Server URL. Overrides the config file; `--url` overrides both.      |
| `WF_PASSWORD`         | Password for `wf login`.                                            |
| `WF_PROFILE_PASSWORD` | Profile password for `wf profile use`.                              |
| `WF_TOKEN`            | Session token to use instead of the cache. Never written to disk.   |
| `WF_CONFIG_DIR`       | Config directory (default `$XDG_CONFIG_HOME/wf` or `~/.config/wf`). |
| `WF_DEBUG`            | Show upstream's request logs and stack traces.                      |

`wf config show`, `wf config set url|profile <value>`, `wf config unset <key>`.

## Commands

| Command                                                                  | What it does                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `wf login` / `wf logout` / `wf status`                                   | Session; `status` also warns when the server version is not `UPSTREAM_TAG`. |
| `wf commands [--filter x]`                                               | Every command: method, path, and the payload type `invoke` reads.           |
| `wf call <command> [--args json \| --args-file f \| --args -]`           | Runs a command. `-` reads stdin.                                            |
| `wf sync [--asset id]... [--refetch-all \| --recent-days n]`             | Syncs market data and updates the portfolio.                                |
| `wf activity delete <id>`                                                | Deletes one activity.                                                       |
| `wf rebalance [--target id\|name] [--cash n [--mode m] [--asset id]...]` | Drift against an allocation target; with `--cash`, a rebalance plan.        |
| `wf spending report [--from d] [--to d] [--account id]...`               | Spending report (default: this month so far).                               |
| `wf budget [--period YYYY-MM]`                                           | Budget snapshot.                                                            |
| `wf alt-asset value <id> <amount> [--date d] [--notes t]`                | Records a valuation for a property, vehicle, and so on.                     |

Add `--table` before or after the command for a human-readable table.

`wf sync` returns as soon as the server queues the job. The server syncs
quotes and then recalculates the portfolio in the background.

### Exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | OK                                                                     |
| 1    | Server error, or the server cannot be reached                          |
| 2    | Usage error: bad flags, bad JSON, unknown command, missing payload key |
| 3    | Auth: not logged in, session expired, or no unlocked profile           |

## Examples for agents

```sh
# What can I call, and with which payload?
wf commands --filter holding | jq -r '.[] | "\(.name)\t\(.payload)"'

# Accounts, then holdings of the first one
wf call get_accounts | jq -r '.[] | "\(.id)\t\(.name)\t\(.currency)"'
id=$(wf call get_accounts | jq -r '.[0].id')
wf call get_holdings --args "{\"filter\":{\"type\":\"account\",\"accountId\":\"$id\"}}" \
  | jq '[.[] | {symbol: .instrument.symbol, value: .marketValue.base}]'

# Record a deposit
wf call create_activity --args-file - <<'JSON'
{"activity": {"accountId": "<id>", "activityType": "DEPOSIT",
              "activityDate": "2026-10-01", "amount": "500", "currency": "USD"}}
JSON

# Check before acting
wf status >/dev/null 2>&1 || wf login
```

The payload is the object the web app passes to `invoke`, not the HTTP body.
For example, `update_account` takes `{"accountUpdate": {...}}`. `wf commands`
shows the shape for each command. `wf` refuses to send a request when a
required id is missing (it would otherwise call, for example,
`DELETE /accounts/undefined`).

Do not open the server's SQLite database directly. Writes through the API
trigger valuation recalculation; direct writes skip it and can break on
migrations.

## How it works

`vendor/upstream/<tag>/adapters/web/core.ts` is the web app's REST adapter,
copied unchanged: a `COMMANDS` map and an `invoke(command, payload)` switch
that builds each URL, query and body. `wf call` runs that `invoke`. Its
browser imports resolve to small Node shims in `src/shims/` (tsconfig `paths`
for `tsc`, aliases in `shims.config.ts` for the bundler and tests):

- `profileFetch` adds the server URL, `Authorization: Bearer`, the
  `x-wf-profile-scope` header and the owner cookie, and stores a refreshed
  `Set-Cookie` token.
- `notifyUnauthorized` throws an auth error (exit code 3).

`vendor/upstream/<tag>/SOURCE.json` holds the upstream commit and file hashes;
a test fails if a vendored file is edited. `payloads.json` is extracted from the
switch by `scripts/extract-payloads.mjs`.

## Development

```sh
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
pnpm build                          # dist/wf.js, one file

# Integration tests against the official image (needs Docker)
eval "$(WF_TEST_TTL_MINUTES=1 scripts/test-server.sh up)"
WF_TEST_REFRESH=1 pnpm test:integration
scripts/test-server.sh down
```

### Upgrading upstream

```sh
scripts/vendor.sh v3.11.0           # copies files, rewrites UPSTREAM_TAG and src/contract.ts
```

`vendor.sh` stops if `core.ts` imports a module that has no shim yet. The
`Upstream drift` workflow does this weekly: it re-vendors, runs every check
(the integration test runs against the new image), and opens a PR with the
`core.ts` diff. For it to open PRs, enable _Settings → Actions → General →
Allow GitHub Actions to create and approve pull requests_. PRs opened by the
workflow token do not start CI on their own; push a commit or re-run CI on the
PR before merging.

## License

AGPL-3.0-only (see [LICENSE](LICENSE)), the same license as Wealthfolio.
The files under `vendor/upstream/` are copied from Wealthfolio and keep
their upstream copyright.
