// Curated subcommands (activity commands live in activities.ts). Each one maps flags to the payload keys that the
// vendored invoke switch reads for its command (see `wf commands`).
import { Command, Option } from "commander";
import { UsageError } from "../errors";
import { open, output } from "../context";
import { omit } from "../output";
import { addWaitOptions, withWait, type WaitOptions } from "../wait";
import {
  collect,
  dateArg,
  dayBoundary,
  decimalArg,
  intArg,
  monthArg,
  numberArg,
  today,
} from "./args";

type AccountScope =
  | { type: "all" }
  | { type: "account"; accountId: string }
  | { type: "portfolio"; portfolioId: string }
  | { type: "accounts"; accountIds: string[] };

interface AllocationTarget {
  id: string;
  name: string;
  scopeType: "all" | "portfolio" | "account";
  scopeId?: string | null;
  archivedAt?: string | null;
}

/** Account scope the web app uses for an allocation target. */
export function targetFilter(target: AllocationTarget): AccountScope {
  if (target.scopeType === "account" && target.scopeId) {
    return { type: "account", accountId: target.scopeId };
  }
  if (target.scopeType === "portfolio" && target.scopeId) {
    return { type: "portfolio", portfolioId: target.scopeId };
  }
  return { type: "all" };
}

export function registerCurated(program: Command): void {
  // The server's sync_market_data handler queues the same portfolio job that
  // update_portfolio queues, with the requested sync mode. Calling both would
  // run the job twice. Both return before the job finishes.
  const syncCmd = program
    .command("sync")
    .description("Sync market data and update the portfolio in the background (sync_market_data)")
    .option("--asset <id>", "sync only this asset; repeat for more", collect)
    .option("--refetch-all", "refetch the quote history (up to 5 years)")
    .option("--recent-days <n>", "refetch quotes for the last n days", intArg);
  addWaitOptions(syncCmd).action(
    async (
      opts: { asset?: string[]; refetchAll?: boolean; recentDays?: number } & WaitOptions,
      cmd: Command,
    ) => {
      const client = open(cmd);
      const { wait } = await withWait(opts, () =>
        client.invoke("sync_market_data", {
          // Omitted means every asset; an empty list would mean none.
          ...(opts.asset ? { assetIds: opts.asset } : {}),
          refetchAll: opts.refetchAll ?? false,
          ...(opts.recentDays === undefined ? {} : { refetchRecentDays: opts.recentDays }),
        }),
      );
      output(cmd, { queued: true, ...(wait ? { wait } : {}) });
    },
  );

  program
    .command("rebalance")
    .description(
      "Show drift against an allocation target; with --cash, also a rebalance plan " +
        "(get_allocation_target_drift, calculate_rebalance_plan)",
    )
    .option("--target <id>", "allocation target id or name (default: the only active target)")
    .option("--cash <amount>", "cash to invest; computes a rebalance plan", numberArg)
    .addOption(
      new Option("--mode <mode>", "plan scenario")
        .choices(["cash_flow_only", "sell_to_rebalance", "hybrid"])
        .default("cash_flow_only"),
    )
    .option("--asset <id>", "limit the plan to this asset; repeat for more", collect)
    .option("--holdings", "include holdings in the drift report")
    .option("--full", "keep the colours of each category, left out by default")
    .action(
      async (
        opts: {
          target?: string;
          cash?: number;
          mode: string;
          asset?: string[];
          holdings?: boolean;
          full?: boolean;
        },
        cmd: Command,
      ) => {
        const client = open(cmd);
        const targets = await client.invoke<AllocationTarget[]>("list_allocation_targets");
        const active = targets.filter((t) => !t.archivedAt);
        let target: AllocationTarget | undefined;
        if (opts.target) {
          target = targets.find((t) => t.id === opts.target || t.name === opts.target);
          if (!target)
            throw new UsageError(`No allocation target ${opts.target}.`, listTargets(active));
        } else if (active.length === 1) {
          target = active[0];
        } else {
          throw new UsageError(
            active.length === 0
              ? "No active allocation targets. Create one in the app first."
              : "Several allocation targets. Pick one with --target.",
            active.length ? listTargets(active) : undefined,
          );
        }
        const filter = targetFilter(target!);
        const drift = await client.invoke<Drift>("get_allocation_target_drift", {
          targetId: target!.id,
          filter,
          includeHoldings: opts.holdings ?? false,
        });
        const result: Record<string, unknown> = {
          target: { id: target!.id, name: target!.name },
          drift: opts.full ? drift : withoutColours(drift),
        };
        if (opts.cash !== undefined) {
          result.plan = await client.invoke("calculate_rebalance_plan", {
            targetId: target!.id,
            availableCash: opts.cash,
            filter,
            scenarioMode: opts.mode,
            // Upstream sorts and dedupes the ids before sending.
            ...(opts.asset ? { eligibleAssetIds: [...new Set(opts.asset)].sort() } : {}),
          });
        }
        output(cmd, result);
      },
    );

  const spending = program.command("spending").description("Spending reports");
  spending
    .command("report")
    .description("Spending report for a date range (get_spending_report)")
    .option(
      "--from <date>",
      "start date, YYYY-MM-DD (default: first day of the --to month, so this month)",
      dateArg,
    )
    .option("--to <date>", "end date, YYYY-MM-DD (default: today)", dateArg)
    .option("--account <id>", "only this account; repeat for more", collect)
    .option("--full", "also return the per-day totals (byDay, byDayByCategory)")
    .action(
      async (
        opts: { from?: string; to?: string; account?: string[]; full?: boolean },
        cmd: Command,
      ) => {
        const endDate = opts.to ?? today();
        // Without --from, report the month of --to; a past --to must not start after it.
        const startDate = opts.from ?? `${endDate.slice(0, 8)}01`;
        if (startDate > endDate) throw new UsageError("--from must not be after --to.");
        const client = open(cmd);
        // The server reads RFC 3339 instants, and refuses a bare date once an
        // account is tracked. As the web app: whole days in the app's timezone.
        const settings = await client.invoke<{ timezone?: string }>("get_settings");
        const request = {
          startDate: dayBoundary(startDate, "start", settings?.timezone),
          endDate: dayBoundary(endDate, "end", settings?.timezone),
          ...(opts.account ? { accountIds: opts.account } : {}),
        };
        const report = await client.invoke<Record<string, unknown>>("get_spending_report", {
          request,
        });
        if (!opts.full) {
          // One row per day and per day and category: most of a long range's size.
          delete report.byDay;
          delete report.byDayByCategory;
        }
        output(cmd, report);
      },
    );

  program
    .command("budget")
    .description("Budget snapshot for a month (get_budget)")
    .option("--period <month>", "month as YYYY-MM (default: the server's current month)", monthArg)
    .option("--full", "return the server's {state, computed}, with ids, colours and every category")
    .action(async (opts: { period?: string; full?: boolean }, cmd: Command) => {
      const budget = await open(cmd).invoke<Budget>(
        "get_budget",
        opts.period ? { periodKey: opts.period } : {},
      );
      output(cmd, opts.full || !budget?.computed ? budget : briefBudget(budget));
    });

  const altAsset = program
    .command("alt-asset")
    .description("Alternative assets (property, vehicles, ...)");
  const valueCmd = altAsset
    .command("value")
    .description("Record a new valuation (update_alternative_asset_valuation)")
    .argument("<id>", "alternative asset id")
    .argument("<amount>", "new value as a decimal number", decimalArg)
    .option("--date <date>", "valuation date, YYYY-MM-DD (default: today)", dateArg)
    .option("--notes <text>", "notes for this valuation");
  addWaitOptions(valueCmd).action(
    async (
      id: string,
      amount: string,
      opts: { date?: string; notes?: string } & WaitOptions,
      cmd: Command,
    ) => {
      const request = {
        value: amount,
        date: opts.date ?? today(),
        ...(opts.notes === undefined ? {} : { notes: opts.notes }),
      };
      const client = open(cmd);
      const { result, wait } = await withWait(opts, () =>
        client.invoke<Record<string, unknown>>("update_alternative_asset_valuation", {
          assetId: id,
          request,
        }),
      );
      output(cmd, wait ? { ...result, wait } : result);
    },
  );
}

interface Drift {
  rows?: { color?: unknown }[];
  holdings?: { rows?: { categoryColor?: unknown }[] } | null;
}

function withoutColours(drift: Drift): Drift {
  return {
    ...drift,
    rows: drift.rows?.map((row) => omit(row, "color")),
    ...(drift.holdings && {
      holdings: {
        ...drift.holdings,
        rows: drift.holdings.rows?.map((row) => omit(row, "categoryColor")),
      },
    }),
  };
}

interface BudgetCategory {
  categoryId: string;
  name: string;
  target: number;
  actual: number;
  rolloverIn: number;
  rolloverOut: number;
  remaining: number;
  overspent: boolean;
}

interface Budget {
  state: unknown;
  computed: {
    currency: string;
    periodKey: string;
    fxAsOf?: string | null;
    totals: Record<string, number>;
    groupRows: {
      group: { name: string };
      plannedTotal: number;
      buffer: number;
      actual: number;
      rolloverIn: number;
      rolloverOut: number;
      remaining: number;
      overspent: boolean;
      categories: BudgetCategory[];
    }[];
    ungroupedRows: BudgetCategory[];
    incomeRows: BudgetCategory[];
  };
}

/** Rollovers only when there are any. */
function rollover(row: { rolloverIn: number; rolloverOut: number }) {
  return row.rolloverIn || row.rolloverOut
    ? { rolloverIn: row.rolloverIn, rolloverOut: row.rolloverOut }
    : {};
}

/** Categories with no target, no spending and no rollover carry nothing. */
function briefCategories(rows: BudgetCategory[]) {
  return rows
    .filter((c) => c.target || c.actual || c.rolloverIn || c.rolloverOut)
    .map((c) => ({
      categoryId: c.categoryId,
      name: c.name,
      target: c.target,
      actual: c.actual,
      remaining: c.remaining,
      overspent: c.overspent,
      ...rollover(c),
    }));
}

/**
 * The computed side only, without ids, colours and icons. `state` repeats the
 * groups and targets that `computed` already shows, and every default category
 * is listed even when nothing is budgeted or spent in it.
 */
export function briefBudget({ computed }: Budget) {
  return {
    periodKey: computed.periodKey,
    currency: computed.currency,
    totals: computed.totals,
    groups: computed.groupRows.map((g) => ({
      name: g.group.name,
      planned: g.plannedTotal,
      ...(g.buffer ? { buffer: g.buffer } : {}),
      actual: g.actual,
      remaining: g.remaining,
      overspent: g.overspent,
      ...rollover(g),
      categories: briefCategories(g.categories),
    })),
    ungrouped: briefCategories(computed.ungroupedRows),
    income: briefCategories(computed.incomeRows),
  };
}

function listTargets(targets: AllocationTarget[]): string {
  return `Targets: ${targets.map((t) => `${t.name} (${t.id})`).join(", ")}`;
}
