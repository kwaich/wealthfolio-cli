// Read commands for the data the MCP read tools return. The REST responses
// already carry every field those tools add (tracking mode, provider, asset
// id, local values, FX rate, ...), so these pass them through unchanged.
import type { Command } from "commander";
import { open, output } from "../context";

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
    .action(async (opts: { account?: string; includeClosed?: boolean }, cmd: Command) => {
      const filter = opts.account ? { type: "account", accountId: opts.account } : { type: "all" };
      output(
        cmd,
        await open(cmd).invoke("get_holdings", {
          filter,
          ...(opts.includeClosed ? { includeClosed: true } : {}),
        }),
      );
    });

  program
    .command("health")
    .description("Health Center status (get_health_status); --refresh runs the checks first")
    .option("--refresh", "run the full checks first (run_health_checks)")
    .action(async (opts: { refresh?: boolean }, cmd: Command) => {
      const client = open(cmd);
      if (!opts.refresh) {
        output(cmd, await client.invoke("get_health_status"));
        return;
      }
      // As the MCP tool: check in the timezone configured in the app, not the
      // machine's. Without one, the vendored invoke sends the local timezone.
      const settings = await client.invoke<{ timezone?: string }>("get_settings");
      const timezone = settings?.timezone?.trim();
      output(
        cmd,
        await client.invoke("run_health_checks", timezone ? { clientTimezone: timezone } : {}),
      );
    });
}
