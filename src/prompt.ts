import { UsageError } from "./errors";

/** Reads all of stdin as text. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a secret from the terminal without echo. Refuses when stdin is not a TTY. */
export async function promptSecret(label: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    throw new UsageError(
      "No password given and stdin is not a terminal.",
      "Set WF_PASSWORD, or pipe it with --password-stdin.",
    );
  }
  stderr.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (data: string) => {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") return done(new UsageError("Cancelled."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Secret from an env var, from stdin (--password-stdin), or from a prompt. */
export async function getSecret(opts: {
  envVar: string;
  fromStdin?: boolean;
  label: string;
}): Promise<string> {
  const fromEnv = process.env[opts.envVar];
  if (fromEnv) return fromEnv;
  if (opts.fromStdin) {
    const text = (await readStdin()).replace(/\r?\n$/, "");
    if (!text) throw new UsageError("--password-stdin got an empty value.");
    return text;
  }
  return promptSecret(opts.label);
}
