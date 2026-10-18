import type { Command } from "commander";
import { intArg } from "./commands/args";
import { watchPortfolio, type WaitResult } from "./events";

export interface WaitOptions {
  wait?: boolean;
  waitTimeout: number;
}

/** Adds --wait and --wait-timeout to a command that triggers a portfolio job. */
export function addWaitOptions(cmd: Command): Command {
  return cmd
    .option("--wait", "wait until the server has recalculated the portfolio")
    .option("--wait-timeout <seconds>", "give up waiting after this many seconds", intArg, 300);
}

/**
 * Runs `write`; with --wait, also waits for the portfolio job it starts. The
 * event stream opens before the write, so the job's events cannot be missed.
 * `wait` is undefined without --wait. Sets exit code 1 on a failed or timed
 * out job; the write itself has happened either way.
 */
export async function withWait<T>(
  opts: WaitOptions,
  write: () => Promise<T>,
): Promise<{ result: T; wait?: WaitResult }> {
  if (!opts.wait) return { result: await write() };
  const watch = await watchPortfolio();
  let result: T;
  try {
    result = await write();
  } catch (error) {
    watch.close();
    throw error;
  }
  const wait = await watch.done(opts.waitTimeout * 1000);
  if (wait.status !== "complete") process.exitCode = 1;
  return { result, wait };
}
