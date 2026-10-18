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
npm install -g https://github.com/kwaich/wealthfolio-cli/releases/latest/download/wealthfolio-cli.tgz
```

Run the same command again to update. For a fixed version, use
`.../releases/download/v0.1.0/wealthfolio-cli-0.1.0.tgz`. Each release also
has `wf.js`, the CLI as one file with no dependencies, if you do not want npm:

```sh
curl -fsSL -o ~/.local/bin/wf https://github.com/kwaich/wealthfolio-cli/releases/latest/download/wf.js
chmod +x ~/.local/bin/wf
```

### From source

```sh
git clone https://github.com/kwaich/wealthfolio-cli && cd wealthfolio-cli
corepack enable      # provides the pnpm version the repo pins
pnpm install         # also builds dist/wf.js
npm install -g .     # puts `wf` on your PATH
```

`npm install -g .` links to the clone, so keep the folder. To update, run
`git pull` and `pnpm install` in the clone. Without pnpm, `npm install` also
works, but npm does not read `pnpm-lock.yaml`: it resolves the dependency
versions again and writes a `package-lock.json`.

`npm install -g github:kwaich/wealthfolio-cli` does not work. npm runs the
clone's own install as a global one, so the build tools are missing when it
builds.

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
printf '%s' "$PW" | wf profile use Work --password-stdin
wf profile lock
```

`wf login --profile <id>` unlocks that profile right after login and saves
it as the default.

A profile with a password locks again after 5 minutes without use (a server
rule). Then commands exit with code 3 and `PROFILE_LOCKED`; run
`wf profile use` again.

### Environment and config

| Variable              | Use                                                                   |
| --------------------- | --------------------------------------------------------------------- |
| `WF_URL`              | Server URL. Overrides the config file; `--url` overrides both.        |
| `WF_PASSWORD`         | Password for `wf login`.                                              |
| `WF_PROFILE_PASSWORD` | Profile password for `wf profile use`.                                |
| `WF_TOKEN`            | Session token to use instead of the cache. Never written to disk.     |
| `WF_AGENT_TOKEN`      | MCP access token for `wf activity update`, instead of the stored one. |
| `WF_CONFIG_DIR`       | Config directory (default `$XDG_CONFIG_HOME/wf` or `~/.config/wf`).   |
| `WF_DEBUG`            | Show upstream's request logs and stack traces.                        |

`wf config show`, `wf config set url|profile <value>`, `wf config unset <key>`.

## Commands

| Command                                                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wf login` / `wf logout` / `wf status`                                                | Session; `status` also warns when the server version is not `UPSTREAM_TAG`.                                                                                                                                                                                                                                                                                                                                          |
| `wf commands [--filter x]`                                                            | The name of every command. With `--filter`, also each one's method, path and the payload type `invoke` reads.                                                                                                                                                                                                                                                                                                        |
| `wf schema <command>`                                                                 | Payload and response types of one command, expanded, with field notes.                                                                                                                                                                                                                                                                                                                                               |
| `wf call <command> [--args json \| --args-file f \| --args -] [--wait]`               | Runs a command. `-` reads stdin.                                                                                                                                                                                                                                                                                                                                                                                     |
| `wf sync [--asset id]... [--refetch-all \| --recent-days n]`                          | Syncs market data and updates the portfolio.                                                                                                                                                                                                                                                                                                                                                                         |
| `wf accounts [--all]`                                                                 | Accounts, with tracking mode, group and sync provider.                                                                                                                                                                                                                                                                                                                                                               |
| `wf holdings [--account id [--include-closed]] [--full]`                              | Holdings, cash included, with asset id, local values and FX rate. Without `--full`, the instrument's classifications and notes and the holding's metadata are left out.                                                                                                                                                                                                                                              |
| `wf activity search [filters]`                                                        | Activities, newest first. Filters: `--account`, `--type`, `--id` (each repeatable), `--from`, `--to`, `--needs-review` or `--reviewed`, `--asset`, `--page`, `--page-size` (default 20). Each row has only `id`, `accountId`, `assetId`, `assetSymbol`, `activityType`, `subtype`, `status`, `date`, `quantity`, `unitPrice`, `amount`, `fee`, `currency`, `fxRate` and `needsReview`; `--full` returns every field. |
| `wf activity update <id> [--field value]... [--dry-run]`                              | Corrects activity fields with the server's own rules; `--updates` for a batch. Needs `wf agent-token create`.                                                                                                                                                                                                                                                                                                        |
| `wf agent-token create\|show\|delete`                                                 | The access token for the server's MCP endpoint, which `activity update` uses.                                                                                                                                                                                                                                                                                                                                        |
| `wf activity delete <id>... [--dry-run]`                                              | Deletes up to 100 activities. One leg of a linked transfer deletes both.                                                                                                                                                                                                                                                                                                                                             |
| `wf activity void <id>... [--dry-run]`                                                | Voids posted activities: kept, but out of holdings, cash and performance.                                                                                                                                                                                                                                                                                                                                            |
| `wf activity restore <id>... [--dry-run]`                                             | Posts voided activities again.                                                                                                                                                                                                                                                                                                                                                                                       |
| `wf health [--refresh]`                                                               | Health Center status; `--refresh` runs the checks first.                                                                                                                                                                                                                                                                                                                                                             |
| `wf rebalance [--target id\|name] [--holdings] [--cash n [--mode m] [--asset id]...]` | Drift against an allocation target (`--holdings` adds the holdings); with `--cash`, a rebalance plan.                                                                                                                                                                                                                                                                                                                |
| `wf spending report [--from d] [--to d] [--account id]...`                            | Spending report (default: this month so far).                                                                                                                                                                                                                                                                                                                                                                        |
| `wf budget [--period YYYY-MM]`                                                        | Budget snapshot.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `wf alt-asset value <id> <amount> [--date d] [--notes t]`                             | Records a valuation for a property, vehicle, and so on.                                                                                                                                                                                                                                                                                                                                                              |

Add `--table` before or after the command for a human-readable table.

### Waiting for the recalculation

A write returns before the server recalculates the portfolio in the
background. With `--wait`, `wf` follows the server's event stream (as the web
app does) and returns when that update has finished, so the next read sees
the new numbers. `--wait` works on `wf call` (not on read-only GET commands),
`wf sync`, `wf alt-asset value`, and `wf activity update|delete|void|restore`.
`--wait-timeout <seconds>` defaults to 300.

The output gets a `wait` object: `{status: "complete" | "error" | "timeout",
seconds, error?, marketSync?}`. `wf call --wait` wraps the response as
`{result, wait}`. An error or a timeout exits 1; the write has happened
either way. Another client's update that starts during the wait can end it
early.

### Update

`wf activity update` runs the server's own MCP tools: `prepare_activity_updates`
with `--dry-run`, else `commit_activity_updates`. So the server applies its
rules, not a copy in `wf`:

- Name only the fields to change. Omitted fields keep their value;
  `--clear <field>` sets an optional one to null. Flags: `--date`, `--account`,
  `--type`, `--subtype`, `--asset` (an asset id; symbols are refused),
  `--quantity`, `--unit-price`, `--amount`, `--currency`, `--fee`, `--tax`,
  `--fx-rate`, `--notes`, `--approve`.
- The preview lists every field that would change, with its current and
  proposed value. This includes values the server derives, such as a trade
  total recalculated from quantity and price. For one leg of a linked
  transfer, `linkedChanges` shows what the other leg gets.
- The server refuses a row when the activity does not exist, a value is
  invalid, nothing would change, or the change would break a linked transfer
  (its account, currency, type or asset). The other rows still run. The exit
  code is 1 when any row was refused or failed.
- A batch of up to 100 rows: `--updates '[{"activityId":"...","fee":"1.5"}]'`
  or `--updates-file f.json` (`-` for stdin). The rows are the MCP tool's
  rows.

The MCP endpoint takes an access token, not the login session, and the server
must run with `WF_MCP_ENABLED=true` (AI Agent Access in the app's settings).
`wf agent-token create` makes a token for the current profile, with only the
scopes `activities:read`, `activities:draft` and `activities:write`. The token
expires in 90 days (`--expires-days`; 0 for never). `wf` stores it in
`agent-token.json` (mode 0600), apart from the session, so login and logout
keep it. `wf agent-token delete` revokes it on the server.

To void or restore, use `wf activity void|restore`. Those work on servers
without MCP.

### Delete, void and restore

These follow the same rules as the MCP tools `prepare_activity_deletions`,
`commit_activity_deletions` and the `void` field of the activity update tools.
Run them with `--dry-run` first: the preview reads each activity and the other
leg of a linked transfer, and writes nothing.

- Each id is its own row. A row is refused when the activity does not exist,
  or when an earlier row already covers it (a repeat, or the other leg of a
  pair). The other rows still run. Output is `{dryRun, rows, summary}`; the
  exit code is 1 when any row was refused or failed.
- `void` takes only a posted activity. A draft or pending one counts toward
  nothing yet, so delete it instead. Voiding also clears the review flag.
- One leg of a linked transfer is voided or restored only when both legs have
  the same status, because the server copies the status to the other leg.
- `delete` warns when an activity came from a broker sync, which may add it
  back. Void it instead to keep it out for good: broker syncs keep it void.

`wf health --refresh` runs the checks in the timezone set in the app, as the
MCP tool does, and falls back to the machine's timezone when none is set.

`wf sync` returns as soon as the server queues the job. The server syncs
quotes and then recalculates the portfolio in the background.

### Exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | OK                                                                     |
| 1    | Server error, or the server cannot be reached                          |
| 2    | Usage error: bad flags, bad JSON, unknown command, missing payload key |
| 3    | Auth: not logged in, session expired, or no unlocked profile           |

## Agent skill

[`skills/wealthfolio/SKILL.md`](skills/wealthfolio/SKILL.md) teaches an agent
to use `wf` safely: preview and confirm before each write, `--wait` before
reading back, what each exit code means, and how to recover from a rejected
payload. To install it for Claude Code:

```sh
mkdir -p ~/.claude/skills
cp -r skills/wealthfolio ~/.claude/skills/
# or from anywhere, after `npm install -g .`:
cp -r "$(npm root -g)/wealthfolio-cli/skills/wealthfolio" ~/.claude/skills/
```

Other agents that read `SKILL.md` files can use the same file.

## Examples for agents

```sh
# What can I call, and with which payload?
wf commands --filter holding | jq -r '.[] | .name'
wf schema create_activity | jq -r .payloadType

# Accounts, then holdings of the first one
wf call get_accounts | jq -r '.[] | "\(.id)\t\(.name)\t\(.currency)"'
id=$(wf call get_accounts | jq -r '.[0].id')
wf call get_holdings --args "{\"filter\":{\"type\":\"account\",\"accountId\":\"$id\"}}" \
  | jq '[.[] | {symbol: .instrument.symbol, value: .marketValue.base}]'

# Record a deposit, wait for the recalculation, then read holdings
wf call create_activity --wait --args-file - <<'JSON' | jq '.wait.status'
{"activity": {"accountId": "<id>", "activityType": "DEPOSIT",
              "activityDate": "2026-10-01", "amount": "500", "currency": "USD"}}
JSON
wf holdings --account <id>

# Find activities waiting for review, preview voiding them, then void
ids=$(wf activity search --needs-review | jq -r '.data[] | select(.status == "POSTED") | .id')
wf activity void $ids --dry-run | jq '.rows[] | {activityId, status, newStatus, error}'
wf activity void $ids

# Correct a trade's price: preview (with the derived total), then apply
wf activity update "$id" --unit-price 110 --dry-run | jq '.rows[0].changes'
wf activity update "$id" --unit-price 110 --wait

# Check before acting
wf status >/dev/null 2>&1 || wf login
```

The payload is the object the web app passes to `invoke`, not the HTTP body.
For example, `update_account` takes `{"accountUpdate": {...}}`.
`wf schema <command>` shows:

- `payload`: the keys the vendored `invoke` reads;
- `payloadType` and `resultType`: the types the web app's own code passes
  and expects, expanded, with the upstream doc comments;
- `source`: that call in the upstream frontend.

`payloadType` is what the web app sends, not the server's own contract. The
server can require a field the app always sends: `create_account` needs
`isDefault` and `isActive`, which the type marks optional. When the server
rejects a payload, `wf` prints its message, which names the missing or wrong
field (``missing field `isDefault` ``). `wf` also refuses to send a request
when a required id is missing (it would otherwise call, for example,
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

`wf activity update` is the one command that does not go through `invoke`.
`src/mcp.ts` is a small Streamable HTTP client for the server's `/mcp`
endpoint. It sends the agent token and the `x-wf-profile-id` header, and
reads the JSON-RPC reply from the SSE response.

`vendor/upstream/<tag>/SOURCE.json` holds the upstream commit and file hashes;
a test fails if a vendored file is edited. `payloads.json` is extracted from the
switch by `scripts/extract-payloads.mjs`. `schemas.json` comes from
`scripts/extract-schemas.mjs`, which runs the TypeScript checker over the
upstream frontend source (with zod at upstream's version) and expands the
types at each typed `invoke` call. `vendor.sh` needs `node` and `npm` for it.

## Development

```sh
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
pnpm build                          # dist/wf.js, one file

# Integration tests against the official image (needs Docker)
pnpm build
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

### Releasing

```sh
npm version 0.2.0 -m "Release %s"   # bumps package.json, commits, tags v0.2.0
git push --follow-tags
```

The `Release` workflow runs on the tag. It checks that the tag matches
`package.json`, runs the checks, builds, installs the packed tarball as a
smoke test, and creates a GitHub release with `wealthfolio-cli-<version>.tgz`,
`wealthfolio-cli.tgz` and `wf.js` attached. The CLI has its own version; the
release title names the Wealthfolio version from `UPSTREAM_TAG`, for example
`v0.2.0 (Wealthfolio v3.10.0)`.

## License

AGPL-3.0-only (see [LICENSE](LICENSE)), the same license as Wealthfolio.
The files under `vendor/upstream/` are copied from Wealthfolio and keep
their upstream copyright.
