// `wf activity update`: field corrections through the server's own MCP tools
// prepare_activity_updates (--dry-run) and commit_activity_updates. The server
// applies the rules: derived values (a trade total from quantity and price, the
// review flag), the mirrored changes on a linked transfer leg, and the refusals
// (a change that would break a transfer pair, nothing to change). wf only builds
// the rows and reports what the server says.
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { globals, open, output } from "../context";
import { UsageError } from "../errors";
import { readStdin } from "../prompt";
import { addWaitOptions, withWait, type WaitOptions } from "../wait";
import { withMcp } from "./agent-token";
import { collect } from "./args";

const MAX_UPDATES = 100;

/** Flag name -> row field, for the fields the activity grid edits. */
const FIELD_FLAGS = {
  date: "date",
  account: "accountId",
  type: "activityType",
  subtype: "subtype",
  asset: "assetId",
  quantity: "quantity",
  unitPrice: "unitPrice",
  amount: "amount",
  currency: "currency",
  fee: "fee",
  tax: "tax",
  fxRate: "fxRate",
  notes: "notes",
} as const;

/** Fields `--clear` may set to null: the optional ones. */
const CLEARABLE = [
  "subtype",
  "assetId",
  "quantity",
  "unitPrice",
  "amount",
  "fee",
  "tax",
  "fxRate",
  "notes",
];

type FieldFlag = keyof typeof FIELD_FLAGS;

type UpdateOptions = Partial<Record<FieldFlag, string>> & {
  approve?: boolean;
  clear: string[];
  updates?: string;
  updatesFile?: string;
  dryRun?: boolean;
} & WaitOptions;

interface FieldChange {
  field: string;
  current: unknown;
  proposed: unknown;
}

interface PreviewRow {
  index: number;
  activityId?: string;
  status: "ready" | "invalid";
  changes?: FieldChange[];
  linkedActivityId?: string;
  linkedChanges?: FieldChange[];
  error?: string;
}

interface PreviewOutput {
  rows: PreviewRow[];
  summary: { total: number; ready: number; invalid: number };
}

interface CommitOutput {
  updated: {
    index: number;
    activityId: string;
    changes: { field: string; before: unknown; after: unknown }[];
    linkedActivityId?: string;
    linkedChanges?: { field: string; before: unknown; after: unknown }[];
  }[];
  errors: { index: number; activityId?: string; message: string }[];
}

/** `--clear unit-price` and `--clear unitPrice` both name unitPrice; `asset` names assetId. */
function clearField(name: string): string {
  const camel = name.trim().replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  const field = camel === "asset" ? "assetId" : camel;
  if (!CLEARABLE.includes(field)) {
    throw new UsageError(
      `Cannot clear ${name}.`,
      `--clear takes one of: ${CLEARABLE.join(", ")}. Required fields can be changed, not cleared.`,
    );
  }
  return field;
}

/** One row from an id and the field flags. */
export function rowFromFlags(id: string, opts: UpdateOptions): Record<string, unknown> {
  const row: Record<string, unknown> = { activityId: id.trim() };
  for (const [flag, field] of Object.entries(FIELD_FLAGS)) {
    const value = opts[flag as FieldFlag];
    if (value !== undefined) row[field] = value;
  }
  for (const name of opts.clear) {
    const field = clearField(name);
    if (row[field] === null) continue; // `--clear fee --clear fee`
    if (row[field] !== undefined) {
      throw new UsageError(`${field} is both set and cleared.`);
    }
    row[field] = null;
  }
  if (opts.approve) row.approve = true;
  if (Object.keys(row).length === 1) {
    throw new UsageError(
      "Name at least one field to change.",
      "For example `wf activity update <id> --fee 1.5 --dry-run`. See `wf activity update --help`.",
    );
  }
  return row;
}

/** Rows from --updates or --updates-file: an array, or { "updates": [...] }. */
export function parseUpdates(text: string, source: string): Record<string, unknown>[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${source} is not valid JSON: ${(error as Error).message}`);
  }
  const rows =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { updates?: unknown }).updates
      : value;
  if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) {
    throw new UsageError(`${source} must be an array of update objects, or { "updates": [...] }.`);
  }
  return rows as Record<string, unknown>[];
}

async function buildRows(
  id: string | undefined,
  opts: UpdateOptions,
): Promise<Record<string, unknown>[]> {
  const batch = opts.updates !== undefined || opts.updatesFile !== undefined;
  if (batch) {
    const flags = Object.keys(FIELD_FLAGS).some((f) => opts[f as FieldFlag] !== undefined);
    if (id || flags || opts.clear.length || opts.approve) {
      throw new UsageError("Give either an id with field flags, or --updates/--updates-file.");
    }
    if (opts.updates !== undefined && opts.updatesFile !== undefined) {
      throw new UsageError("Give --updates or --updates-file, not both.");
    }
  }
  let rows: Record<string, unknown>[];
  if (opts.updates !== undefined) {
    rows = parseUpdates(opts.updates, "--updates");
  } else if (opts.updatesFile !== undefined) {
    const file = opts.updatesFile;
    let text: string;
    try {
      text = file === "-" ? await readStdin() : readFileSync(file, "utf8");
    } catch (error) {
      throw new UsageError(`Cannot read ${file}: ${(error as Error).message}`);
    }
    rows = parseUpdates(text, file);
  } else if (id) {
    rows = [rowFromFlags(id, opts)];
  } else {
    throw new UsageError("Give an activity id, or --updates/--updates-file.");
  }
  if (rows.length === 0) throw new UsageError("Give at least one update.");
  if (rows.length > MAX_UPDATES) {
    throw new UsageError(`Batch limited to ${MAX_UPDATES} updates, got ${rows.length}.`);
  }
  return rows;
}

/** One line per changed field, for --table. */
function previewTable(preview: PreviewOutput) {
  const line = (activityId: string, c: FieldChange) => ({
    activityId,
    field: c.field,
    current: c.current,
    proposed: c.proposed,
  });
  return preview.rows.flatMap((row) => {
    if (row.status === "invalid") {
      return [{ activityId: row.activityId ?? "", field: "", current: "", proposed: row.error }];
    }
    return [
      ...(row.changes ?? []).map((c) => line(row.activityId ?? "", c)),
      ...(row.linkedChanges ?? []).map((c) => line(`${row.linkedActivityId} (linked)`, c)),
    ];
  });
}

function commitTable(commit: CommitOutput) {
  const line = (activityId: string, c: CommitOutput["updated"][number]["changes"][number]) => ({
    activityId,
    field: c.field,
    before: c.before,
    after: c.after,
  });
  return [
    ...commit.updated.flatMap((row) => [
      ...row.changes.map((c) => line(row.activityId, c)),
      ...(row.linkedChanges ?? []).map((c) => line(`${row.linkedActivityId} (linked)`, c)),
    ]),
    ...commit.errors.map((e) => ({
      activityId: e.activityId ?? "",
      field: "",
      before: "",
      after: e.message,
    })),
  ];
}

export function registerActivityUpdate(activity: Command): void {
  const cmd = activity
    .command("update")
    .description(
      "Correct activity fields through the server's own rules (MCP prepare/commit_activity_updates). " +
        "Name only the fields to change. Use --dry-run to preview; needs `wf agent-token create`.",
    )
    .argument("[id]", "the activity to update (or use --updates)")
    .option("--date <date>", "YYYY-MM-DD (on that day in the server's timezone) or RFC 3339")
    .option("--account <id>", "account id")
    .option("--type <type>", "activity type, for example BUY or DIVIDEND")
    .option("--subtype <subtype>", "for example DRIP, STAKING_REWARD, POSITION_OPEN")
    .option("--asset <id>", "id of an asset already stored (symbols are refused)")
    .option("--quantity <n>", "units")
    .option("--unit-price <n>", "price per unit, activity currency")
    .option("--amount <n>", "total, activity currency")
    .option("--currency <code>", "three-letter activity currency")
    .option("--fee <n>", "fee, activity currency")
    .option("--tax <n>", "tax, activity currency")
    .option("--fx-rate <n>", "activity currency to account currency rate")
    .option("--notes <text>", "notes")
    .option("--approve", "approve an activity waiting for review; a draft becomes posted")
    .option(
      "--clear <field>",
      `set an optional field to null; repeatable (${CLEARABLE.join(", ")})`,
      collect,
      [],
    )
    .option(
      "--updates <json>",
      `a batch: JSON array of rows {activityId, ...fields}, up to ${MAX_UPDATES}`,
    )
    .option("--updates-file <path>", "the batch from a file, or - for stdin")
    .option("--dry-run", "preview every change, including derived values; change nothing");
  addWaitOptions(cmd).action(async (id: string | undefined, opts: UpdateOptions, sub: Command) => {
    const rows = await buildRows(id, opts);
    const client = open(sub);
    const table = globals(sub).table;

    if (opts.dryRun) {
      const preview = await withMcp(client, (mcp) =>
        mcp.callTool<PreviewOutput>("prepare_activity_updates", { updates: rows }),
      );
      output(sub, table ? previewTable(preview) : { dryRun: true, ...preview });
      if (preview.summary.invalid > 0) process.exitCode = 1;
      return;
    }

    const { result: commit, wait } = await withWait(
      opts,
      () =>
        withMcp(client, (mcp) =>
          mcp.callTool<CommitOutput>("commit_activity_updates", { updates: rows }),
        ),
      (done) => done.updated.length > 0,
    );
    output(
      sub,
      table ? commitTable(commit) : { dryRun: false, ...commit, ...(wait ? { wait } : {}) },
    );
    if (commit.errors.length > 0) process.exitCode = 1;
  });
}
