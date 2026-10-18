---
name: wealthfolio
description: Read and change a self-hosted Wealthfolio portfolio with the `wf` CLI. Use for questions about accounts, holdings, activities (transactions), cash, spending, budget, rebalancing or portfolio health, and to record, correct, void or delete activities or sync market data.
---

# Wealthfolio through `wf`

`wf` talks to the user's Wealthfolio server over its HTTP API. It prints JSON
to stdout, errors to stderr as `error:` and `hint:` lines, and sets an exit
code you can act on.

## Rules

1. **Preview, show, confirm, then write.** Every write that has `--dry-run`
   gets one first. Show the user what will change, in plain terms, and wait
   for a yes before you run it without `--dry-run`. This covers
   `activity update`, `delete`, `void` and `restore`. For a raw `wf call` that
   writes (create, update, delete), describe the payload and get a yes first.
2. **Never open the SQLite database.** Direct writes skip the recalculation
   and can break the database. Use `wf` only.
3. **Never print or store secrets.** That covers the password, `WF_TOKEN`,
   `WF_AGENT_TOKEN`, and the files in `~/.config/wf/`. Don't put the password
   on the command line; use `WF_PASSWORD` or `--password-stdin`.
4. **Read before you write.** Get ids from `wf accounts` and
   `wf activity search`. Never guess an id.
5. **Add `--wait` to writes when you read right after.** Without it, the
   server recalculates in the background and your next read can be stale.
6. **Read as JSON, without `--table`.** `--table` truncates nested fields such
   as `instrument`, so you lose the symbol. Fetch JSON, then summarise or
   format it yourself, even when the user asks to see the data. Use `--table`
   only when the user asks for a table.

## Exit codes

| Code | Meaning                            | What to do                                                                           |
| ---- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| 0    | OK                                 |                                                                                      |
| 1    | Server error, or a row was refused | Read stderr, or the `error` field of each row                                        |
| 2    | Bad usage                          | Fix the flags or the payload. Run `wf <cmd> --help` or `wf schema <command>`         |
| 3    | Auth                               | Run `wf status`. Ask the user to log in or unlock the profile. Don't retry in a loop |

The server allows 5 logins per minute. One failed login is enough to stop and
ask.

## Start

```sh
wf status        # url, authenticated, serverVersion, profileId, warnings
```

- If `authenticated` is false, ask the user to run `wf login --url <server>`.
  Or, if they gave you `WF_PASSWORD`, run `wf login` yourself.
- If stderr has `PROFILE_LOCKED`, or the hint names a profile, run
  `wf profile list`. A profile with a password needs the user:
  `wf profile use <id> --password-stdin`.
- A warning that the server version is not the CLI's upstream tag means some
  commands may differ. Say so if a command then fails.

## Read

```sh
wf accounts                          # add --all for archived accounts
wf holdings                          # all accounts; --account <id> for one
wf activity search --from 2026-01-01 --type DIVIDEND --page-size 20 --brief
wf activity search --needs-review    # the review queue
wf activity search --id <id>         # one activity, with status and source
wf health --refresh                  # data issues the app found
wf spending report --from 2026-09-01 --to 2026-09-30
wf budget --period 2026-09
wf rebalance --holdings              # drift against the allocation target
wf rebalance --cash 5000             # plus a plan to invest 5000
```

- `activity search` returns `{data, meta}`. `meta.totalRowCount` says whether
  to fetch the next `--page` (pages start at 0).
- Amounts are decimal strings, such as `"1001.5"`. Keep them as strings. Don't
  round them.
- Dates are `YYYY-MM-DD` or RFC 3339.
- Add `--table` only when the user asks for a table (rule 6).
- `wf holdings` leaves out each instrument's classifications and notes and the
  holding's metadata. Add `--full` only when you need sectors or regions. Even
  slim, no `--account` returns the aggregate across all accounts (on one
  portfolio, 26 rows were about 12k tokens), so pass `--account` when the question is about one
  account. Pipe it through `jq` to the fields you need:

  ```sh
  wf holdings --account <id> | jq '[.[] | {symbol: .instrument.symbol,
    quantity, price, value: .marketValue.base, cost: .costBasis.base,
    gain: .totalGain.base, weight}]'
  ```

- `activity search` rows are around 1 KB each. Add `--brief` (less than half
  that: `id`, `accountId`, `assetId`, `assetSymbol`, `activityType`, `subtype`,
  `status`, `date`, `quantity`, `unitPrice`, `amount`, `fee`, `currency`, `fxRate`,
  `needsReview`), and keep `--page-size` small unless the user wants the full
  list. Leave `--brief` off when you need `comment`, `source*`, `tax` or `accountName`.
- Use `wf commands --filter <word>`, never bare `wf commands` (it prints every command, around 12k tokens).
- A holding's `fxRate` is the current rate; an activity's `fxRate` is the rate
  it was recorded at.
- `wf spending report` defaults to this month. It returns `current` and
  `prior` totals (`income`, `outflow`, `saved`, `net`) and breakdowns by
  category and day. `--account <id>` repeats.
- `wf budget` returns `state` (groups, targets) and `computed` (`totals`,
  per-group rows). All zeros with empty `groupRows` means no budget is set up
  for that month; say so instead of reporting zero spending.
- `wf holdings --account <id> --include-closed` also lists sold-out positions.

For anything without its own command:

```sh
wf commands --filter goal            # name, method, path, payload keys
wf schema get_goals                  # full payload and result types
wf call get_goals
wf call get_holding --args '{"accountId":"<id>","assetId":"<id>"}'
```

## Write

### Record an activity

```sh
wf schema create_activity            # check the fields first
wf call create_activity --wait --args '{"activity":{
  "accountId":"<id>","activityType":"BUY","activityDate":"2026-01-06",
  "quantity":"10","unitPrice":"100","fee":"1","currency":"USD",
  "asset":{"symbol":"AAPL","quoteCcy":"USD"}}}'
```

- A new asset needs `symbol` and `quoteCcy`. For an asset already stored,
  pass `"asset":{"id":"<assetId>"}`. `wf holdings` shows that id as
  `instrument.id`.

Cash activities (`DEPOSIT`, `WITHDRAWAL`, `DIVIDEND`, `INTEREST`, `FEE`) take
`amount` and no quantity. The output is `{result, wait}`. When
`wait.status` is not `complete`, the write still happened; say so.

### Correct an activity

`wf activity update` uses the server's own update rules. It needs an agent
token, made once by the user: `wf agent-token create`. The server must also
run with `WF_MCP_ENABLED=true`. If you get exit 3 with "No agent access
token", ask the user to create one.

```sh
wf activity update <id> --unit-price 110 --dry-run
```

The preview lists each field that would change, with `current` and
`proposed` values. It includes the values the server works out for itself,
such as a new trade total. Show all of them to the user. For one leg of a
linked transfer, `linkedChanges` shows what the other leg gets too. After a
yes:

```sh
wf activity update <id> --unit-price 110 --wait
```

- Name only the fields that change. `--clear fee` sets an optional field to
  null.
- `--asset` takes an asset id, not a symbol. Find the id in `wf holdings`
  (`instrument.id`) or in the activity's `assetId`.
- `--approve` takes an activity out of the review queue. A draft becomes
  posted.
- For a batch, use `--updates '[{"activityId":"a","fee":"1"},...]'` or
  `--updates-file`. The limit is 100 rows.
- A row with `status: "invalid"` was refused, and its `error` says why. Pass
  that on to the user; don't work around it. For example, a linked transfer
  must be unlinked before its account or currency can change.

### Remove an activity from the portfolio

Void and delete do different things. Choose with the user:

- **Void** keeps the record, but it no longer counts in holdings, cash or
  performance. Broker syncs keep it void. Prefer this for broker-synced
  activities, which a sync could otherwise add back.
- **Delete** removes it. Deleting one leg of a linked transfer deletes both
  legs.

```sh
wf activity void <id>... --dry-run      # then without --dry-run, after a yes
wf activity restore <id>... --dry-run   # undo a void
wf activity delete <id>... --dry-run    # see the warning for broker-synced rows
```

Only a posted activity can be voided. A draft or pending one counts toward
nothing yet, so delete it instead.

### Other writes

```sh
wf sync --wait                       # refresh quotes, then recalculate
wf sync --asset <id> --recent-days 30 --wait
wf alt-asset value <assetId> 450000 --date 2026-10-01 --wait   # property, car, ...
```

### Accounts, goals and other records

These have no curated command and no `--dry-run`. Use `wf call` with the
schema, and treat each one as a raw write under rule 1: show the exact payload
and get a yes first.

```sh
wf schema create_account             # fields the web app sends
wf call create_account --args '{"account":{...}}'
wf call update_account --args '{"accountUpdate":{"id":"<id>",...}}'
```

`update_account` needs `name`, `accountType`, `trackingMode` and `isArchived`
every time. Read the account with `wf accounts` and send back the fields you
don't mean to change. Don't run `delete_account` unless the user names the
account; it can't be undone.

## When a write fails

- **Exit 1 with a server message**, such as ``missing field `isDefault` ``:
  the server names the field. Run `wf schema <command>`, add the field, and
  try once more. `wf schema` shows the types the web app sends. The server
  can require more than they show.
- **Exit 2 with "Refusing to send ... a required payload key is missing"**:
  an id in the payload is missing or misspelled.
- **`wait.status` is `error` or `timeout`**: the write happened, but the
  recalculation failed or is slow. Run `wf health`, then read the data again.
