// Curated subcommands (activity commands live in activities.ts). Each one maps flags to the payload keys that the
// vendored invoke switch reads for its command (see `wf commands`).
import { Command, Option } from "commander";
import { UsageError } from "../errors";
import { open, output } from "../context";
import { addWaitOptions, withWait, type WaitOptions } from "../wait";
import { collect, dateArg, decimalArg, intArg, monthArg, numberArg, today } from "./args";

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
    .action(
      async (
        opts: {
          target?: string;
          cash?: number;
          mode: string;
          asset?: string[];
          holdings?: boolean;
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
        const drift = await client.invoke("get_allocation_target_drift", {
          targetId: target!.id,
          filter,
          includeHoldings: opts.holdings ?? false,
        });
        const result: Record<string, unknown> = {
          target: { id: target!.id, name: target!.name },
          drift,
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
    .action(async (opts: { from?: string; to?: string; account?: string[] }, cmd: Command) => {
      const endDate = opts.to ?? today();
      // Without --from, report the month of --to; a past --to must not start after it.
      const startDate = opts.from ?? `${endDate.slice(0, 8)}01`;
      if (startDate > endDate) throw new UsageError("--from must not be after --to.");
      const request = {
        startDate,
        endDate,
        ...(opts.account ? { accountIds: opts.account } : {}),
      };
      output(cmd, await open(cmd).invoke("get_spending_report", { request }));
    });

  program
    .command("budget")
    .description("Budget snapshot for a month (get_budget)")
    .option("--period <month>", "month as YYYY-MM (default: the server's current month)", monthArg)
    .action(async (opts: { period?: string }, cmd: Command) => {
      output(
        cmd,
        await open(cmd).invoke("get_budget", opts.period ? { periodKey: opts.period } : {}),
      );
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

function listTargets(targets: AllocationTarget[]): string {
  return `Targets: ${targets.map((t) => `${t.name} (${t.id})`).join(", ")}`;
}
