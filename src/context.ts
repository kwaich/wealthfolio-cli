import type { Command } from "commander";
import { Client } from "./client";
import { print } from "./output";

declare const __WF_VERSION__: string;
export const VERSION = typeof __WF_VERSION__ === "string" ? __WF_VERSION__ : "0.0.0";

export interface GlobalOptions {
  url?: string;
  table?: boolean;
}

/** Global flags merged with the subcommand's own flags. */
export function globals(cmd: Command): GlobalOptions {
  return cmd.optsWithGlobals<GlobalOptions>();
}

export function open(cmd: Command): Client {
  return Client.open({ url: globals(cmd).url });
}

export function output(cmd: Command, value: unknown): void {
  print(value, { table: globals(cmd).table });
}
