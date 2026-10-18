import { readFileSync } from "node:fs";
import { Argument, Command } from "commander";
import { Client } from "./client";
import { globals, open, output, VERSION } from "./context";
import { registerActivities } from "./commands/activities";
import { registerAgentToken } from "./commands/agent-token";
import { registerCurated } from "./commands/curated";
import { registerReads } from "./commands/reads";
import { COMMANDS, UPSTREAM_TAG } from "./contract";
import { UsageError } from "./errors";
import { getSecret, readStdin } from "./prompt";
import { loadConfig, normalizeUrl, saveConfig, type Config } from "./store";
import { commandInfo, payloadHint } from "./payloads";
import { addWaitOptions, withWait, type WaitOptions } from "./wait";

/** Parses --args / --args-file / --args - into a payload object. */
async function readArgs(opts: {
  args?: string;
  argsFile?: string;
}): Promise<Record<string, unknown> | undefined> {
  if (opts.args !== undefined && opts.argsFile !== undefined) {
    throw new UsageError("Use --args or --args-file, not both.");
  }
  let text: string | undefined;
  let source = "--args";
  if (opts.argsFile !== undefined) {
    source = opts.argsFile;
    try {
      text = opts.argsFile === "-" ? await readStdin() : readFileSync(opts.argsFile, "utf8");
    } catch (error) {
      throw new UsageError(`Cannot read ${opts.argsFile}: ${(error as Error).message}`);
    }
  } else if (opts.args === "-") {
    source = "stdin";
    text = await readStdin();
  } else {
    text = opts.args;
  }
  if (text === undefined || text.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`Invalid JSON in ${source}: ${(error as Error).message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${source} must be a JSON object, for example '{"accountId":"..."}'.`);
  }
  return value as Record<string, unknown>;
}

const stripV = (v: string) => v.replace(/^v/, "");

export function buildProgram(): Command {
  const program = new Command("wf")
    .description("Command line client for a self-hosted Wealthfolio server")
    .version(VERSION)
    .option("--url <url>", "server URL (overrides WF_URL and the config file)")
    .option("--table", "print a table instead of JSON")
    // Must come before subcommands are added: they copy it at creation.
    // main() maps commander errors to exit code 2.
    .exitOverride()
    .showHelpAfterError()
    .configureHelp({ sortSubcommands: false });

  program
    .command("login")
    .description("Log in and cache the session token (with --url, also saves the server URL)")
    .option("--token <jwt>", "use an existing wf_session token instead of a password")
    .option("--password-stdin", "read the password from stdin")
    .option("--profile <id>", "profile to unlock after login; saved to the config file")
    .action(
      async (opts: { token?: string; passwordStdin?: boolean; profile?: string }, cmd: Command) => {
        // --url on login is saved, so later commands need no flag.
        const { url } = globals(cmd);
        const config = loadConfig();
        const next: Config = { ...config };
        if (url) next.url = normalizeUrl(url);
        if (opts.profile) next.profile = opts.profile;
        const client = Client.open({ url, config: next });
        if (opts.token) {
          await client.loginWithToken(opts.token);
        } else {
          const status = await client.authStatus();
          if (status.requiresPassword) {
            const password = await getSecret({
              envVar: "WF_PASSWORD",
              fromStdin: opts.passwordStdin,
              label: `Password for ${client.url}: `,
            });
            await client.login(password);
          } else if (status.oidcEnabled) {
            throw new UsageError(
              "This server uses OIDC sign-in, which wf cannot do.",
              "Sign in with a browser, copy the wf_session cookie, then run `wf login --token <jwt>`.",
            );
          } else {
            client.clear();
          }
        }
        // Saved only now, so a mistyped --url does not replace a working one.
        if (next.url !== config.url || next.profile !== config.profile) saveConfig(next);
        const state = await client.ensureProfile();
        output(cmd, {
          url: client.url,
          authenticated: true,
          profile: profileOf(state, client.profileId),
          ...(state.session
            ? {}
            : { profiles: state.profiles, hint: "Run `wf profile use <id>`." }),
        });
      },
    );

  program
    .command("logout")
    .description("End the session and delete the cached token")
    .action(async (_opts, cmd: Command) => {
      const client = open(cmd);
      await client.logout();
      output(cmd, { url: client.url, authenticated: false });
    });

  program
    .command("status")
    .description("Show server URL, login state, server version and profile")
    .action(async (_opts, cmd: Command) => {
      const client = open(cmd);
      const warnings: string[] = [];
      const result: Record<string, unknown> = {
        url: client.url,
        cli: VERSION,
        upstreamTag: UPSTREAM_TAG,
      };
      let auth;
      try {
        auth = await client.authStatus();
      } catch (error) {
        output(cmd, { ...result, reachable: false, error: (error as Error).message });
        process.exitCode = 1;
        return;
      }
      result.reachable = true;
      result.requiresPassword = auth.requiresPassword;
      result.oidcEnabled = auth.oidcEnabled;
      const authenticated = await client.isAuthenticated();
      result.authenticated = authenticated;
      if (authenticated) {
        try {
          const info = await client.invoke<{ version?: string }>("get_app_info");
          result.serverVersion = info?.version ?? null;
          if (info?.version && stripV(info.version) !== stripV(UPSTREAM_TAG)) {
            warnings.push(
              `Server version ${info.version} differs from the vendored contract ${UPSTREAM_TAG}. Some commands may fail or send the wrong shape.`,
            );
          }
        } catch (error) {
          result.serverVersion = null;
          warnings.push(`Cannot read server version: ${(error as Error).message}`);
        }
        result.profileId = client.profileId ?? null;
      } else {
        warnings.push("Not logged in. Run `wf login`.");
      }
      result.warnings = warnings;
      for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
      output(cmd, result);
    });

  const config = program.command("config").description("Show or change the config file");
  config
    .command("show", { isDefault: true })
    .description("Print the config")
    .action((_opts, cmd: Command) => output(cmd, loadConfig()));
  const keys = ["url", "profile"] as const;
  config
    .command("set")
    .description("Set a config key")
    .addArgument(new Argument("<key>", "url or profile").choices(keys))
    .argument("<value>")
    .action((key: (typeof keys)[number], value: string, _opts, cmd: Command) => {
      const next = { ...loadConfig(), [key]: key === "url" ? normalizeUrl(value) : value };
      saveConfig(next);
      output(cmd, next);
    });
  config
    .command("unset")
    .description("Remove a config key")
    .addArgument(new Argument("<key>", "url or profile").choices(keys))
    .action((key: (typeof keys)[number], _opts, cmd: Command) => {
      const next = { ...loadConfig() };
      delete next[key];
      saveConfig(next);
      output(cmd, next);
    });

  program
    .command("commands")
    .description(
      `List the commands in the vendored ${UPSTREAM_TAG} contract: names only, or with --filter their method, path and payload`,
    )
    .option("--filter <text>", "only names that contain this text, with method, path and payload")
    .action((opts: { filter?: string }, cmd: Command) => {
      // The full list is around 12k tokens, so it is names only.
      if (!opts.filter) return output(cmd, Object.keys(COMMANDS));
      const filter = opts.filter.toLowerCase();
      const rows = Object.entries(COMMANDS)
        .filter(([name]) => name.includes(filter))
        .map(([name, { method, path }]) => ({ name, method, path, payload: payloadHint(name) }));
      output(cmd, rows);
    });

  program
    .command("schema")
    .description("Payload and response types of one command, from the web app's typed callers")
    .argument("<command>", "command name, for example create_activity")
    .action((name: string, _opts, cmd: Command) => {
      const info = commandInfo(name);
      if (!info) {
        throw new UsageError(`Unknown command: ${name}`, "Run `wf commands` to list commands.");
      }
      output(cmd, info);
    });

  const callCmd = program
    .command("call")
    .description("Run any command from `wf commands` with a JSON payload")
    .argument("<command>", "command name, for example get_accounts")
    .option("--args <json>", "payload as a JSON object; - reads stdin")
    .option("--args-file <file>", "payload from a JSON file; - reads stdin");
  addWaitOptions(callCmd).action(
    async (
      command: string,
      opts: { args?: string; argsFile?: string } & WaitOptions,
      cmd: Command,
    ) => {
      const payload = await readArgs(opts);
      if (opts.wait && COMMANDS[command]?.method === "GET") {
        throw new UsageError(
          `${command} only reads, so no portfolio update follows it. Drop --wait.`,
        );
      }
      const client = open(cmd);
      const { result, wait } = await withWait(opts, () => client.invoke(command, payload));
      // With --wait the output wraps the response, so the job's outcome fits beside it.
      output(cmd, wait ? { result: result ?? null, wait } : result);
    },
  );

  const profile = program.command("profile").description("List, unlock and lock profiles");
  profile
    .command("list", { isDefault: true })
    .description("List profiles and the current one")
    .action(async (_opts, cmd: Command) => {
      const client = open(cmd);
      const state = await client.profileState();
      if (state.session) client.profileId = state.session.profileId;
      const current = state.session?.profileId;
      output(
        cmd,
        state.profiles.map((p) => ({
          id: p.id,
          name: p.name,
          lockEnabled: p.lockEnabled,
          current: p.id === current,
        })),
      );
    });
  profile
    .command("use")
    .description("Unlock a profile and use it for later commands")
    .argument("<profile>", "profile id or name")
    .option("--password-stdin", "read the profile password from stdin")
    .option("--save", "also save it as the default profile in the config file")
    .action(
      async (wanted: string, opts: { passwordStdin?: boolean; save?: boolean }, cmd: Command) => {
        const client = open(cmd);
        const state = await client.profileState();
        const target = state.profiles.find((p) => p.id === wanted || p.name === wanted);
        if (!target) {
          throw new UsageError(
            `No profile ${wanted}.`,
            `Profiles: ${state.profiles.map((p) => `${p.name} (${p.id})`).join(", ")}`,
          );
        }
        const password = target.lockEnabled
          ? await getSecret({
              envVar: "WF_PROFILE_PASSWORD",
              fromStdin: opts.passwordStdin,
              label: `Password for profile ${target.name}: `,
            })
          : undefined;
        await client.unlockProfile(target.id, password);
        if (opts.save) saveConfig({ ...loadConfig(), profile: target.id });
        output(cmd, { id: target.id, name: target.name, current: true });
      },
    );
  profile
    .command("lock")
    .description("Lock the current profile session")
    .action(async (_opts, cmd: Command) => {
      const client = open(cmd);
      await client.lockProfile();
      output(cmd, { locked: true });
    });

  registerReads(program);
  registerActivities(program);
  registerAgentToken(program);
  registerCurated(program);
  return program;
}

function profileOf(
  state: { profiles: { id: string; name: string }[] },
  profileId: string | undefined,
): { id: string; name: string } | null {
  const p = state.profiles.find((x) => x.id === profileId);
  return p ? { id: p.id, name: p.name } : null;
}
