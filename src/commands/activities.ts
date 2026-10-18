// Activity commands. Update (activity-update.ts) runs the server's own MCP
// tools. Search, delete, void and restore follow the rules of the
// MCP tools search_activities, prepare/commit_activity_deletions and the void
// field of prepare/commit_activity_updates, over the REST commands the web app
// uses. Each write command previews with --dry-run and changes nothing then.
import { Command, Option } from "commander";
import type { Client } from "../client";
import { globals, open, output } from "../context";
import { UsageError, WfError } from "../errors";
import type { WaitResult } from "../events";
import { addWaitOptions, withWait, type WaitOptions } from "../wait";
import { registerActivityUpdate } from "./activity-update";
import { collect, dateArg, intArg } from "./args";

/** Max ids per call, as the MCP tools. */
export const MAX_BATCH = 100;

type Status = "POSTED" | "DRAFT" | "PENDING" | "VOID";

/** An activity as search_activities or the transfer pair returns it. */
interface RawActivity {
  id: string;
  accountId: string;
  activityType: string;
  activityTypeOverride?: string | null;
  subtype?: string | null;
  assetId?: string | null;
  /** search_activities */
  date?: string;
  /** Activity model (transfer pair, update response) */
  activityDate?: string;
  quantity?: string | null;
  unitPrice?: string | null;
  amount?: string | null;
  currency: string;
  fee?: string | null;
  tax?: string | null;
  fxRate?: string | null;
  /** search_activities */
  comment?: string | null;
  /** Activity model */
  notes?: string | null;
  status: Status;
  needsReview: boolean;
  sourceSystem?: string | null;
  sourceRecordId?: string | null;
  importRunId?: string | null;
}

/** The fields the MCP update tools report, in one shape for both sources. */
export interface StoredActivity {
  id: string;
  date: string;
  accountId: string;
  activityType: string;
  subtype: string | null;
  assetId: string | null;
  quantity: string | null;
  unitPrice: string | null;
  amount: string | null;
  currency: string;
  fee: string | null;
  tax: string | null;
  fxRate: string | null;
  notes: string | null;
  status: Status;
  needsReview: boolean;
  sourceSystem?: string;
}

const blank = (v: string | null | undefined) => (v && v.trim() !== "" ? v : null);

export function stored(a: RawActivity): StoredActivity {
  return {
    id: a.id,
    date: a.date ?? a.activityDate ?? "",
    accountId: a.accountId,
    // search_activities already returns the effective type; the model does not.
    activityType: blank(a.activityTypeOverride) ?? a.activityType,
    subtype: blank(a.subtype),
    assetId: blank(a.assetId),
    quantity: a.quantity ?? null,
    unitPrice: a.unitPrice ?? null,
    amount: a.amount ?? null,
    currency: a.currency,
    fee: a.fee ?? null,
    tax: a.tax ?? null,
    fxRate: a.fxRate ?? null,
    notes: blank(a.comment ?? a.notes),
    status: a.status,
    needsReview: a.needsReview,
    ...(blank(a.sourceSystem) ? { sourceSystem: a.sourceSystem! } : {}),
  };
}

/**
 * A broker sync may send this activity again: a source other than MANUAL or
 * CSV, with an import run or a source record id. Same rule as core's
 * Activity::is_broker_synced.
 */
export function isBrokerSynced(a: RawActivity): boolean {
  const source = a.sourceSystem?.trim().toUpperCase();
  const manual = source === "MANUAL" || source === "CSV";
  return !manual && (!!blank(a.importRunId) || !!blank(a.sourceRecordId));
}

export function parseIds(ids: string[]): string[] {
  const trimmed = ids.map((id) => id.trim());
  if (trimmed.length === 0) throw new UsageError("Give at least one activity id.");
  if (trimmed.length > MAX_BATCH) {
    throw new UsageError(`Batch limited to ${MAX_BATCH} activities, got ${trimmed.length}.`);
  }
  if (trimmed.some((id) => id === "")) throw new UsageError("Activity ids must not be empty.");
  return trimmed;
}

/** Reads activities by id in one search. Missing ids are absent from the map. */
export async function readActivities(
  client: Client,
  ids: string[],
): Promise<Map<string, RawActivity>> {
  const unique = [...new Set(ids)];
  const res = await client.invoke<{ data: RawActivity[] }>("search_activities", {
    page: 0,
    pageSize: unique.length,
    activityIdFilter: unique,
  });
  return new Map(res.data.map((a) => [a.id, a]));
}

/** The other leg of a linked transfer, if `id` is one leg. */
export async function linkedLeg(client: Client, id: string): Promise<RawActivity | undefined> {
  const pair = await client.invoke<{ transferOut: RawActivity; transferIn: RawActivity } | null>(
    "get_transfer_pair_for_activity",
    { activityId: id },
  );
  if (!pair) return undefined;
  return pair.transferOut.id === id ? pair.transferIn : pair.transferOut;
}

interface Row {
  index: number;
  activityId: string;
  status: string;
  activity?: StoredActivity;
  linkedActivity?: StoredActivity;
  warning?: string;
  error?: string;
  [key: string]: unknown;
}

interface Planned<T> {
  row: Row;
  ready?: T;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Plans each id on its own, so one bad id fails only its row. `covered` maps
 * each id an earlier ready row already changes (the other leg of a pair, or a
 * repeat) to that row's index.
 */
async function planRows<T>(
  client: Client,
  ids: string[],
  plan: (activity: RawActivity, linked: RawActivity | undefined) => T | string,
): Promise<Planned<T & { activity: RawActivity; linked?: RawActivity }>[]> {
  const found = await readActivities(client, ids);
  const covered = new Map<string, number>();
  const out: Planned<T & { activity: RawActivity; linked?: RawActivity }>[] = [];
  for (const [index, id] of ids.entries()) {
    const invalid = (error: string, activity?: RawActivity, linked?: RawActivity): void => {
      out.push({
        row: {
          index,
          activityId: id,
          status: "invalid",
          ...(activity ? { activity: stored(activity) } : {}),
          ...(linked ? { linkedActivity: stored(linked) } : {}),
          error,
        },
      });
    };
    if (covered.has(id)) {
      invalid(`Activity ${id} is already covered by row ${covered.get(id)}`);
      continue;
    }
    const activity = found.get(id);
    if (!activity) {
      invalid(`Activity ${id} not found`);
      continue;
    }
    let linked: RawActivity | undefined;
    try {
      linked = await linkedLeg(client, id);
    } catch (error) {
      if (error instanceof WfError && error.exitCode !== 1) throw error;
      invalid(errorText(error), activity);
      continue;
    }
    const result = plan(activity, linked);
    if (typeof result === "string") {
      invalid(result, activity, linked);
      continue;
    }
    covered.set(id, index);
    if (linked) covered.set(linked.id, index);
    out.push({
      row: {
        index,
        activityId: id,
        status: "ready",
        activity: stored(activity),
        ...(linked ? { linkedActivity: stored(linked) } : {}),
      },
      ready: { ...result, activity, linked },
    });
  }
  return out;
}

function summarize(rows: Row[], extra: Record<string, number> = {}) {
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  return {
    total: rows.length,
    ...Object.fromEntries([...new Set(rows.map((r) => r.status))].sort().map((s) => [s, count(s)])),
    ...extra,
  };
}

/** Exit 1 when any row was not done, after printing every row. */
function finish(
  cmd: Command,
  dryRun: boolean,
  rows: Row[],
  extra?: Record<string, number>,
  wait?: WaitResult,
) {
  output(cmd, { dryRun, rows, summary: summarize(rows, extra), ...(wait ? { wait } : {}) });
  const bad = rows.some((r) => r.status === "invalid" || r.status === "failed");
  if (bad) process.exitCode = 1;
}

function brokerWarning(activity: RawActivity, linked?: RawActivity): string | undefined {
  const synced = [activity, ...(linked ? [linked] : [])].filter(isBrokerSynced).map((a) => a.id);
  if (synced.length === 0) return undefined;
  return (
    `Activity ${synced.join(" and ")} came from a broker sync, which may add it back. ` +
    "To keep it out of the portfolio for good, void it with `wf activity void` instead."
  );
}

export type StatusChange = "void" | "restore";

/** New status for a void or restore, or why it is refused. Mirrors the MCP rules. */
export function planStatus(
  change: StatusChange,
  activity: Pick<RawActivity, "id" | "status">,
  linked?: Pick<RawActivity, "id" | "status">,
): Status | string {
  let next: Status;
  if (change === "void") {
    if (activity.status === "VOID") return `Activity ${activity.id} is already void`;
    if (activity.status === "DRAFT" || activity.status === "PENDING") {
      const what = activity.status === "DRAFT" ? "a draft" : "pending";
      return (
        `Activity ${activity.id} is ${what} and counts toward nothing yet; ` +
        "delete it with `wf activity delete` instead"
      );
    }
    next = "VOID";
  } else {
    if (activity.status !== "VOID") {
      return `Activity ${activity.id} is not void, so there is nothing to restore`;
    }
    next = "POSTED";
  }
  // Core copies a status change to the other leg of a linked transfer, so a
  // draft leg would be voided, then posted without approval.
  if (linked && linked.status !== activity.status) {
    return (
      `Activity ${activity.id} is one leg of a linked transfer whose other leg, activity ` +
      `${linked.id}, is ${linked.status}; void or restore it only when both legs share a status.`
    );
  }
  return next;
}

/**
 * The update_activity payload for a status change: the stored value of each
 * required field, the stored notes (core stores notes as given), and the new
 * status. Omitted amounts, asset and subtype keep their stored values.
 */
export function statusUpdate(activity: RawActivity, status: Status): Record<string, unknown> {
  const s = stored(activity);
  return {
    id: s.id,
    accountId: s.accountId,
    // The effective type, as the web app and the MCP update tool send it. For
    // a broker-synced activity the server keeps the stored base type and
    // records the type sent as the override, so both stay as they were.
    activityType: s.activityType,
    activityDate: s.date,
    currency: s.currency,
    ...(s.notes === null ? {} : { notes: s.notes }),
    status,
    // A voided activity counts toward nothing, so it leaves the review queue.
    ...(status === "VOID" ? { needsReview: false } : {}),
  };
}

const ACTIVITY_TYPES = [
  "BUY",
  "SELL",
  "DIVIDEND",
  "INTEREST",
  "DEPOSIT",
  "WITHDRAWAL",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "FEE",
  "TAX",
  "SPLIT",
  "CREDIT",
  "ADJUSTMENT",
];

export function registerActivities(program: Command): void {
  const activity = program
    .command("activity")
    .description("Search, update, delete, void and restore activities");

  activity
    .command("search")
    .description("Search activities, newest first (search_activities)")
    .option("--account <id>", "only this account; repeat for more", collect)
    .option(
      "--type <type>",
      `only this activity type; repeat for more (${ACTIVITY_TYPES.join(", ")})`,
      collect,
    )
    .option("--id <id>", "only this activity id; repeat for more", collect)
    .option("--asset <text>", "asset id or symbol contains this text")
    .option("--from <date>", "from date, YYYY-MM-DD", dateArg)
    .option("--to <date>", "to date, YYYY-MM-DD", dateArg)
    .addOption(new Option("--needs-review", "only activities waiting for review"))
    .addOption(
      new Option("--reviewed", "only activities not waiting for review").conflicts("needsReview"),
    )
    .option("--page <n>", "page, from 0", intArg, 0)
    .option("--page-size <n>", "rows per page", intArg, 50)
    .action(
      async (
        opts: {
          account?: string[];
          type?: string[];
          id?: string[];
          asset?: string;
          from?: string;
          to?: string;
          needsReview?: boolean;
          reviewed?: boolean;
          page: number;
          pageSize: number;
        },
        cmd: Command,
      ) => {
        const types = opts.type?.map((t) => t.toUpperCase());
        const unknown = types?.filter((t) => !ACTIVITY_TYPES.includes(t));
        if (unknown?.length) throw new UsageError(`Unknown activity type: ${unknown.join(", ")}`);
        if (opts.pageSize < 1) throw new UsageError("--page-size must be at least 1.");
        const review = opts.needsReview ? true : opts.reviewed ? false : undefined;
        const result = await open(cmd).invoke<{ data: unknown[] }>("search_activities", {
          page: opts.page,
          pageSize: opts.pageSize,
          ...(opts.account ? { accountIdFilter: opts.account } : {}),
          ...(types ? { activityTypeFilter: types } : {}),
          ...(opts.id ? { activityIdFilter: opts.id } : {}),
          ...(opts.asset ? { assetIdKeyword: opts.asset } : {}),
          ...(opts.from ? { dateFrom: opts.from } : {}),
          ...(opts.to ? { dateTo: opts.to } : {}),
          ...(review === undefined ? {} : { needsReviewFilter: review }),
          sort: { id: "date", desc: true },
        });
        // A table shows the rows; JSON keeps meta.totalRowCount for paging.
        output(cmd, globals(cmd).table ? result.data : result);
      },
    );

  registerActivityUpdate(activity);

  const deleteCmd = activity
    .command("delete")
    .description(
      "Delete activities; one leg of a linked transfer deletes both (delete_activity). " +
        "Use --dry-run to preview.",
    )
    .argument("<ids...>", `activity ids, up to ${MAX_BATCH}`)
    .option("--dry-run", "show what would be deleted; change nothing");
  addWaitOptions(deleteCmd).action(
    async (rawIds: string[], opts: { dryRun?: boolean } & WaitOptions, cmd: Command) => {
      const ids = parseIds(rawIds);
      const client = open(cmd);
      const planned = await planRows(client, ids, () => ({}));
      for (const { row, ready } of planned) {
        if (!ready) continue;
        const warning = brokerWarning(ready.activity, ready.linked);
        if (warning) row.warning = warning;
      }
      const commit = async () => {
        const rows: Row[] = [];
        for (const { row, ready } of planned) {
          if (!ready || opts.dryRun) {
            rows.push(row);
            continue;
          }
          try {
            await client.invoke("delete_activity", { activityId: row.activityId });
            rows.push({ ...row, status: "deleted" });
          } catch (error) {
            if (error instanceof WfError && error.exitCode !== 1) throw error;
            rows.push({ ...row, status: "failed", error: errorText(error) });
          }
        }
        return rows;
      };
      const writes = !opts.dryRun && planned.some((p) => p.ready);
      const { result: rows, wait } = await withWait(
        { ...opts, wait: opts.wait && writes },
        commit,
        (done) => done.some((r) => r.status === "deleted"),
      );
      const removed = rows
        .filter((r) => r.status === (opts.dryRun ? "ready" : "deleted"))
        .reduce((n, r) => n + (r.linkedActivity ? 2 : 1), 0);
      finish(cmd, !!opts.dryRun, rows, { activitiesDeleted: removed }, wait);
    },
  );

  for (const change of ["void", "restore"] as const) {
    const statusCmd = activity
      .command(change)
      .description(
        change === "void"
          ? "Void posted activities: they stay stored but stop counting in holdings, cash and " +
              "performance, and broker syncs keep them void (update_activity). Use --dry-run to preview."
          : "Post voided activities again (update_activity). Use --dry-run to preview.",
      )
      .argument("<ids...>", `activity ids, up to ${MAX_BATCH}`)
      .option("--dry-run", "show what would change; change nothing");
    addWaitOptions(statusCmd).action(
      async (rawIds: string[], opts: { dryRun?: boolean } & WaitOptions, cmd: Command) => {
        const ids = parseIds(rawIds);
        const client = open(cmd);
        const planned = await planRows(client, ids, (a, linked) => {
          const status = planStatus(change, a, linked);
          return status === "VOID" || status === "POSTED" ? { status: status as Status } : status;
        });
        const commit = async () => {
          const rows: Row[] = [];
          for (const { row, ready } of planned) {
            if (!ready) {
              rows.push(row);
              continue;
            }
            row.newStatus = ready.status;
            if (opts.dryRun) {
              rows.push(row);
              continue;
            }
            try {
              const updated = await client.invoke<RawActivity>("update_activity", {
                activity: statusUpdate(ready.activity, ready.status),
              });
              rows.push({ ...row, status: "updated", activity: stored(updated) });
            } catch (error) {
              if (error instanceof WfError && error.exitCode !== 1) throw error;
              rows.push({ ...row, status: "failed", error: errorText(error) });
            }
          }
          return rows;
        };
        const writes = !opts.dryRun && planned.some((p) => p.ready);
        const { result: rows, wait } = await withWait(
          { ...opts, wait: opts.wait && writes },
          commit,
          (done) => done.some((r) => r.status === "updated"),
        );
        finish(cmd, !!opts.dryRun, rows, undefined, wait);
      },
    );
  }
}
