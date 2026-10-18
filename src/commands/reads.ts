// Read commands for the data the MCP read tools return. The REST responses
// already carry every field those tools add (tracking mode, provider, asset
// id, local values, FX rate, ...), so these pass them through unchanged,
// except that holdings drop their classification tree and health its
// per-entity diagnostics unless asked (--full).
import type { Command } from "commander";
import { open, output } from "../context";

interface Holding {
  metadata?: unknown;
  instrument?: { classifications?: unknown; notes?: unknown };
}

// The classification tree (sectors, regions, colours) is most of a holding's size.
function slim(holding: Holding): Holding {
  const copy = { ...holding, ...(holding.instrument && { instrument: { ...holding.instrument } }) };
  delete copy.metadata;
  delete copy.instrument?.classifications;
  delete copy.instrument?.notes;
  return copy;
}

interface Health {
  issues?: { diagnostics?: unknown }[];
}

// diagnostics repeats each issue's details and affected items, entity by entity.
function slimHealth(health: Health): Health {
  return { ...health, issues: health.issues?.map((i) => ({ ...i, diagnostics: undefined })) };
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
      "also return each instrument's classifications and notes and the holding's metadata, which are left out by default",
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
        output(cmd, opts.full ? holdings : holdings.map(slim));
      },
    );

  program
    .command("health")
    .description("Health Center status (get_health_status); --refresh runs the checks first")
    .option("--refresh", "run the full checks first (run_health_checks)")
    .option("--full", "also return each issue's diagnostics, which are left out by default")
    .action(async (opts: { refresh?: boolean; full?: boolean }, cmd: Command) => {
      const client = open(cmd);
      const show = (health: Health) => output(cmd, opts.full ? health : slimHealth(health));
      if (!opts.refresh) {
        show(await client.invoke<Health>("get_health_status"));
        return;
      }
      // As the MCP tool: check in the timezone configured in the app, not the
      // machine's. Without one, the vendored invoke sends the local timezone.
      const settings = await client.invoke<{ timezone?: string }>("get_settings");
      const timezone = settings?.timezone?.trim();
      show(
        await client.invoke<Health>(
          "run_health_checks",
          timezone ? { clientTimezone: timezone } : {},
        ),
      );
    });
}
