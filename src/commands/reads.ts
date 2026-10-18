// Read commands for the data the MCP read tools return. The REST responses
// already carry every field those tools add (tracking mode, provider, asset
// id, local values, FX rate, ...). Holdings and health print a brief shape
// unless asked (--full): agents pay for every byte.
import type { Command } from "commander";
import { appTimezone, open, output } from "../context";
import { omit } from "../output";

type Money = { local: number; base: number } | null | undefined;

interface Holding {
  id: string;
  accountId: string;
  holdingType: string;
  isClosed?: boolean;
  instrument?: { id: string; symbol: string; name?: string | null } | null;
  quantity: number;
  price?: number | null;
  localCurrency: string;
  baseCurrency: string;
  fxRate?: number | null;
  marketValue?: Money;
  costBasis?: Money;
  unrealizedGain?: Money;
  totalGain?: Money;
  totalGainPct?: number | null;
  income?: Money;
  dayChangePct?: number | null;
  weight?: number;
  sourceAccountIds?: string[];
}

/** Drops null and undefined values. */
function compact(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined));
}

/**
 * One flat row per holding, money in the base currency. A full holding is
 * about 1 KB: ten local/base money pairs, lots, classifications and provider
 * fields. Price stays in the holding's own currency, as the server sends it.
 */
export function briefHolding(h: Holding): Record<string, unknown> {
  const foreign = h.localCurrency !== h.baseCurrency;
  return compact({
    id: h.id,
    accountId: h.accountId,
    holdingType: h.holdingType,
    isClosed: h.isClosed || undefined,
    assetId: h.instrument?.id,
    symbol: h.instrument?.symbol,
    name: h.instrument?.name,
    quantity: h.quantity,
    price: h.price,
    currency: h.localCurrency,
    baseCurrency: h.baseCurrency,
    fxRate: foreign ? h.fxRate : undefined,
    marketValueLocal: foreign ? h.marketValue?.local : undefined,
    marketValue: h.marketValue?.base,
    costBasis: h.costBasis?.base,
    unrealizedGain: h.unrealizedGain?.base,
    totalGain: h.totalGain?.base,
    totalGainPct: h.totalGainPct,
    income: h.income?.base || undefined,
    dayChangePct: h.dayChangePct,
    weight: h.weight,
    sourceAccountIds: h.sourceAccountIds?.length ? h.sourceAccountIds : undefined,
  });
}

interface Health {
  issues?: {
    diagnostics?: unknown;
    navigateAction?: unknown;
    params?: unknown;
    affectedItems?: { id: string; name: string; symbol?: string; route?: string }[];
  }[];
}

// diagnostics repeats each issue's details and affected items, entity by entity.
// The other fields left out are for the web app: routes, translation keys and
// params, and cache keys. fixAction stays whole: execute_health_fix needs its payload.
function slimHealth(health: Health): Health {
  return {
    ...health,
    issues: health.issues?.map((issue) => {
      const { affectedItems } = issue;
      return {
        ...omit(issue, "diagnostics", "navigateAction", "params", "code", "dataHash", "timestamp"),
        ...(affectedItems && {
          affectedItems: affectedItems.map((item) => omit(item, "route")),
        }),
      };
    }),
  };
}

export function registerReads(program: Command): void {
  program
    .command("accounts")
    .description("List accounts (get_accounts)")
    .option("--all", "include archived accounts")
    .action(async (opts: { all?: boolean }, cmd: Command) => {
      output(
        cmd,
        await open(cmd).invoke("get_accounts", opts.all ? { includeArchived: true } : {}),
      );
    });

  program
    .command("holdings")
    .description("Holdings, cash included, for one account or all of them (get_holdings)")
    .option("--account <id>", "only this account")
    .option("--include-closed", "include closed positions (with --account)")
    .option(
      "--full",
      "return every field the server sends (local values, lots, classifications, ...), not one flat row per holding",
    )
    .action(
      async (opts: { account?: string; includeClosed?: boolean; full?: boolean }, cmd: Command) => {
        const filter = opts.account
          ? { type: "account", accountId: opts.account }
          : { type: "all" };
        const holdings = await open(cmd).invoke<Holding[]>("get_holdings", {
          filter,
          ...(opts.includeClosed ? { includeClosed: true } : {}),
        });
        output(cmd, opts.full ? holdings : holdings.map(briefHolding));
      },
    );

  program
    .command("health")
    .description("Health Center status (get_health_status); --refresh runs the checks first")
    .option("--refresh", "run the full checks first (run_health_checks)")
    .option(
      "--full",
      "return every field of each issue (diagnostics, actions, routes), not only the main ones",
    )
    .action(async (opts: { refresh?: boolean; full?: boolean }, cmd: Command) => {
      const client = open(cmd);
      const show = (health: Health) => output(cmd, opts.full ? health : slimHealth(health));
      if (!opts.refresh) {
        show(await client.invoke<Health>("get_health_status"));
        return;
      }
      // As the MCP tool: check in the timezone configured in the app, not the
      // machine's. Without one, the vendored invoke sends the local timezone.
      const timezone = await appTimezone(client);
      show(
        await client.invoke<Health>(
          "run_health_checks",
          timezone ? { clientTimezone: timezone } : {},
        ),
      );
    });
}
