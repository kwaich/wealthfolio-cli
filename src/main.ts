import { CommanderError } from "commander";
import { EXIT, WfError } from "./errors";
import { buildProgram } from "./program";

export async function main(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    process.exitCode = undefined;
    await program.parseAsync(argv);
    const code = typeof process.exitCode === "number" ? process.exitCode : EXIT.ok;
    process.exitCode = undefined;
    return code;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and --version exit 0; commander already printed parse errors.
      return error.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    if (error instanceof WfError) {
      process.stderr.write(`error: ${error.message}\n`);
      if (error.hint) process.stderr.write(`hint: ${error.hint}\n`);
      return error.exitCode;
    }
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    if (process.env.WF_DEBUG && error instanceof Error) process.stderr.write(`${error.stack}\n`);
    return EXIT.server;
  }
}
