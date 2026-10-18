import type { Command } from "commander";
import { Client } from "./client";
import { pick, print } from "./output";

declare const __WF_VERSION__: string;
export const VERSION = typeof __WF_VERSION__ === "string" ? __WF_VERSION__ : "0.0.0";

interface GlobalOptions {
  url?: string;
  table?: boolean;
  fields?: string[];
}

/** Global flags merged with the subcommand's own flags. */
export function globals(cmd: Command): GlobalOptions {
  return cmd.optsWithGlobals<GlobalOptions>();
}

export function open(cmd: Command): Client {
  return Client.open({ url: globals(cmd).url });
}

/** The timezone set in the app, if any (get_settings). */
export async function appTimezone(client: Client): Promise<string | undefined> {
  const settings = await client.invoke<{ timezone?: string }>("get_settings");
  return settings?.timezone?.trim() || undefined;
}

export function output(cmd: Command, value: unknown): void {
  const { table, fields } = globals(cmd);
  print(fields ? pick(value, fields) : value, { table });
}
